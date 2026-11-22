'use strict';

/**
 * ngrok 隧道的端到端实测：真实应用窗口里起隧道，访客只拿公网地址连进来传文件。
 *
 *   npm run verify:tunnel
 *
 * 覆盖：
 *  - 应用内检测到本机 ngrok：设置里出现「本机 ngrok 隧道」与隧道面板
 *  - 门禁：未检测到 ngrok 时（用页面里真实的 renderRelay 走一遍）选项、面板、地址块全部消失
 *  - 点「启动隧道」→ 本机中继 + 公网地址 → 地址回填进设置，且从公网侧 GET /health 打得通
 *  - 访客只经这条公网隧道完成双向传文件（房主侧不暴露局域网端口）
 *  - 「复制」写入系统剪贴板；「停止隧道」把 ngrok 进程与本机中继一起收掉
 */

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'tunnel');
const PACKAGED_BIN = '/tmp/skydrop-app/隔空传.app/Contents/MacOS/隔空传';
const CDP_PORT = 9433;
let lastErr = '';

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
    await sleep(200);
  }
}

/** 设置面板比窗口高，按钮在折叠线以下；先滚进视口，再确认鼠标点下去命中的确实是它 */
async function clickNode(page, sel) {
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
  await sleep(200);
  const hit = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], ok: !!at && at.closest(s) === el, top: at ? at.id || at.tagName : 'none' };
  }, sel);
  if (!hit.ok) throw new Error(`点不到 ${sel}：${JSON.stringify(hit)}`);
  await page.click(sel);
  return hit;
}

