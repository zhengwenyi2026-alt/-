'use strict';

/**
 * 本机传输面板的端到端实测：起一个真实应用实例 + 一个引擎侧发送方，
 * 传一批大文件，同时用无头 Chrome 把面板截图存到 out/panel/，并校验访问控制与数据一致性。
 *
 *   npm run verify:panel                # 默认 1.3 GB 载荷（临时目录用完即删，峰值约占 2.6 GB 磁盘）
 *   node test/panel-live.js 300         # 只要 300 MB，跑得快
 *
 * 没有装 Google Chrome 的机器仍然会跑完访问控制与传输校验，只是跳过截图。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'panel');
const CDP_PORT = 9431;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOTAL_MB = Number(process.argv[2] || 1300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fails = [];
const check = (ok, what, detail = '') => {
  log(`${ok ? '✔' : '✘'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(what);
};

async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(150);
  }
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

/** 原始 socket 发 HTTP：fetch 会重写 Host 头，伪造 Host 只能用 socket 测 */
function rawGet(port, hostHeader, reqPath = '/') {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const done = (v) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done('超时'), 5000);
    sock.on('error', (e) => done(`拒绝连接 ${e.code}`));
    sock.on('data', (d) => {
      buf += String(d);
      if (buf.includes('\r\n\r\n') || buf.length > 4096) {
        const head = buf.split('\r\n')[0];
        const body = (buf.split('\r\n\r\n')[1] || '').slice(0, 24).replace(/\s+/g, ' ');
        done(`${head} | ${body}`);
      }
    });
    sock.on('connect', () => sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`));
  });
}

async function probe(url) {
  const r = await fetch(url).catch((e) => ({ err: e.cause?.code || e.message }));
  if (r && r.err) return { status: 0, body: `拒绝连接 ${r.err}` };
  return { status: r.status, body: (await r.text()).slice(0, 24) };
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-panel-verify-'));
  const recv = path.join(work, 'recv');
  const src = path.join(work, 'src');
  fs.mkdirSync(recv, { recursive: true });
  fs.mkdirSync(src, { recursive: true });

  // 载荷：3 个大文件 + 一个 25 个小文件的目录，够把进度、速率与逐文件明细撑出来
  const chunk = crypto.randomBytes(8 * 1024 * 1024);
  const sizes = [0.46, 0.31, 0.23].map((x) => Math.max(8, Math.round((TOTAL_MB * x) / 8) * 8));
  const names = ['视频素材.bin', '设计稿导出.bin', '数据集.bin'];
  for (const [i, mb] of sizes.entries()) {
    const fh = await fsp.open(path.join(src, names[i]), 'w');
    for (let k = 0; k < mb / 8; k += 1) await fh.write(chunk, 0, chunk.length, k * chunk.length);
    await fh.close();
  }
  await fsp.mkdir(path.join(src, '报告目录'), { recursive: true });
  for (let i = 0; i < 25; i += 1) await fsp.writeFile(path.join(src, '报告目录', `第${i + 1}部分.txt`), `part ${i + 1}\n`.repeat(200));
  const payloadMB = sizes.reduce((a, b) => a + b, 0);
  log(`载荷 ${payloadMB} MB + 25 个小文件`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(path.join(ROOT, 'node_modules/electron')), [ROOT, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, 'ud')}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  child.stdout.on('data', (d) => appLog.push(String(d)));
  child.stderr.on('data', (d) => appLog.push(String(d)));

  let puppeteer = null;
  let browser = null;
  let chrome = null;
  let guestHub = null;
  try {
    puppeteer = require(path.join(ROOT, 'node_modules/puppeteer-core'));
    browser = await waitFor(async () => {
      try {
        const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, protocol: 'http' });
        return (await b.pages()).find((p) => p.url().endsWith('renderer/index.html')) ? b : null;
      } catch {
        return null;
      }
    }, 60_000, '应用窗口未就绪');
    const page = (await browser.pages()).find((p) => p.url().endsWith('renderer/index.html'));
    const api = (fn, ...args) =>
      page.evaluate(
        ({ name, a }) =>
          window.skydrop[name](...a).then((r) => (r && r.ok === false ? Promise.reject(new Error(r.error)) : r && r.data !== undefined ? r.data : r)),
        { name: fn, a: args }
      );

    // 房主自动放行加入与接收，传输时机完全由本脚本掌握
    await api('setSettings', { deviceName: '面板实测机', saveDir: recv, autoApprove: true, autoAccept: true });
    await page.click('#createRoomBtn');
    await waitFor(() => page.$eval('#hostLive', (n) => !n.hidden), 20_000, '未出现房间面板');
    const code = (await page.$eval('#roomCode', (n) => n.textContent.trim())).replace('-', '');
    const st = await api('getState');
    check(!!st.panel, '应用启动即开常驻面板端口', st.panel ? st.panel.url : 'state().panel 为空');
    if (!st.panel) throw new Error('面板没起来');
    const panelUrl = st.panel.url;
    log(`房间码 ${code}，数据端口 ${st.room.port}，面板 ${panelUrl}`);

    // ---- 访问控制
    const ip = lanIp();
    const lanPanel = await probe(`http://${ip}:${st.panel.port}/`);
    check(lanPanel.status === 0, '局域网来源连不上面板端口', `${ip}:${st.panel.port} → ${lanPanel.body}`);
    const lanRoom = await probe(`http://${ip}:${st.room.port}/`);
    check(lanRoom.status === 404 && lanRoom.body.includes('SkyDrop'), '局域网来源访问房间端口仍是 404 SkyDrop', `${lanRoom.status} ${lanRoom.body}`);
    const localRoom = await probe(`http://localhost:${st.room.port}/`);
    check(localRoom.status === 200 && /<!doctype html>/i.test(localRoom.body), '本机访问房间端口返回面板页', `${localRoom.status} ${localRoom.body.slice(0, 16)}`);
    const evil = await rawGet(st.panel.port, 'evil.example.com', '/api/state');
    check(evil.startsWith('HTTP/1.1 404'), '伪造 Host 被拒（DNS 重绑定防线）', evil);
    const noHost = await rawGet(st.panel.port, '', '/api/state');
    check(noHost.startsWith('HTTP/1.1 404'), '缺 Host 被拒', noHost);
    for (const host of [`localhost:${st.panel.port}`, `127.0.0.1:${st.panel.port}`, `[::1]:${st.panel.port}`]) {
      const r = await rawGet(st.panel.port, host, '/');
      check(r.startsWith('HTTP/1.1 200'), `本机 Host ${host} 放行`, r.split(' | ')[0]);
    }
    const pageRes = await fetch(panelUrl);
    const csp = pageRes.headers.get('content-security-policy') || '';
    check(/script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), '面板 CSP 不给外部脚本留口子', csp);

    // ---- 访客（引擎实例）
    const { Hub } = require(path.join(ROOT, 'src/main/engine/hub'));
    guestHub = new Hub({ deviceName: '发送方引擎', saveDir: path.join(work, 'guest'), autoApprove: true });
    await guestHub.joinDirect(`127.0.0.1:${st.room.port}`, code);

    // ---- 浏览器侧截图（可选）
    let shot = null;
    if (fs.existsSync(CHROME)) {
      chrome = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=1280,1600'] });
      shot = await chrome.newPage();
      await shot.setViewport({ width: 1180, height: 1400, deviceScaleFactor: 2 });
      const errs = [];
      shot.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
      shot.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
      shot.errs = errs;
      await shot.goto(panelUrl, { waitUntil: 'networkidle2' });
      await sleep(1300);
      await shot.screenshot({ path: path.join(OUT, '1-空闲.png'), fullPage: true });
      log('已截 1-空闲.png');
    } else {
      log('没找到 Google Chrome，跳过截图，只做数据与访问控制校验');
    }

    const sendDone = guestHub.send({ paths: sizes.map((_, i) => path.join(src, names[i])).concat(path.join(src, '报告目录')) });

    if (shot) {
      // 盯面板自己的 DOM：等它渲染出进度再冻结画面，传输再快也能抓到中途
      const frozen = await shot.evaluate(async () => {
        for (let i = 0; i < 4000; i += 1) {
          const task = document.querySelector('.task');
          const m = task && task.innerText.match(/(\d+\.\d)%/);
          if (m && parseFloat(m[1]) >= 5) {
            document.getElementById('pauseBtn').click();
            for (const b of document.querySelectorAll('.task button')) b.click();
            return task.innerText.replace(/\n+/g, ' | ').slice(0, 200);
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        return null;
      });
      check(!!frozen, '抓到传输中的画面', frozen || '面板始终没出现进行中的任务');
      await sleep(400);
      await shot.screenshot({ path: path.join(OUT, '2-传输中.png'), fullPage: true });
      await shot.evaluate(() => document.getElementById('pauseBtn').click());
    }

    const sent = await sendDone;
    log(`发送结果：${JSON.stringify(sent).slice(0, 120)}`);
    const after = await waitFor(async () => {
      const s = await (await fetch(`${panelUrl}api/state`)).json();
      return s.history.length > 0 && s.offers.length === 0 ? s : null;
    }, 120_000, '面板一直没把这次传输记进历史');

    check(after.totals.recvBytes === sent.bytes, '面板统计的接收字节等于实际传输字节', `${after.totals.recvBytes} vs ${sent.bytes}`);
    check(after.totals.ok === 1 && after.totals.failed === 0, '历史里是一条成功任务', `ok=${after.totals.ok} failed=${after.totals.failed}`);
    check(after.totals.peakRate > 0, '任务结束后峰值速率仍然留存', `${(after.totals.peakRate / 1048576).toFixed(0)} MB/s`);
    check(after.limits.relayPingMs > 0 && after.limits.pairTimeoutMs > 0 && after.limits.relayBackoff.length === 5, '中继参数透传到面板', `${after.limits.relayPingMs}/${after.limits.pairTimeoutMs}`);
    check(after.history[0].files.length === sent.count, '历史条目带全部文件明细', `${after.history[0].files.length}/${sent.count}`);

    const sha = async (p) => crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');
    for (const name of names) {
      const same = (await sha(path.join(src, name))) === (await sha(path.join(recv, name)));
      check(same, `${name} 落盘内容 sha256 一致`);
    }

    if (shot) {
      await sleep(1200);
      await shot.screenshot({ path: path.join(OUT, '3-完成后.png'), fullPage: true });
      log('已截 3-完成后.png');
      const heads = {};
      for (const code2 of ['ja', 'en', 'ko', 'zh-TW']) {
        await shot.select('#langSel', code2);
        await sleep(800);
        heads[code2] = await shot.evaluate(() => document.querySelector('.card')?.innerText.replace(/\n+/g, ' | ').slice(0, 100) || '');
        await shot.screenshot({ path: path.join(OUT, `4-${code2}.png`), fullPage: true });
        log(`已截 4-${code2}.png：${heads[code2].slice(0, 60)}`);
      }
      check(new Set(Object.values(heads)).size === 4, '四种语言首屏文案互不相同');
      await shot.select('#langSel', 'zh-CN');
      await sleep(1000);
      fs.writeFileSync(path.join(OUT, '面板文本.txt'), await shot.evaluate(() => document.getElementById('app').innerText));
      const realErrs = (shot.errs || []).filter((e) => !/ERR_CONNECTION_REFUSED/.test(e));
      check(realErrs.length === 0, '面板控制台无报错', realErrs.join(' | '));
    }
  } catch (err) {
    fails.push('脚本异常：' + err.message);
    log('✘ 失败：' + err.message);
    log('应用日志尾部：' + appLog.join('').slice(-600));
  } finally {
    if (guestHub) guestHub.dispose();
    try { if (chrome) await chrome.close(); } catch {}
    try { if (browser) browser.disconnect(); } catch {}
    child.kill('SIGTERM');
    await sleep(800);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(work, { recursive: true, force: true });
    log('已清理临时目录');
  }

  log(fails.length ? `结果：${fails.length} 项未通过\n- ${fails.join('\n- ')}` : '结果：全部通过 ✅');
  process.exit(fails.length ? 1 : 0);
})();
