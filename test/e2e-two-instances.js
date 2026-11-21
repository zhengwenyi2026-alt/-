'use strict';

// 双实例端到端验证：启动两个隔空传窗口，完全通过界面操作完成
// 「创建房间 → 输入房间码 → 房主允许 → 双向传文件」，再挂一个本地中继
// 走完「跨网传输：填地址 → 测试 → 经中继加入 → 传文件」，截图存到 out/e2e/。
// 运行：npm run e2e
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e');
const PORT_A = Number(process.env.PORT_A || 9411);
const PORT_B = Number(process.env.PORT_B || 9412);

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
  delete env.ELECTRON_RUN_AS_NODE; // 继承自父进程时会让 require('electron') 失效
  // 直接 spawn Electron 可执行文件（而不是 npm 的 shell 包装脚本），这样 kill 能真正结束进程
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
    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`${inst.label} console.error：`, msg.text());
    });
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
  const conn = await waitFor(() => tryConnect(inst), 40_000, `${inst.label} 主窗口未就绪（端口 ${inst.port}）`);
  return conn;
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
  // 本地起一个真中继：跨网这一段的界面、引擎、配对状态机全都是真的
  const { createRelayServer } = await import('../relay/node-server.js');
  const relaySrv = await createRelayServer({ port: 0, host: '127.0.0.1' });
  const relayUrl = relaySrv.origin;
  log(`本地中继已启动：${relayUrl}`);
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-e2e-'));
  const dirA = path.join(work, 'A');
  const dirB = path.join(work, 'B');
  const srcA = path.join(work, 'srcA');
  const srcB = path.join(work, 'srcB');
  for (const d of [dirA, dirB, srcA, srcB]) fs.mkdirSync(d, { recursive: true });

  // 构造待传文件：一个 6MB 随机文件 + 一个含中文与空格的文本 + 一个文件夹
  const big = crypto.randomBytes(6 * 1024 * 1024);
  await fsp.writeFile(path.join(srcA, '发布包 v2 (最终).zip'), big);
  await fsp.writeFile(path.join(srcA, '说明.txt'), '隔空传 E2E 文本\n');
  await fsp.mkdir(path.join(srcA, '素材', '图标'), { recursive: true });
  await fsp.writeFile(path.join(srcA, '素材', '图标', 'a.svg'), '<svg/>');
  await fsp.writeFile(path.join(srcA, '素材', '.DS_Store'), 'ignored');
  const note = '从 B 发出的回传内容'.repeat(40);
  await fsp.writeFile(path.join(srcB, '回传笔记.md'), note);

  const instA = launch('A(房主)', PORT_A, path.join(work, 'udA'));
  const instB = launch('B(访客)', PORT_B, path.join(work, 'udB'));
  const cleanup = [];
  let failed = null;
  try {
    const a = await connect(instA);
    const b = await connect(instB);
    cleanup.push(a.browser, b.browser);

    await api(a.page, 'setSettings', { deviceName: '阿布的 Mac', saveDir: dirA, autoAccept: false, autoApprove: false });
    await api(b.page, 'setSettings', { deviceName: '小白的 Mac', saveDir: dirB });

    // ---- A 建房：点按钮，读界面上的房间码
    await a.page.click('#createRoomBtn');
    await waitFor(() => a.page.$eval('#hostLive', (n) => !n.hidden), 15_000, 'A 未显示房间面板');
    const code = await a.page.$eval('#roomCode', (n) => n.textContent.trim());
    if (!/^[A-Z2-9]{3}-?[A-Z2-9]{3}$/.test(code)) throw new Error(`房间码格式异常：${code}`);
    log(`A 已创建房间：${code}`);
    await a.page.screenshot({ path: path.join(OUT, '1-a-房间已创建.png') });

    // ---- B 输入房间码并点加入（走局域网 UDP 自动发现）
    await b.page.click('#codeInput');
    await b.page.type('#codeInput', code.replace('-', ''));
    const typed = await b.page.$eval('#codeInput', (n) => n.value);
    log(`B 输入的房间码：${typed}`);
    await b.page.click('#joinBtn');

    // ---- A 界面出现「想加入房间」请求，点允许
    await waitFor(() => a.page.$('.req .accept'), 20_000, 'A 没有出现加入请求');
    await a.page.screenshot({ path: path.join(OUT, '2-a-收到加入请求.png') });
    await a.page.click('.req .accept');

    await waitFor(() => b.page.$eval('#joinLive', (n) => !n.hidden), 20_000, 'B 未进入已加入状态');
    await waitFor(() => a.page.$$eval('.peer', (n) => n.length > 0), 20_000, 'A 未显示已连接设备');
    log('两台设备已互相连接');
    await b.page.screenshot({ path: path.join(OUT, '3-b-已加入房间.png') });

    // ---- B 通过界面发送：先模拟拖拽（合成 File 无路径，应给出提示），再用真实路径发起
    await b.page.evaluate(async (names) => {
      const dt = new DataTransfer();
      for (const n of names) dt.items.add(new File(['x'], n, { type: 'text/plain' }));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
    }, ['拖拽测试.txt']);
    await sleep(400);
    const warn = await b.page.$eval('#toasts', (n) => n.textContent);
    if (!/浏览选择/.test(warn)) throw new Error(`拖拽处理未生效，当前提示：${warn}`);
    log('拖拽事件已被界面接收（合成文件无真实路径，按预期提示改用浏览选择）');

    const peersB = await api(b.page, 'getState');
    const targetId = peersB.peers[0].deviceId;
    const sendRes = await api(b.page, 'send', [targetId], [
      path.join(srcA, '发布包 v2 (最终).zip'),
      path.join(srcA, '说明.txt'),
      path.join(srcA, '素材'),
    ]);
    log(`B 已发起传送：${sendRes.count} 个文件，${sendRes.bytes} 字节`);
    // A 侧弹出接收请求，点接收
    await a.page.bringToFront();
    await waitFor(() => a.page.$('.req .accept'), 20_000, 'A 没有出现接收请求');
    await a.page.screenshot({ path: path.join(OUT, '4-a-接收确认.png') });
    await a.page.click('.req .accept');

    await waitFor(
      async () => {
        const st = await api(a.page, 'getState');
        return st.history.some((h) => h.dir === 'in' && h.state === 'done');
      },
      40_000,
      'A 未完成接收'
    );
    await sleep(600);
    await a.page.screenshot({ path: path.join(OUT, '5-a-接收完成.png') });

    // 校验落盘内容与目录结构
    const receivedZip = path.join(dirA, '发布包 v2 (最终).zip');
    const receivedTxt = path.join(dirA, '说明.txt');
    const receivedSvg = path.join(dirA, '素材', '图标', 'a.svg');
    const zipBuf = await fsp.readFile(receivedZip);
    if (crypto.createHash('sha256').update(zipBuf).digest('hex') !== crypto.createHash('sha256').update(big).digest('hex')) {
      throw new Error('A 收到的 zip 内容不一致');
    }
    if (String(await fsp.readFile(receivedTxt)) !== '隔空传 E2E 文本\n') throw new Error('A 收到的文本不一致');
    if (String(await fsp.readFile(receivedSvg)) !== '<svg/>') throw new Error('A 收到的目录内文件不一致');
    const junk = await fsp.readdir(path.join(dirA, '素材'));
    if (junk.includes('.DS_Store')) throw new Error('系统垃圾文件 .DS_Store 不应被传输');
    log('A 收到 3 项（含目录结构）且内容一致');

    // ---- 反向：A 发给 B
    const peersA = await api(a.page, 'getState');
    const bId = peersA.peers[0].deviceId;
    await api(a.page, 'send', [bId], [path.join(srcB, '回传笔记.md')]);
    await waitFor(() => b.page.$('.req .accept'), 20_000, 'B 没有出现接收请求');
    await b.page.click('.req .accept');
    await waitFor(
      async () => {
        const st = await api(b.page, 'getState');
        return st.history.some((h) => h.dir === 'in' && h.state === 'done');
      },
      40_000,
      'B 未完成接收'
    );
    const back = await fsp.readFile(path.join(dirB, '回传笔记.md'), 'utf8');
    if (back !== note) throw new Error('B 收到的回传内容不一致');
    log('B 收到 A 的回传文件，内容一致');

    // ---- 多语言：A 切到英文，界面文案与提示都要跟着变；再切回中文
    await a.page.click('#langBtn');
    await waitFor(() => a.page.$eval('#langOverlay', (n) => !n.hidden), 10_000, '语言弹层没有打开');
    await a.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#langList .langrow')];
      rows.find((r) => r.textContent.includes('English')).click();
    });
    await waitFor(async () => (await api(a.page, 'getState')).settings.language === 'en', 15_000, 'A 未切换到英文');
    await waitFor(() => a.page.$eval('#createRoomBtn', (n) => n.textContent.trim() === 'Host a room'), 15_000, '静态文案没有变成英文');
    await waitFor(
      () => a.page.evaluate(() => [...document.querySelectorAll('#historyList .hist b')].some((n) => /^(Sent|Received)\b/.test(n.textContent))),
      15_000,
      '历史记录没有翻译成英文'
    );
    const enTexts = await a.page.evaluate(() => ({
      step3: document.querySelector('#dropzone strong').textContent.trim(),
      send: document.querySelector('#sendBtn').textContent.trim(),
      history: [...document.querySelectorAll('#historyList .hist b')].map((n) => n.textContent)[0] || '',
      title: document.title,
    }));
    if (!/Drop files or folders here/.test(enTexts.step3)) throw new Error(`拖拽区文案异常：${enTexts.step3}`);
    if (!/Send now/.test(enTexts.send)) throw new Error(`按钮文案异常：${enTexts.send}`);
    if (!/^(Sent|Received)\b/.test(enTexts.history)) throw new Error(`历史记录文案异常：${enTexts.history}`);
    if (enTexts.title !== 'SkyDrop') throw new Error(`窗口标题异常：${enTexts.title}`);
    log(`已切到英文：「${enTexts.step3}」/「${enTexts.send}」/ 记录「${enTexts.history.slice(0, 28)}…」`);
    await a.page.screenshot({ path: path.join(OUT, '8-a-英文界面.png') });

    await a.page.click('#langBtn');
    await a.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#langList .langrow')];
      rows.find((r) => r.textContent.includes('简体中文')).click();
    });
    await waitFor(() => a.page.$eval('#sendBtn', (n) => n.textContent.trim() === '开始传送'), 15_000, '没有切回中文');
    log('已切回简体中文');

    // ---- 中途断开：B 离开房间，A 侧应显示设备离线
    await b.page.click('#leaveBtn');
    await waitFor(() => a.page.$$eval('.peer', (n) => n.length === 0), 20_000, 'A 未显示设备已断开');
    log('离开房间后 A 侧设备列表已清空');

    await b.page.screenshot({ path: path.join(OUT, '6-b-双向完成.png') });
    await a.page.screenshot({ path: path.join(OUT, '7-a-双向完成.png') });

    // ---- 跨网：只经中继重新连接并传文件（A 的房间一直开着）
    for (const inst of [a, b]) {
      await inst.page.click('#setRelayEnabled');
      await waitFor(() => inst.page.$eval('#relayBody', (n) => !n.hidden), 15_000, '中继配置区没有展开');
      await inst.page.select('#setRelayProvider', 'custom');
      await inst.page.click('#setRelayUrl');
      await inst.page.type('#setRelayUrl', relayUrl);
      await inst.page.keyboard.press('Enter');
    }
    await waitFor(async () => (await api(a.page, 'getState')).settings.relayUrl === relayUrl, 15_000, 'A 的中继地址没有保存');
    log('两台设备都已在界面上填好中继地址');

    await a.page.click('#relayTestBtn');
    await waitFor(() => a.page.$eval('#toasts', (n) => /中继可用|可达|Relay reachable/.test(n.textContent)), 20_000, 'A 的中继测试没有通过');
    await waitFor(async () => (await api(a.page, 'getState')).relay.status === 'ready', 20_000, 'A 的中继槽位没有就绪');
    log('A 侧「测试连接」通过，房间槽位已挂上中继');

    const relayNote = await a.page.$eval('#relayNote', (n) => (n.hidden ? '' : n.textContent.trim()));
    if (!/中继|relay/i.test(relayNote)) throw new Error(`房主侧中继说明异常：${relayNote}`);
    await a.page.screenshot({ path: path.join(OUT, '9-a-中继已开放.png') });

    // 输入框里还留着上一轮的房间码，先清空再输，否则会被 7 字符上限截成一串废码
    await b.page.evaluate(() => {
      const input = document.getElementById('codeInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await b.page.click('#codeInput');
    await b.page.type('#codeInput', code.replace('-', ''));
    const relayTyped = await b.page.$eval('#codeInput', (n) => n.value);
    if (relayTyped.replace(/-/g, '') !== code.replace('-', '')) throw new Error(`B 的房间码输入异常：${relayTyped}`);
    await b.page.click('#joinRelayBtn');
    await waitFor(() => b.page.$eval('#joinPending', (n) => !n.hidden), 15_000, 'B 没有进入连接中状态');
    const joinStatus = await b.page.$eval('#joinStatus', (n) => n.textContent.trim());
    if (!/中继|relay/i.test(joinStatus)) throw new Error(`B 的连接中状态没有体现中继：${joinStatus}`);
    log(`B 正在经中继加入：${joinStatus}`);
    await waitFor(() => a.page.$('.req .accept'), 25_000, 'A 没有收到经中继的加入请求');
    const reqText = await a.page.$eval('.req p', (n) => n.textContent);
    if (!/中继|relay/i.test(reqText)) throw new Error(`加入请求里没有出现中继来源：${reqText}`);
    await a.page.screenshot({ path: path.join(OUT, '10-a-中继加入请求.png') });
    await a.page.click('.req .accept');

    await waitFor(() => b.page.$eval('#joinLive', (n) => !n.hidden), 25_000, 'B 未经中继加入成功');
    await waitFor(() => a.page.$$eval('.peer .via', (n) => n.length > 0), 20_000, 'A 侧没有出现「互联网中继」标记');
    const viaBadge = await a.page.$eval('.peer .via', (n) => n.textContent.trim());
    const joinedHost = await b.page.$eval('#joinedHost', (n) => n.textContent.trim());
    log(`中继已连通：A 侧设备标记「${viaBadge}」，B 侧房主「${joinedHost}」`);
    await b.page.screenshot({ path: path.join(OUT, '11-b-经中继加入.png') });

    // 走中继传一个 2MB 文件：B → A
    const cross = crypto.randomBytes(2 * 1024 * 1024);
    await fsp.writeFile(path.join(work, '跨网文件.bin'), cross);
    const peersRelay = await api(b.page, 'getState');
    const relayPeer = peersRelay.peers.find((p) => p.via === 'relay');
    if (!relayPeer) throw new Error(`B 侧设备没有标记 via=relay：${JSON.stringify(peersRelay.peers)}`);
    await api(b.page, 'send', [relayPeer.deviceId], [path.join(work, '跨网文件.bin')]);
    await a.page.bringToFront();
    await waitFor(() => a.page.$('.req .accept'), 25_000, 'A 没有出现中继传输的接收请求');
    await a.page.click('.req .accept');
    await waitFor(
      async () => {
        const st = await api(a.page, 'getState');
        return st.history.some((h) => h.dir === 'in' && /跨网文件/.test(h.files.map((f) => f.name).join('')));
      },
      60_000,
      'A 未收到经中继传来的文件'
    );
    const crossGot = await fsp.readFile(path.join(dirA, '跨网文件.bin'));
    if (crypto.createHash('sha256').update(crossGot).digest('hex') !== crypto.createHash('sha256').update(cross).digest('hex')) {
      throw new Error('经中继收到的文件内容不一致');
    }
    log(`经中继传输 2MB 完成，sha256 一致（${crossGot.length} 字节）`);
    await a.page.screenshot({ path: path.join(OUT, '12-a-中继传输完成.png') });

    // 关掉房间：槽位要立刻从中继上摘掉，不能留孤儿连接
    await a.page.click('#closeRoomBtn');
    await waitFor(async () => (await api(a.page, 'getState')).relay.status === 'off', 20_000, '关闭房间后中继状态没有归位');
    await waitFor(() => relaySrv.stats().waiting === 0, 20_000, '中继侧残留等待槽');
    log(`关闭房间后中继已摘干净：${JSON.stringify(relaySrv.stats())}`);

    log('全部通过 ✅');
  } catch (err) {
    failed = err;
    log('失败 ❌：', err.message);
    log('A 日志：\n', instA.getLog());
    log('B 日志：\n', instB.getLog());
  } finally {
    for (const b of cleanup) {
      try {
        b.disconnect();
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
    try {
      await relaySrv.close();
    } catch {}
    await fsp.rm(work, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
