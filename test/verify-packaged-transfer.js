'use strict';

// 打包件实测：A = dmg 里的 .app（房主/接收方），B = 源码实例（发送方）
// 目的：证明 asar 打包后的产物真的能建房、配对、收文件——局域网和中继两条路都走一遍。
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'packaged');
const PACKAGED_BIN = '/tmp/skydrop-app/隔空传.app/Contents/MacOS/隔空传';
const PORT_A = 9421;
const PORT_B = 9422;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(120);
  }
}

function launch(label, bin, args, port) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(bin, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  return { child, label, port, getLog: () => lines.join('').slice(-1500) };
}

async function connect(inst) {
  return waitFor(async () => {
    try {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${inst.port}`, protocol: 'http' });
      const page = (await browser.pages()).find((p) => p.url().endsWith('renderer/index.html'));
      if (!page) { browser.disconnect(); return null; }
      return { browser, page };
    } catch { return null; }
  }, 60_000, `${inst.label} 窗口未就绪`);
}

async function api(page, fn, ...args) {
  return page.evaluate(
    ({ name, a }) => window.skydrop[name](...a).then((r) => (r && r.ok === false ? Promise.reject(new Error(r.error)) : r && r.data !== undefined ? r.data : r)),
    { name: fn, a: args }
  );
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-pack-'));
  const dirA = path.join(work, 'recvA');
  const srcB = path.join(work, 'srcB');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });

  const blob = crypto.randomBytes(8 * 1024 * 1024);
  await fsp.writeFile(path.join(srcB, '打包验证 (最终).bin'), blob);
  await fsp.writeFile(path.join(srcB, '回执.txt'), 'packaged build ok\n');
  await fsp.mkdir(path.join(srcB, '子目录'), { recursive: true });
  await fsp.writeFile(path.join(srcB, '子目录', '内层.log'), 'inner');

  const instA = launch('A(打包.app)', PACKAGED_BIN, [`--remote-debugging-port=${PORT_A}`, `--user-data-dir=${path.join(work, 'udA')}`], PORT_A);
  const instB = launch('B(源码)', require(ROOT + '/node_modules/electron'), [ROOT, `--remote-debugging-port=${PORT_B}`, `--user-data-dir=${path.join(work, 'udB')}`], PORT_B);
  let failed = null;
  let relaySrv = null; // 跨网段阶段临时起的本地中继
  const cleanup = [];
  try {
    const a = await connect(instA);
    const b = await connect(instB);
    cleanup.push(a.browser, b.browser);

    await api(a.page, 'setSettings', { deviceName: '打包版 Mac', saveDir: dirA });
    await api(b.page, 'setSettings', { deviceName: '源码版 Mac', saveDir: path.join(work, 'recvB') });

    await a.page.click('#createRoomBtn');
    await waitFor(() => a.page.$eval('#hostLive', (n) => !n.hidden), 20_000, 'A 未显示房间面板');
    const code = await a.page.$eval('#roomCode', (n) => n.textContent.trim());
    log(`A(打包版) 房间码：${code}`);

    await b.page.click('#codeInput');
    await b.page.type('#codeInput', code.replace('-', ''));
    await b.page.click('#joinBtn');
    await waitFor(() => a.page.$('.req .accept'), 25_000, 'A 未出现加入请求');
    await a.page.click('.req .accept');
    await waitFor(() => b.page.$eval('#joinLive', (n) => !n.hidden), 25_000, 'B 未进入已加入状态');
    log('打包版与源码版已配对');

    // 词典是否真的进了 asar：在打包版里切到英文，断言界面文案变成译文，再切回中文。
    await api(a.page, 'setSettings', { language: 'en' });
    await waitFor(() => a.page.$eval('#closeRoomBtn', (n) => n.textContent.trim() === 'Close room'), 15_000, 'A(打包版) 未切到英文');
    const enTitle = await a.page.evaluate(() => document.title);
    if (enTitle !== 'SkyDrop') throw new Error(`打包版英文标题异常：${enTitle}`);
    await a.page.screenshot({ path: path.join(OUT, '3-打包版英文界面.png') });
    log('打包版界面已切到英文（词典随 asar 一起打包）');
    await api(a.page, 'setSettings', { language: 'zh-CN' });
    await waitFor(() => a.page.$eval('#closeRoomBtn', (n) => n.textContent.trim() === '关闭房间'), 15_000, 'A(打包版) 未切回中文');

    const st = await api(b.page, 'getState');
    await api(b.page, 'send', [st.peers[0].deviceId], [
      path.join(srcB, '打包验证 (最终).bin'),
      path.join(srcB, '回执.txt'),
      path.join(srcB, '子目录'),
    ]);
    await waitFor(() => a.page.$('.req .accept'), 25_000, 'A 未出现接收请求');
    await a.page.screenshot({ path: path.join(OUT, '4-打包版接收确认.png') });
    await a.page.click('.req .accept');
    await waitFor(async () => (await api(a.page, 'getState')).history.some((h) => h.dir === 'in' && h.state === 'done'), 45_000, 'A 未完成接收');
    await sleep(500);
    await a.page.screenshot({ path: path.join(OUT, '5-打包版接收完成.png') });

    const got = await fsp.readFile(path.join(dirA, '打包验证 (最终).bin'));
    if (crypto.createHash('sha256').update(got).digest('hex') !== crypto.createHash('sha256').update(blob).digest('hex')) throw new Error('打包版收到的二进制内容不一致');
    if (String(await fsp.readFile(path.join(dirA, '回执.txt'))) !== 'packaged build ok\n') throw new Error('打包版收到的文本不一致');
    if (String(await fsp.readFile(path.join(dirA, '子目录', '内层.log'))) !== 'inner') throw new Error('打包版收到的目录内容不一致');
    log('打包版实测：8MB 二进制 + 文本 + 目录 全部落盘且校验一致 ✅');

    // ---- 跨网段：打包版做房主挂中继槽位，源码版经中继加入并回传文件
    relaySrv = await (await import(path.join(ROOT, 'relay/node-server.js'))).createRelayServer({ port: 0, host: '127.0.0.1' });
    const relayUrl = relaySrv.origin;
    log(`本地中继已启动：${relayUrl}`);

    await api(b.page, 'leave');
    await waitFor(() => a.page.$$eval('.peer', (n) => n.length === 0), 20_000, 'B 未离开局域网这条连接');

    for (const inst of [a, b]) {
      await inst.page.click('#setRelayEnabled');
      await waitFor(() => inst.page.$eval('#relayBody', (n) => !n.hidden), 15_000, '中继配置区没有展开');
      await inst.page.select('#setRelayProvider', 'custom');
      await inst.page.click('#setRelayUrl');
      await inst.page.type('#setRelayUrl', relayUrl);
      await inst.page.keyboard.press('Enter');
    }
    await waitFor(async () => (await api(a.page, 'getState')).settings.relayUrl === relayUrl, 15_000, 'A 的中继地址没有保存');

    await a.page.click('#relayTestBtn');
    await waitFor(async () => (await api(a.page, 'getState')).relay.status === 'ready', 25_000, '打包版的中继槽位没有就绪');
    log('打包版「测试连接」通过，房间槽位已挂上中继');

    // 输入框里还留着上一轮的房间码，先清空再输，否则会被 7 字符上限截成一串废码
    await b.page.evaluate(() => {
      const input = document.getElementById('codeInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await b.page.click('#codeInput');
    await b.page.type('#codeInput', code.replace('-', ''));
    await b.page.click('#joinRelayBtn');
    await waitFor(() => a.page.$('.req .accept'), 30_000, 'A 没有收到经中继的加入请求');
    const reqText = await a.page.$eval('.req p', (n) => n.textContent);
    if (!/中继|relay/i.test(reqText)) throw new Error(`加入请求里没有出现中继来源：${reqText}`);
    await a.page.click('.req .accept');
    await waitFor(() => b.page.$eval('#joinLive', (n) => !n.hidden), 30_000, 'B 未经中继加入成功');
    await waitFor(() => a.page.$$eval('.peer .via', (n) => n.length > 0), 25_000, 'A 侧没有出现「互联网中继」标记');
    const viaBadge = await a.page.$eval('.peer .via', (n) => n.textContent.trim());
    log(`经中继连通：A 侧设备来源标记「${viaBadge}」`);

    const cross = crypto.randomBytes(2 * 1024 * 1024);
    const crossPath = path.join(srcB, '跨网文件.bin');
    await fsp.writeFile(crossPath, cross);
    const relayPeer = (await api(b.page, 'getState')).peers.find((p) => p.via === 'relay');
    if (!relayPeer) throw new Error('B 侧设备没有标记 via=relay');
    await api(b.page, 'send', [relayPeer.deviceId], [crossPath]);
    await waitFor(() => a.page.$('.req .accept'), 30_000, 'A 没有出现中继传输的接收请求');
    await a.page.click('.req .accept');
    const landed = path.join(dirA, '跨网文件.bin');
    await waitFor(() => fs.existsSync(landed), 60_000, 'A 未收到经中继传来的文件');
    const gotCross = await fsp.readFile(landed);
    if (crypto.createHash('sha256').update(gotCross).digest('hex') !== crypto.createHash('sha256').update(cross).digest('hex')) {
      throw new Error('打包版经中继收到的文件内容不一致');
    }
    log(`打包版经中继传输 2MB 完成，sha256 一致（${gotCross.length} 字节）✅`);
    await a.page.screenshot({ path: path.join(OUT, '6-打包版经中继完成.png') });

    // 关房间：槽位要立刻从中继上摘掉，不能留孤儿连接
    await a.page.click('#closeRoomBtn');
    await waitFor(() => relaySrv.stats().waiting === 0, 25_000, '关闭房间后中继侧残留等待槽');
    log(`关闭房间后中继已摘干净：${JSON.stringify(relaySrv.stats())}`);
  } catch (err) {
    failed = err;
    log('失败 ❌：', err.message);
    log('A 日志：\n', instA.getLog());
    log('B 日志：\n', instB.getLog());
  } finally {
    if (relaySrv) { try { await relaySrv.close(); } catch {} }
    for (const br of cleanup) { try { br.disconnect(); } catch {} }
    for (const inst of [instA, instB]) { try { inst.child.kill('SIGTERM'); } catch {} }
    await sleep(900);
    for (const inst of [instA, instB]) { try { inst.child.kill('SIGKILL'); } catch {} }
    await fsp.rm(work, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
