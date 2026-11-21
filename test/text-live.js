'use strict';

/**
 * 文本传送的端到端实测：真实应用窗口里打字发送，引擎访客收发对拍，
 * 剪贴板用系统 pbpaste 校验，截图存到 out/text/。
 *
 *   npm run verify:text
 *
 * 覆盖：
 *  - 「仅文本发送」：应用 → 引擎访客，无需确认直接出现在对方文本栏
 *  - 引擎访客 → 应用：应用文本栏出现条目，「复制」按钮写入系统剪贴板
 *  - 「生成 TXT 发送」：访客按普通文件接收 .txt，落盘内容一致，发送端临时文件清理
 *  - 超长文本在 IPC 层被拒并有错误提示；长文本列表里折叠、点击展开
 *  - 英文界面下文本卡片文案切换
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'text');
const CDP_PORT = 9431;

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

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'skydrop-text-verify-'));
  const recv = path.join(work, 'recv');
  const guestDir = path.join(work, 'guest');
  fs.mkdirSync(recv, { recursive: true });
  fs.mkdirSync(guestDir, { recursive: true });

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

    await api('setSettings', { deviceName: '文本实测机', saveDir: recv, autoApprove: true, autoAccept: true });
    await page.click('#createRoomBtn');
    await waitFor(() => page.$eval('#hostLive', (n) => !n.hidden), 20_000, '未出现房间面板');
    const code = (await page.$eval('#roomCode', (n) => n.textContent.trim())).replace('-', '');
    const st = await api('getState');
    log(`房间码 ${code}，数据端口 ${st.room.port}`);

    // ---- 访客（引擎实例）
    const { Hub } = require(path.join(ROOT, 'src/main/engine/hub'));
    guestHub = new Hub({ deviceName: '文本访客', saveDir: guestDir, autoApprove: true, autoAccept: true });
    await guestHub.joinDirect(`127.0.0.1:${st.room.port}`, code);
    await waitFor(async () => (await page.$$('button.target.on')).length > 0, 15_000, '界面没出现已连接的目标设备');

    // ---- 应用 → 访客：仅文本发送
    const typed = '你好，隔空传！这是界面里打字发送的一段文本。';
    const guestGot = new Promise((res) => guestHub.on('event', (e) => e.type === 'text-in' && res(e.text)));
    await page.type('#textInput', typed, { delay: 4 });
    await waitFor(() => page.$eval('#sendTextBtn', (n) => !n.disabled), 10_000, '发送文本按钮没亮起来');
    await page.click('#sendTextBtn');
    const got1 = await guestGot;
    check(got1.text === typed, '界面输入的文本原样到达访客', got1.text.slice(0, 24));
    check(guestHub.texts[0].dir === 'in' && guestHub.texts[0].peerName === '文本实测机', '访客文本栏记录方向与来源正确');
    await waitFor(async () => (await page.$eval('#textList', (n) => n.innerText)).includes('发出'), 10_000, '应用自己的文本栏没有出现发出条目');
    check(true, '应用文本栏出现「发出」条目');

    // ---- 访客 → 应用：文本栏条目 + 复制按钮写入系统剪贴板
    const backText = '访客回发：SkyDrop text transfer works. 剪贴板校验用。';
    // pbcopy/pbpaste 在 C locale 下会把非 ASCII 转码成乱码，必须固定 UTF-8 环境
    execSync('printf "EMPTY-MARKER" | LC_ALL=en_US.UTF-8 pbcopy');
    await guestHub.sendText({ text: backText });
    const row = await waitFor(async () => {
      const rows = await page.$$('.text-item');
      for (const r of rows) if ((await r.$eval('.textbody', (n) => n.textContent)) === backText) return r;
      return null;
    }, 10_000, '应用文本栏没出现访客发来的文本');
    check(!!row, '访客 → 应用的文本出现在文本栏');
    const meta = await row.$eval('b', (n) => n.textContent);
    check(/收到/.test(meta), '条目标注「收到 + 对端名」', meta);
    // 渲染循环每 50ms 会重建 #textList，行句柄容易失效；按文本内容实时点当前 DOM 里的按钮
    await page.evaluate((text) => {
      for (const r of document.querySelectorAll('.text-item')) {
        const body = r.querySelector('.textbody');
        if (body && body.textContent === text) {
          r.querySelector('button').click();
          return;
        }
      }
      throw new Error('没找到要复制的文本行');
    }, backText);
    await waitFor(async () => (await page.$eval('#toasts', (n) => n.innerText)).includes('已复制文本'), 8_000, '复制后没有弹出「已复制文本」提示');
    const clip = execSync('LC_ALL=en_US.UTF-8 pbpaste').toString('utf8');
    if (clip !== backText) log(`剪贴板实际内容（${clip.length} 字）：${JSON.stringify(clip.slice(0, 120))}`);
    check(clip === backText, '「复制」按钮写入系统剪贴板（pbpaste 对拍一致）', `剪贴板 ${clip.length} 字 vs 原文 ${backText.length} 字`);

    // ---- 长文本：列表里折叠 400 字，点击展开全文，再点收起
    const longText = '长'.repeat(2500);
    await guestHub.sendText({ text: longText });
    const longRow = await waitFor(async () => {
      const rows = await page.$$('.text-item');
      for (const r of rows) if ((await r.$eval('.textbody', (n) => n.textContent)).includes('…')) return r;
      return null;
    }, 10_000, '长文本没有按 400 字折叠');
    const folded = await longRow.$eval('.textbody', (n) => n.textContent);
    check(folded.length === 401, '折叠条目正好 400 字 + 省略号', `${folded.length}`);
    await longRow.$eval('.textbody', (n) => n.click());
    const expanded = await longRow.$eval('.textbody', (n) => n.textContent);
    check(expanded.length === 2500, '点击展开后是完整文本', `${expanded.length}`);
    await page.screenshot({ path: path.join(OUT, '1-文本栏-中文.png'), fullPage: true });
    log('已截 1-文本栏-中文.png');

    // ---- 超长文本：IPC 层拒绝，弹错误提示，双方都不留记录
    const guestCount0 = guestHub.texts.length;
    await page.evaluate(() => {
      const ta = document.getElementById('textInput');
      ta.value = 'a'.repeat(40_000);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitFor(() => page.$eval('#sendTextBtn', (n) => !n.disabled), 5_000, '超长文本时按钮状态异常');
    await page.click('#sendTextBtn');
    await waitFor(async () => (await page.$eval('#toasts', (n) => n.innerText)).includes('文本过长'), 8_000, '超长文本没有弹出错误提示');
    check(guestHub.texts.length === guestCount0, '超长文本没有送达访客');
    await page.evaluate(() => {
      const ta = document.getElementById('textInput');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // ---- 生成 TXT：访客按普通文件接收 .txt，发送端临时文件收尾后清理
    const txtBody = '生成 TXT 模式：\n第一行\n第二行 with ascii';
    const txtDone = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('访客一直没完成 txt 接收')), 30_000);
      guestHub.on('event', (e) => e.type === 'offer-done' && e.ok && (clearTimeout(timer), res(e.offer)));
    });
    await page.type('#textInput', txtBody, { delay: 3 });
    await waitFor(() => page.$eval('#sendTextFileBtn', (n) => !n.disabled), 5_000, '生成 TXT 按钮没亮起来');
    await page.click('#sendTextFileBtn');
    const txtOffer = await txtDone;
    check(txtOffer.files.length === 1 && /\.txt$/.test(txtOffer.files[0].name), '访客收到一个 .txt 文件', txtOffer.files[0].name);
    const saved = path.join(guestDir, txtOffer.files[0].name);
    const savedBody = await fsp.readFile(saved, 'utf8');
    check(savedBody === txtBody, 'TXT 落盘内容与输入一致');
    check(/^文本 \d{4}-\d{2}-\d{2} /.test(txtOffer.files[0].name), 'TXT 文件名带日期', txtOffer.files[0].name);

    // 应用侧历史里也应有一条完成的文件任务
    const hist = await waitFor(async () => {
      const s = await api('getState');
      return s.history.length && s.history[0].files[0].name === txtOffer.files[0].name ? s.history[0] : null;
    }, 15_000, '应用历史里没有 txt 任务');
    check(hist.dir === 'out' && hist.state === 'done', '应用侧历史是完成态的发出任务');

    // 发送端临时 .txt 要被删掉（应用与脚本同 TMPDIR）
    await waitFor(async () => {
      const files = await fsp.readdir(path.join(os.tmpdir(), 'skydrop-text')).catch(() => []);
      return files.length === 0 ? files : null;
    }, 15_000, '应用侧临时 txt 目录没有清空');
    check(true, '发送端临时 .txt 已在任务收尾后删除');

    // ---- 英文界面
    await api('setSettings', { language: 'en' });
    await waitFor(async () => (await page.$eval('#textCard h2 span', (n) => n.textContent)) === '4 · Send text', 10_000, '英文界面没切到文本卡片标题');
    const enBtn = await page.$eval('#sendTextBtn', (n) => n.textContent);
    const enFileBtn = await page.$eval('#sendTextFileBtn', (n) => n.textContent);
    check(enBtn === 'Send as text' && enFileBtn === 'Send as TXT file', '英文按钮文案正确', `${enBtn} / ${enFileBtn}`);
    // render 是 50ms 合帧的，等它把文本栏按新语言重画完
    const enList = await waitFor(
      async () => {
        const txt = await page.$eval('#textList', (n) => n.innerText);
        return /Received|Sent/.test(txt) ? txt : null;
      },
      10_000,
      '英文文本栏文案没切换'
    );
    check(enList.includes('Received 文本访客') || enList.includes('Received'), '英文文本栏条目用 Received/Sent');
    await page.screenshot({ path: path.join(OUT, '2-文本栏-英文.png'), fullPage: true });
    log('已截 2-文本栏-英文.png');

    // ---- 面板也能看到文本
    const panelUrl = (await api('getState')).panel.url;
    const snap = await (await fetch(`${panelUrl}api/state`)).json();
    check(Array.isArray(snap.texts) && snap.texts.some((x) => x.text === backText), '面板快照带文本列表');
    check(snap.limits.textMaxBytes === 32 * 1024, '面板拿到文本上限常量');

    const realErrs = errs.filter((e) => !/ERR_CONNECTION_REFUSED/.test(e));
    check(realErrs.length === 0, '应用渲染层控制台无报错', realErrs.join(' | '));
  } catch (err) {
    fails.push('脚本异常：' + err.message);
    log('✘ 失败：' + err.message);
    log('应用日志尾部：' + appLog.join('').slice(-600));
  } finally {
    if (guestHub) guestHub.dispose();
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
