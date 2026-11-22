'use strict';

// 吞吐量测量（手动运行：node test/throughput.js [文件大小 MB] [--relay] [--no-e2ee]）
// --relay 走本地中继（同机两跳），用来量化中继本身多花的钱。
// --no-e2ee 关掉端到端加密，用来量出加密这一层多花的钱（默认开启）。
// 不进入 npm test，避免 CI 因磁盘 IO 波动误报。
const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { Hub } = require('../src/main/engine/hub');

const MB = Number((process.argv.slice(2).find((a) => !a.startsWith('--'))) || 64);
const useRelay = process.argv.includes('--relay');
const withE2EE = !process.argv.includes('--no-e2ee');

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-speed-'));
  const src = path.join(dir, 'bench.bin');
  const chunk = crypto.randomBytes(4 * 1024 * 1024);
  const fh = await fsp.open(src, 'w');
  for (let i = 0; i < Math.max(1, MB / 4); i += 1) await fh.write(chunk, 0, chunk.length, i * chunk.length);
  await fh.close();

  let relaySrv = null;
  if (useRelay) {
    relaySrv = await (await import('../relay/node-server.js')).createRelayServer({ port: 0, host: '127.0.0.1' });
  }
  const relayOpts = useRelay
    ? { relayEnabled: true, relayProvider: 'custom', relayUrl: relaySrv.origin }
    : {};

  const host = new Hub({ deviceName: '测速主机', saveDir: path.join(dir, 'in'), autoApprove: true, e2ee: withE2EE, ...relayOpts });
  const guest = new Hub({ deviceName: '测速访客', saveDir: path.join(dir, 'out'), e2ee: withE2EE, ...relayOpts });
  const room = await host.startRoom();
  if (useRelay) {
    for (let i = 0; i < 150 && host.state().relay.endpoints < 3; i += 1) await wait(100);
    console.log(`中继已就绪：${relaySrv.origin}（房主槽位 ${host.state().relay.endpoints}）`);
    await guest.joinRelay(room.code);
  } else {
    await guest.joinDirect(`127.0.0.1:${room.port}`, room.code);
  }

  let startedAt = 0;
  let lastLog = 0;
  // 速率数字要能说清是哪条通道跑出来的：先等加密握手落地，把两侧的连接状态打出来
  const secOf = (hub) => {
    const st = hub.state();
    return (st.joined && st.joined.sec) || (st.peers[0] && st.peers[0].sec) || null;
  };
  for (let i = 0; i < 50 && !(secOf(host) || {}).active && !((secOf(host) || {}).reason); i += 1) await wait(100);
  const secA = secOf(host);
  const secB = secOf(guest);
  const secText = (s) => (s && s.active ? `已加密（指纹 ${s.fingerprint}）` : `未加密（${(s && s.reason) || '未知'}）`);
  console.log(`通道：${useRelay ? '本机中继（两跳）' : '本机回环直连'}｜加密开关 ${withE2EE ? '开' : '关'}｜接收方 ${secText(secA)}｜发送方 ${secText(secB)}`);
  if (secA && secB && secA.fingerprint !== secB.fingerprint) throw new Error('两侧指纹不一致');
  const offerWait = new Promise((res) => host.on('event', (e) => e.type === 'offer-in' && res(e.offer)));
  const doneWait = new Promise((res) => {
    host.on('event', (e) => {
      if (e.type === 'offer-start') startedAt = Date.now();
      if (e.type === 'offer-progress' && Date.now() - lastLog > 2000) {
        lastLog = Date.now();
        console.log(`  已接收 ${(e.offer.bytes / 1048576).toFixed(1)} MB / ${(e.offer.totalSize / 1048576).toFixed(1)} MB`);
      }
      if (e.type === 'offer-done') res({ ok: e.ok, ms: Date.now() - startedAt });
    });
  });

  await guest.send({ paths: [src] });
  const offer = await offerWait;
  host.respondOffer(offer.id, true);
  const result = await doneWait;
  console.log(`\n${result.ok ? '传输成功' : '传输失败'}：${MB} MB 用时 ${(result.ms / 1000).toFixed(2)} 秒`);
  console.log(`平均速率 ≈ ${(offer.totalSize / 1048576 / (result.ms / 1000)).toFixed(1)} MB/s（${useRelay ? '本机中继，多两跳' : '本机回环'}，实际 Wi-Fi 会低一些）`);

  host.dispose();
  guest.dispose();
  if (relaySrv) await relaySrv.close();
  await fsp.rm(dir, { recursive: true, force: true });
  process.exit(0);
})();