/** 从隧道公网地址请求 /health：这条请求真的走 ngrok 边缘节点回到本机中继 */
function health(url) {
  return new Promise((resolve) => {
    const req = https.get(url.replace(/^wss:/, 'https:').replace(/^http:/, 'https:') + '/health', { headers: { 'user-agent': 'skydrop-verify' }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
  });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-tunnel-verify-'));
  const recv = path.join(work, 'recv');
  const guestDir = path.join(work, 'guest');
  fs.mkdirSync(recv, { recursive: true });
  fs.mkdirSync(guestDir, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // --packaged：拉起 /tmp/skydrop-app 里的安装包产物，验证 asar 内的中继文件能被 import
  const packaged = process.argv.includes('--packaged');
  const bin = packaged ? PACKAGED_BIN : require(path.join(ROOT, 'node_modules/electron'));
  const child = spawn(bin, packaged
    ? [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, 'ud')}`]
    : [ROOT, `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, 'ud')}`], {
    cwd: packaged ? work : ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  log(packaged ? `被测对象：打包后的 app（${PACKAGED_BIN}）` : '被测对象：源码目录里的 Electron');
  const appLog = [];
  child.stdout.on('data', (d) => appLog.push(String(d)));
  child.stderr.on('data', (d) => appLog.push(String(d)));

  let puppeteer = null;
  let browser = null;
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
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    const api = (fn, ...args) =>
      page.evaluate(
        ({ name, a }) =>
          window.skydrop[name](...a).then((r) => (r && r.ok === false ? Promise.reject(new Error(r.error)) : r && r.data !== undefined ? r.data : r)),
        { name: fn, a: args }
      );
    const state = () => api('getState');

    // ---- 检测：应用内跑一次真实 findNgrok
    const info = await waitFor(async () => {
      const s = await state();
      return s.tunnel && s.tunnel.installed ? s.tunnel : null;
    }, 30_000, '应用内没检测到 ngrok').catch(() => null);
    check(!!info, '应用启动后在界面状态里报出 installed=true', info ? `ngrok v${info.version}` : `主进程日志：\n${appLog.join('')}`);
    if (!info) throw new Error('本机没装 ngrok，无法实测隧道');

    // ---- 门禁：没检测到 ngrok 时（把 installed 改成 false 再走一遍真实渲染）不该有任何入口
    await api('setSettings', { deviceName: '隧道房主', saveDir: recv, autoApprove: true, autoAccept: true });
    await clickNode(page, '#setRelayEnabled');
    await waitFor(() => page.$eval('#relayBody', (n) => !n.hidden), 10_000, '勾了跨网开关后面板没展开');
    const gated = await page.evaluate(() => {
      document.getElementById('setRelayProvider').blur();
      const keep = S.state;
      S.state = { ...keep, tunnel: { ...(keep.tunnel || {}), installed: false, status: 'off', url: '' } };
      render();
      const out = {
        opt: document.getElementById('ngrokOption').hidden,
        box: document.getElementById('ngrokBox').hidden,
        provider: document.getElementById('setRelayProvider').value,
        help: document.getElementById('relayHelp').textContent,
      };
      S.state = keep;
      render();
      return out;
    });
    check(gated.opt && gated.box, 'installed=false 时下拉项与隧道块整体不出现', JSON.stringify(gated));
    check(gated.provider !== 'ngrok', 'installed=false 时服务商退回非 ngrok', gated.provider);
    const shown = await page.evaluate(() => ({
      opt: document.getElementById('ngrokOption').hidden,
      box: document.getElementById('ngrokBox').hidden,
    }));
    check(shown.opt === false && shown.box === false, 'installed=true 时隧道入口正常出现');

    // ---- 选 ngrok 服务商：总开关顺带打开，地址输入框让位给隧道面板
    await page.select('#setRelayProvider', 'ngrok');
    await waitFor(async () => {
      const s = await state();
      return s.relay.enabled && s.relay.provider === 'ngrok';
    }, 15_000, '选 ngrok 后设置没落到引擎');
    await waitFor(() => page.evaluate(() => document.getElementById('relayUrlField').hidden && !document.getElementById('ngrokBox').hidden), 10_000, '隧道面板没接管地址输入框');
    const afterSelect = await page.evaluate(() => ({
      enabled: document.getElementById('setRelayEnabled').checked,
      provider: document.getElementById('setRelayProvider').value,
      help: document.getElementById('relayHelp').textContent,
    }));
    check(afterSelect.enabled && afterSelect.provider === 'ngrok', '选中 ngrok 后自动打开中继总开关', JSON.stringify(afterSelect));
    await page.screenshot({ path: path.join(OUT, '1-跨网卡片-隧道面板.png'), fullPage: true });

    // ---- 固定地址：填一个不属于本账号的保留域名，ngrok 会拒绝，界面要给出中文下一步
    await page.evaluate(() => {
      const el = document.getElementById('ngrokDomain');
      el.value = 'notmine-0a1b2c.ngrok-free.app';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(async () => (await state()).tunnel.domain === 'notmine-0a1b2c.ngrok-free.app', 15_000, '固定地址没写进设置');
    check(await page.$eval('#ngrokDomain', (n) => n.value === 'notmine-0a1b2c.ngrok-free.app'), '隧道面板里的固定地址输入框可用并回填');
    await clickNode(page, '#tunnelStartBtn');
    let badErr = '';
    try {
      badErr = await waitFor(async () => {
        const s = await state();
        return s.tunnel.status === 'error' ? s.tunnel.error : null;
      }, 60_000, '用别人的保留域名居然启动了隧道');
    } catch (e) {
      const s = await state();
      if (s.tunnel.status === 'running') {
        await clickNode(page, '#tunnelStopBtn');
        throw new Error('固定地址本该被 ngrok 拒绝，却起来了：' + s.tunnel.url);
      }
      throw e;
    }
    check(/固定地址用不了|不在当前 ngrok 账号名下/.test(badErr), '固定地址被拒时翻成能照做的中文', badErr);
    // 渲染是 50ms 去抖合帧的，直接读会拿到上一帧的「正在启动隧道…」
    let badState = '';
    try {
      badState = await waitFor(
        async () => {
          const text = await page.$eval('#tunnelState', (n) => n.textContent);
          return /隧道异常/.test(text) ? text : null;
        },
        5_000,
        '固定地址报错后界面没显示异常状态',
      );
    } catch (e) {
      badState = await page.$eval('#tunnelState', (n) => n.textContent);
    }
    check(/隧道异常/.test(badState), '隧道面板显示异常状态', badState);
    check(execSync('pgrep -fl "ngrok http" || true').toString().trim() === '', '固定地址报错后没留残留 ngrok 进程');
    await page.screenshot({ path: path.join(OUT, '2-固定地址报错.png'), fullPage: true });
    // 清空回到每次随机分配的地址，后面的正常流程照常跑
    await page.evaluate(() => {
      const el = document.getElementById('ngrokDomain');
      el.value = '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(async () => (await state()).tunnel.domain === '', 15_000, '清空固定地址没写进设置');

    // ---- 建房 + 起隧道
    await page.click('#createRoomBtn');
    await waitFor(() => page.$eval('#hostLive', (n) => !n.hidden), 20_000, '未出现房间面板');
    const code = (await page.$eval('#roomCode', (n) => n.textContent.trim())).replace('-', '');
    await clickNode(page, '#tunnelStartBtn');
    const startingText = await waitFor(
      () => page.$eval('#tunnelState', (n) => n.textContent).then((s) => (/正在启动|运行中/.test(s) ? s : null)),
      15_000,
      '点了「启动隧道」界面没反应'
    );
    check(/正在启动|运行中/.test(startingText), '点「启动隧道」进入启动中', startingText);
    let running = null;
    try {
      running = await waitFor(async () => {
        const s = await state();
        return s.tunnel.status === 'running' ? s : null;
      }, 90_000, '隧道没起来');
    } catch {
      const s = await state();
      log(`隧道状态：${JSON.stringify(s.tunnel)}\n界面状态：${await page.$eval('#tunnelState', (n) => n.textContent)}\n主进程日志：\n${appLog.join('')}`);
      throw new Error('隧道启动失败：' + (s.tunnel.error || '未知原因'));
    }
    const tun = running.tunnel;
    check(/^https:\/\/[a-z0-9][a-z0-9-]*\.ngrok(-free)?\.(app|com)$/i.test(tun.url), '拿到 ngrok 的公网 https 地址', tun.url);
    check(running.relay.url === tun.url && running.relay.provider === 'ngrok', '隧道地址直接当会话用的中继地址', running.relay.url);
    const uiTun = await waitFor(
      () =>
        page
          .evaluate(() => ({
            url: document.getElementById('tunnelUrl').textContent,
            state: document.getElementById('tunnelState').textContent,
            startHidden: document.getElementById('tunnelStartBtn').hidden,
            stopHidden: document.getElementById('tunnelStopBtn').hidden,
            copyHidden: document.getElementById('tunnelCopyBtn').hidden,
            domainDisabled: document.getElementById('ngrokDomain').disabled,
          }))
          .then((v) => (v.url === running.tunnel.url ? v : null)),
      15_000,
      '隧道面板没显示公网地址'
    );
    check(/运行中/.test(uiTun.state) && uiTun.startHidden && !uiTun.stopHidden && !uiTun.copyHidden, '隧道面板显示地址与状态、按钮互斥', JSON.stringify(uiTun));
    check(uiTun.domainDisabled === true, '隧道运行中锁住固定地址输入框（改了要重启隧道才生效）');
    await page.screenshot({ path: path.join(OUT, '3-隧道运行中.png'), fullPage: true });

    const h = await health(tun.url);
    check(h.status === 200, '公网侧 GET /health 打得通', JSON.stringify(h));
    await waitFor(async () => (await state()).relay.status === 'ready', 30_000, '房主槽位没挂上本机中继');
    check(true, '房主侧 3 条槽位已挂在隧道后的本机中继上', JSON.stringify((await state()).relay));

    // ---- 访客：只知道公网地址，另一头连进来
    const { Hub } = require(path.join(ROOT, 'src/main/engine/hub'));
    guestHub = new Hub({ deviceName: '公网访客', saveDir: guestDir, autoAccept: true, autoApprove: true, relayEnabled: true, relayProvider: 'custom', relayUrl: tun.url });
    let joined = null;
    try {
      joined = await waitFor(async () => {
        try {
          return await guestHub.joinRelay(code);
        } catch (e) {
          lastErr = String(e.message || e);
          return null;
        }
      }, 60_000, '访客连不进隧道后的房间');
    } catch (e) {
      log(`访客加入失败，最后一次错误：${lastErr}`);
      throw e;
    }
    check(joined.via === 'relay' && joined.name === '隧道房主', '访客只经公网隧道加入房间', JSON.stringify(joined));

    // ---- 访客 → 应用：真实文件经隧道落到应用的保存目录
    const src = path.join(work, 'src');
    fs.mkdirSync(path.join(src, '子目录'), { recursive: true });
    await fsp.writeFile(path.join(src, '隧道单向.dat'), crypto.randomBytes(3 * 1024 * 1024));
    await fsp.writeFile(path.join(src, '子目录', '说明.txt'), 'ngrok relay ok\n');
    await waitFor(async () => (await page.$$('button.target.on')).length > 0, 30_000, '界面没出现已连接的目标设备');
    await guestHub.send({ paths: [path.join(src, '隧道单向.dat'), src] });
    await waitFor(async () => fs.existsSync(path.join(recv, '隧道单向.dat')), 120_000, '隧道对向的文件没落地');
    const gotSize = (await fsp.stat(path.join(recv, '隧道单向.dat'))).size;
    check(gotSize === 3 * 1024 * 1024, '访客 → 应用的 3MB 文件字节数一致', `${gotSize}`);
    // 单独拖一个文件进来按平铺落盘，整个目录进来才保留层级——隧道后面这两条都要一样
    await waitFor(async () => fs.existsSync(path.join(recv, 'src', '子目录', '说明.txt')), 30_000, '目录递归的文件没落地');
    check((await fsp.readFile(path.join(recv, 'src', '子目录', '说明.txt'), 'utf8')) === 'ngrok relay ok\n', '目录层级与文本内容一致');

    // ---- 应用 → 访客：从界面「发送」走隧道反向
    const backFile = path.join(work, '回传.txt');
    await fsp.writeFile(backFile, 'host over ngrok\n');
    await api('send', [], [backFile]);
    const inFile = await waitFor(async () => {
      const f = path.join(guestDir, '回传.txt');
      return fs.existsSync(f) ? f : null;
    }, 90_000, '应用发回的文件没到访客');
    check((await fsp.readFile(inFile, 'utf8')) === 'host over ngrok\n', '应用 → 访客反向传输内容一致');
    const peerOnHost = (await state()).peers;
    check(peerOnHost.length === 1 && peerOnHost[0].via === 'relay' && peerOnHost[0].ip === '', '房主把这条连接标记成中继来的，不带局域网 IP', JSON.stringify(peerOnHost));

    // ---- 复制按钮写系统剪贴板
    execSync('printf "EMPTY-MARKER" | LC_ALL=en_US.UTF-8 pbcopy');
    await clickNode(page, '#tunnelCopyBtn');
    await waitFor(async () => (await page.$eval('#toasts', (n) => n.innerText)).includes('已复制隧道地址'), 10_000, '复制后没弹提示');
    const clip = execSync('LC_ALL=en_US.UTF-8 pbpaste').toString('utf8');
    check(clip === tun.url, '「复制」写入系统剪贴板（pbpaste 对拍一致）', clip);

    // ---- 停隧道：进程与本机中继一起收掉，设置里不留过期的公网地址
    await clickNode(page, '#tunnelStopBtn');
    await waitFor(async () => (await state()).tunnel.status === 'off', 20_000, '隧道没停干净');
    const off = await state();
    check(off.relay.url === '' && off.relay.provider === 'ngrok', '停隧道后不留过期的公网地址', JSON.stringify(off.relay));
    const gone = await waitFor(() => page.evaluate(() => document.getElementById('tunnelUrl').textContent).then((v) => (v === '—' ? v : null)), 15_000, '界面地址没回到占位').catch(() => 'TIMEOUT');
    check(gone === '—', '界面地址回到占位', gone);
    check(await page.$eval('#ngrokDomain', (n) => n.disabled === false), '停隧道后固定地址输入框重新可编辑');
    // 本机中继收掉之后，公网那条地址就该 4xx/连不上；放在界面校验之后再查，别把隧道收得不干净当成界面问题
    const stillUp = await health(tun.url);
    check(stillUp.status !== 200, 'ngrok 收掉后公网地址不再通向本机', JSON.stringify(stillUp));
    await page.screenshot({ path: path.join(OUT, '4-隧道已停止.png'), fullPage: true });

    check(errs.length === 0, '渲染进程没有报错', errs.join(' | '));
    log(`截图与主进程日志已存到 ${OUT}`);
  } catch (err) {
    fails.push('执行中断：' + err.message);
    log('✘ 中断：', err.stack || err.message);
  } finally {
    try {
      if (guestHub) guestHub.dispose();
    } catch {}
    try {
      if (browser) browser.close();
    } catch {}
    child.kill();
    await sleep(800);
    fs.writeFileSync(path.join(OUT, 'app.log'), appLog.join(''));
    // 收尾：确认没有残留的 ngrok 子进程
    try {
      const left = execSync('pgrep -fl "ngrok http" || true').toString().trim();
      check(left === '', '没有残留的 ngrok 进程', left);
    } catch (e) {
      log('进程检查失败：' + e.message);
    }
    await fsp.rm(work, { recursive: true, force: true });
  }

  console.log(fails.length === 0 ? '\n全部通过' : `\n失败 ${fails.length} 项：\n- ${fails.join('\n- ')}`);
  process.exit(fails.length === 0 ? 0 : 1);
})();
