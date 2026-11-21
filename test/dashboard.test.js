'use strict';

// 本机传输面板：路由、访问控制与快照内容的自动化用例
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { once } = require('events');

const { Hub } = require('../src/main/engine/hub');
const {
  dashboardHandler,
  startPanelServer,
  snapshot,
  isLoopbackAddress,
  isLocalHostHeader,
  PANEL_BASE_PORT,
} = require('../src/main/engine/dashboard');

const LIMITS = { version: 'test', maxPeers: 8, maxBadCodes: 8, historyKeep: 60, udpPort: 47812, tcpBasePort: 47810, tcpPortSpan: 13 };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skydrop-panel-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

/** 直接喂一个假 req 给 handler，省掉「想伪造来源地址就得真开两台机器」 */
function request(handler, { url = '/', method = 'GET', remoteAddress = '127.0.0.1', host = 'localhost:47830' } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, socket: { remoteAddress }, headers: host === null ? {} : { host } };
    let code = 0;
    const headers = {};
    const res = {
      writeHead(c, h) {
        code = c;
        Object.assign(headers, h || {});
        return this;
      },
      end(body) {
        resolve({ code, headers, body: String(body ?? '') });
      },
    };
    handler(req, res);
  });
}

test('面板地址判断：只认回环，其它一律拒绝', () => {
  for (const a of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['192.168.0.183', '10.0.0.1', '::ffff:192.168.0.1', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
});

test('面板 Host 白名单：挡住解析到 127.0.0.1 的第三方域名', () => {
  for (const h of ['localhost:47830', '127.0.0.1:47830', '[::1]:47830', 'LocalHost:80', 'localhost']) assert.equal(isLocalHostHeader(h), true, h);
  for (const h of ['evil.example.com', '127.0.0.1.evil.com', 'evil.com:47830', '', undefined]) assert.equal(isLocalHostHeader(h), false, String(h));
});

test('面板路由：本机拿到页面与数据，局域网来源仍是原来的 404', async () => {
  const hub = new Hub({ deviceName: '面板测试', saveDir: path.join(TMP, 'in') });
  const handler = dashboardHandler(hub, LIMITS);

  const page = await request(handler, { url: '/' });
  assert.equal(page.code, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /<div class="wrap">/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);

  for (const [url, re] of [
    ['/index.html', /<title>/],
    ['/panel.js', /window\.I18N/],
    ['/i18n.js', /zh-CN/],
  ]) {
    const r = await request(handler, { url });
    assert.equal(r.code, 200, url);
    assert.match(r.body, re, url);
  }

  const api = await request(handler, { url: '/api/state', host: '127.0.0.1:47830' });
  assert.equal(api.code, 200);
  assert.equal(api.headers['cache-control'], 'no-store');
  const body = JSON.parse(api.body);
  assert.equal(body.ok, true);
  assert.equal(body.self.name, '面板测试');
  assert.equal(body.limits.chunkSize, 256 * 1024);
  assert.equal(body.limits.maxPeers, 8);

  // IPv6 回环同样放行
  assert.equal((await request(handler, { remoteAddress: '::1', host: '[::1]:47830' })).code, 200);

  // 局域网里的设备：看不到面板，也看不到任何内容，和加面板之前完全一致
  for (const remote of ['192.168.0.183', '10.0.0.9', '::ffff:172.16.5.5']) {
    const r = await request(handler, { remoteAddress: remote });
    assert.equal(r.code, 404, remote);
    assert.equal(r.body, 'SkyDrop', remote);
  }
  // 本机来源但 Host 被改写（DNS 重绑定）同样拒绝
  const rebound = await request(handler, { url: '/api/state', host: 'attacker.example.com' });
  assert.equal(rebound.code, 404);
  assert.equal(rebound.body, 'SkyDrop');
  // 缺 Host 头（HTTP/1.0 或恶意客户端）
  assert.equal((await request(handler, { host: null })).body, 'SkyDrop');
  // 非 GET 不给数据
  assert.equal((await request(handler, { method: 'POST', url: '/api/state' })).code, 404);
  // 路径穿越与未知路径
  for (const url of ['/..%2f..%2fpackage.json', '/../../package.json', '/api', '/panel.js.map']) {
    const r = await request(handler, { url });
    assert.equal(r.code, 404, url);
    assert.doesNotMatch(r.body, /"name": "skydrop"/, url);
  }
  hub.dispose();
});

test('面板快照：房间、任务、历史与统计对得上', async () => {
  const host = new Hub({ deviceName: '面板主机', saveDir: path.join(TMP, 'host'), autoApprove: true });
  const guest = new Hub({ deviceName: '面板访客', saveDir: path.join(TMP, 'guest') });
  const room = await host.startRoom();
  await guest.joinDirect(`127.0.0.1:${room.port}`, room.code);

  const src = path.join(TMP, 'payload.bin');
  await fsp.writeFile(src, Buffer.alloc(700 * 1024, 7));
  const done = new Promise((res) => host.on('event', (e) => e.type === 'offer-done' && res(e)));
  const offerWait = new Promise((res) => host.on('event', (e) => e.type === 'offer-in' && res(e.offer)));
  await guest.send({ paths: [src] });
  host.respondOffer((await offerWait).id, true);
  assert.equal((await done).ok, true, '传输本身要成功，否则统计无从谈起');

  await new Promise((r) => setTimeout(r, 50));
  const snap = snapshot(host, LIMITS);
  assert.equal(snap.room.code, room.code);
  assert.equal(snap.room.codeDisplay.length, 7, '房间码展示格式带横杠');
  assert.equal(snap.totals.recvBytes, 700 * 1024);
  assert.equal(snap.totals.ok, 1);
  assert.equal(snap.totals.failed, 0);
  assert.equal(snap.history.length, 1);
  assert.equal(snap.history[0].files[0].name, 'payload.bin');
  assert.equal(snap.settings.saveDir, host.saveDir);
  assert.equal(snap.app.version, 'test');
  assert.equal(snap.panel, null, '没起常驻服务时面板字段为空');
  assert.ok(snap.limits.relaySlots >= 1 && snap.limits.proto === 1);
  // 这几个常量曾经因为 relay.js 没导出而显示成 0 / 空
  assert.equal(snap.limits.relayPingMs, 25_000, '中继心跳要能传给面板');
  assert.equal(snap.limits.pairTimeoutMs, 20_000, '配对超时要能传给面板');
  assert.equal(Array.isArray(snap.limits.relayBackoff) && snap.limits.relayBackoff.length, 5, '重连退避表要完整');
  host.peakRate = 5 * 1024 * 1024;
  assert.equal(
    snapshot(host, LIMITS).totals.peakRate,
    5 * 1024 * 1024,
    '任务结束、offers 清空后峰值速率仍要报得出来'
  );
  assert.ok(JSON.stringify(snap).length > 400, '快照不该是空壳');

  // 文本传送也要进快照，面板才能展示
  const textWait = new Promise((res) => host.on('event', (e) => e.type === 'text-in' && res(e)));
  await guest.sendText({ text: '面板里也能看到这段文本' });
  assert.equal((await textWait).text.text, '面板里也能看到这段文本');
  const snap2 = snapshot(host, LIMITS);
  assert.equal(snap2.texts[0].text, '面板里也能看到这段文本');
  assert.equal(snap2.texts[0].dir, 'in');
  assert.equal(snap2.texts[0].peerName, '面板访客');
  assert.equal(snap2.limits.textMaxBytes, 32 * 1024, '文本上限要传给面板');
  assert.ok(JSON.stringify(snap2).length > 400);

  // 序列化必须干净：Peer/Hub 实例混进去的话 JSON.stringify 会直接抛
  assert.doesNotThrow(() => JSON.stringify(snapshot(guest, LIMITS)));
  assert.equal(snapshot(guest, LIMITS).joined.room, room.code);

  host.dispose();
  guest.dispose();
});

test('面板常驻服务：只绑 127.0.0.1，端口被占就顺延', async () => {
  const hub = new Hub({ deviceName: '常驻面板', saveDir: path.join(TMP, 'panel') });
  const panel = await hub.startPanel();
  assert.ok(panel && panel.port >= PANEL_BASE_PORT, '应拿到一个顺延后的端口');
  assert.equal(panel.url, `http://localhost:${panel.port}/`);
  assert.deepEqual(hub.state().panel, { port: panel.port, url: panel.url });
  assert.equal(await hub.startPanel(), panel, '重复调用要返回同一个服务');

  // 真实 HTTP 往返（不经过假 req）
  const res = await fetch(`${panel.url}api/state`, { headers: { host: `localhost:${panel.port}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).self.name, '常驻面板');

  const page = await fetch(panel.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="app"/);

  // 房间端口上的同一个页面
  const room = await hub.startRoom();
  const viaRoom = await fetch(`http://127.0.0.1:${room.port}/`);
  assert.equal(viaRoom.status, 200);
  assert.match(await viaRoom.text(), /SkyDrop/);

  hub.dispose();
  await new Promise((r) => setTimeout(r, 120));
  // dispose 之后面板端口应当释放
  await assert.rejects(fetch(`${panel.url}api/state`), '面板服务应随 dispose 关闭');
});

test('多语言：面板里的数值文案必须走词典，不许拼中文字面量', () => {
  const I18N = require('../src/common/i18n');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'engine', 'panel.js'), 'utf8');
  const leaked = [];
  for (const m of src.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
    // 模板字面量里去掉 ${…} 之后还带中文，说明中文被拼进了字符串，切语言时翻不出来
    const statics = m[0].replace(/\$\{[^{}]*\}/g, '|').split('|').filter((s) => /[\u4e00-\u9fff]/.test(s));
    for (const s of statics) leaked.push(s.trim());
  }
  assert.deepEqual(leaked, [], `panel.js 里这些片段把中文写死了：\n${leaked.join('\n')}`);

  // 面板用到的带参数键与方向、文件状态词，四种语言都要有译文
  const keys = ['{n} 秒', '{n} 分 {s} 秒', '{n} 小时 {m} 分', '{n} 字节', '{n} 位 · 字符集 {m}', '{n} 次/来源', '{n} 条', '{n} 起顺延（仅 127.0.0.1）', '传入', '传出', '排队中', '接收中', '发送中', '完成', '出错', '传送的文本', '文本', '已复制', '复制失败', '单条文本上限', '还没有传送过的文本。'];
  const missing = [];
  for (const key of keys) {
    for (const code of ['zh-TW', 'en', 'ja', 'ko']) {
      const out = I18N.t(key, { n: 12, s: 3, m: 34 }, code);
      if (!String(out).trim()) missing.push(`${code} 译成空串：${key}`);
      else if (code !== 'zh-CN' && out === key && code !== 'zh-TW') missing.push(`${code} 缺译文：${key}`);
      else if (/\{[a-z]\}/.test(String(out))) missing.push(`${code} 占位符没替换：${key} → ${out}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
  assert.equal(I18N.t('{n} 字节', { n: 12 }, 'en'), '12 bytes');
  assert.equal(I18N.t('传入', null, 'en'), 'In', '方向列不能是 Accept 这种动词');
});
