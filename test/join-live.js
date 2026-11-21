'use strict';

// 实机自测（修复「按房间码加入却连到自己」的回显 bug 之后）：
// 1) A 建房，B 扫描附近房间 → 列表里 A 房间必须带可达 IP（不再回显扫描方自己的 IP/0.0.0.0）
// 2) B 按房间码加入成功（回归：IP 解析改动不能破坏 发现→WS 连接 主链路）
// 3) B 用错误房间码加入 → 只弹一条富化错误（含附近房间），不允许出现 {code}/{rooms} 原始模板或重复弹窗
// 运行：node test/join-live.js
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'join-live');
const PORT_A = Number(process.env.PORT_A || 9421);
const PORT_B = Number(process.env.PORT_B || 9422);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function waitFor(cond, ms, what) {
  const started = Date.now();
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`超时：${what}`);
    await sleep(120);
  }
}

function launch(label, port, userData) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const bin = require('electron');
  const child = spawn(bin, [ROOT, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  child.on('exit', (code) => log(`${label} 退出，code=${code}`));
  return { child, label, port, userData, getLog: () => lines.join('').slice(-2000) };
}

async function tryConnect(inst) {
  let browser = null;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${inst.port}`, protocol: 'http' });
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().endsWith('renderer/index.html'));
    if (!page) {
      browser.disconnect();
      return null;
    }
    page.on('pageerror', (err) => log(`${inst.label} 渲染层报错：`, err.message));
    return { browser, page };
  } catch {
    if (browser) {
      try {
        browser.disconnect();
      } catch {}
    }
    return null;
  }
}

async function connect(inst) {
  return waitFor(() => tryConnect(inst), 40_000, `${inst.label} 主窗口未就绪（端口 ${inst.port}）`);
}

async function api(page, fn, ...args) {
  return page.evaluate(
    ({ name, a }) =>
      window.skydrop[name](...a).then((r) => (r && r.ok === false ? Promise.reject(new Error(r.error)) : r && r.data !== undefined ? r.data : r)),
    { name: fn, a: args }
  );
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-join-'));
  const dirA = path.join(work, 'A');
  fs.mkdirSync(dirA, { recursive: true });

  const instA = launch('A(房主)', PORT_A, path.join(work, 'udA'));
  const instB = launch('B(访客)', PORT_B, path.join(work, 'udB'));
  const cleanup = [];
  let failed = null;
  try {
    const a = await connect(instA);
    const b = await connect(instB);
    cleanup.push(a.browser, b.browser);

    await api(a.page, 'setSettings', { deviceName: '房主机', saveDir: dirA, autoApprove: true });
    await api(b.page, 'setSettings', { deviceName: '访客机', saveDir: path.join(work, 'B') });

    // ---- 1) A 建房，B 扫描附近房间
    await a.page.click('#createRoomBtn');
    await waitFor(() => a.page.$eval('#hostLive', (n) => !n.hidden), 15_000, 'A 未显示房间面板');
    const code = (await a.page.$eval('#roomCode', (n) => n.textContent.trim())).replace('-', '');
    log(`A 已创建房间：${code}`);

    await b.page.click('#scanBtn');
    await waitFor(
      () => b.page.$eval('#nearbyList', (n, c) => n.textContent.includes(c), code),
      15_000,
      'B 的附近列表没有出现 A 的房间'
    );
    const nearby = await b.page.$eval('#nearbyList', (n) => n.textContent);
    const ips = nearby.match(/\d{1,3}(?:\.\d{1,3}){3}/g) || [];
    log(`B 看到的附近列表：${nearby.replace(/\s+/g, ' ').trim()}`);
    if (!ips.length) throw new Error(`附近列表没有显示 IP：${nearby}`);
    if (ips.some((ip) => ip === '0.0.0.0')) throw new Error(`附近列表出现 0.0.0.0：${nearby}`);
    await b.page.screenshot({ path: path.join(OUT, '1-b-附近列表.png') });

    // ---- 2) B 按房间码加入（房主自动批准）
    await b.page.click('#codeInput');
    await b.page.type('#codeInput', code);
    await b.page.click('#joinBtn');
    await waitFor(() => b.page.$eval('#joinLive', (n) => !n.hidden), 20_000, 'B 未进入已加入状态');
    const peers = (await api(b.page, 'getState')).peers;
    if (!peers.length || peers[0].name !== '房主机') throw new Error(`B 连接的对端不对：${JSON.stringify(peers.map((p) => p.name))}`);
    log(`B 已按房间码加入并连上「房主机」（对端 IP ${peers[0].ip}）`);
    await b.page.screenshot({ path: path.join(OUT, '2-b-已加入.png') });
    await api(b.page, 'leave');
    await waitFor(async () => !(await api(b.page, 'getState')).peers.length, 10_000, 'B 未断开');
    await sleep(4000); // 等 toast 都过期，错误弹窗计数才干净

    // ---- 3) 错误房间码：只允许一条富化错误
    const before = await b.page.$eval('#toasts', (n) => n.children.length);
    await b.page.$eval('#codeInput', (n) => {
      n.value = '';
    });
    await b.page.type('#codeInput', 'ZZZZZZ');
    await b.page.click('#joinBtn');
    await sleep(6000); // 发现 3s + 自动重扫 1.2s + 富余
    const toasts = await b.page.$$eval('#toasts .toast', (nodes) => nodes.map((n) => n.textContent));
    const fresh = toasts.slice(before);
    log(`B 收到的弹窗：${JSON.stringify(fresh)}`);
    if (fresh.length !== 1) throw new Error(`错误房间码应只弹 1 条提示，实际 ${fresh.length} 条：${JSON.stringify(fresh)}`);
    if (!/附近现在开着/.test(fresh[0])) throw new Error(`错误提示缺少附近房间信息：${fresh[0]}`);
    if (!fresh[0].includes(code)) throw new Error(`错误提示没列出 A 的房间码：${fresh[0]}`);
    if (/\{(code|rooms)\}/.test(fresh[0])) throw new Error(`错误提示出现未替换的模板占位符：${fresh[0]}`);
    await b.page.screenshot({ path: path.join(OUT, '3-b-错误提示.png') });

    log('全部通过 ✅');
  } catch (err) {
    failed = err;
    log('失败 ❌：', err.message);
    log('A 日志：\n', instA.getLog());
    log('B 日志：\n', instB.getLog());
  } finally {
    for (const c of cleanup) {
      try {
        c.disconnect();
      } catch {}
    }
    for (const inst of [instA, instB]) {
      try {
        inst.child.kill('SIGTERM');
      } catch {}
    }
    await sleep(800);
    for (const inst of [instA, instB]) {
      try {
        inst.child.kill('SIGKILL');
      } catch {}
    }
    await fsp.rm(work, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
