'use strict';

// ngrok 隧道：本机跑一个中继，再用 ngrok 把它暴露成公网 wss 地址，
// 这样没有服务器的人也能一键跨网传输。整块能力以「装没装 ngrok」为前提，
// 没装时界面不出现任何 ngrok 相关内容（installed=false）。
//
// 所有外部依赖（目录探测、子进程、HTTP 查询）都做成可注入参数，方便自动化测试。

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VERSION_TIMEOUT = 4000;
const TUNNEL_WAIT = 25_000;
const TUNNEL_POLL = 250;
const NGROK_API_PORT = 4040; // ngrok 本机检查接口默认端口

const AUTHTOKEN_HINT =
  'ngrok 还没有配置 authtoken，请在终端执行：ngrok config add-authtoken <你的令牌>（令牌见 https://dashboard.ngrok.com/get-started/authtoken），配好后回到这里点「启动隧道」';

const DOMAIN_HINT = '固定地址要填 ngrok 账号名下的域名，例如 abc123.ngrok-free.app；留空就用每次随机分配的地址';

const STATIC_DOMAIN_PLAN =
  '这个固定地址用不了：免费版只能用 ngrok 控制台「Domains」里领到的那一个保留域名，自定义子域名要付费套餐（留空则每次随机分配地址）';

const STATIC_DOMAIN_FOREIGN =
  '这个域名不在当前 ngrok 账号名下：请到 ngrok 控制台「Domains」确认领到的保留域名，或留空用每次随机分配的地址';

/**
 * 固定地址：ngrok 控制台「Domains」里领到的保留域名（免费版每个账号一个）。
 * 允许直接粘 `https://xxx.ngrok-free.app/`，只取主机名，其它一律当没填。
 */
function normalizeNgrokDomain(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].split(':')[0].trim();
  if (host.length > 120 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error(DOMAIN_HINT);
  }
  return host;
}

/** ngrok 的错误文案偏工程师，这里翻译成能照着做的下一步 */
function ngrokErrorText(detail) {
  const text = String(detail || '');
  if (/authtoken|auth token|authentication failed/i.test(text)) return AUTHTOKEN_HINT;
  if (/ERR_NGROK_313|custom subdomains|only paid plans/i.test(text)) return STATIC_DOMAIN_PLAN;
  if (/ERR_NGROK_4903|not reserved|does not belong to your account|unrecognized hostname|reserved by (?:a|another)/i.test(text)) {
    return STATIC_DOMAIN_FOREIGN;
  }
  if (/usage limit|limit reached|too many|limited to \d+ simultaneous|simultaneous ngrok agent|only \d+ (agent|tunnel)/i.test(text)) {
    return 'ngrok 免费账号同时只能开一条隧道，请先停掉其它设备上的隧道（或升级套餐）再试';
  }
  if (/already in use|address already/i.test(text)) {
    return '本机隧道检查端口被占用了，请先关掉其它正在运行的 ngrok 再试';
  }
  if (/unknown flag|unknown option|not recognized/i.test(text)) {
    return '这台机器上的 ngrok 版本太旧，请升级到 3.x（macOS：brew upgrade ngrok／Windows：winget upgrade ngrok）';
  }
  if (/x509|certificate|tls/i.test(text)) return 'ngrok 连接失败：本机证书校验没通过，请检查代理或安全软件';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return '连不上 ngrok 服务：请确认这台机器能访问外网';
  if (/ECONNREFUSED|network|timeout/i.test(text)) return '连不上 ngrok 服务：请检查网络或代理后重试';
  const code = text.match(/ERR_NGROK_\d+/i);
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 180);
  return trimmed ? `ngrok 启动失败：${trimmed}${code ? `（${code[0]}）` : ''}` : 'ngrok 启动失败，请在终端手动运行 ngrok 查看具体原因';
}

/** 检测逻辑要能被自动化测试注入 win32 的目录与环境变量，所以按平台取路径实现，不依赖当前进程跑在哪个系统上 */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path;
}

/** 各平台 ngrok 的常见安装位置（PATH 之外的补集） */
function standardDirs(platform, env, homedir) {
  const e = env || {};
  const p = pathFor(platform);
  if (platform === 'win32') {
    return [
      e.LOCALAPPDATA && p.join(e.LOCALAPPDATA, 'ngrok'),
      e.ProgramFiles && p.join(e.ProgramFiles, 'ngrok'),
      e['ProgramFiles(x86)'] && p.join(e['ProgramFiles(x86)'], 'ngrok'),
      homedir && p.join(homedir, 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'].concat(
      homedir ? [path.join(homedir, 'bin'), path.join(homedir, '.local', 'bin')] : []
    );
  }
  return ['/usr/local/bin', '/usr/bin', '/snap/bin'].concat(
    homedir ? [path.join(homedir, 'bin'), path.join(homedir, '.local', 'bin')] : []
  );
}

function dirCandidates({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const p = pathFor(platform);
  const fromPath = String((env && env.PATH) || '')
    .split(p.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(fromPath.concat(standardDirs(platform, env, homedir)))];
}

function parseNgrokVersion(out) {
  const m = String(out || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : '';
}

/** 版本读不出来不算没装：装了但异常时仍返回 installed，版本留空 */
function runNgrokVersion(bin, { spawnImpl = spawn, timeoutMs = VERSION_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child) {
        try {
          child.kill();
        } catch {}
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    try {
      child = spawnImpl(bin, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return finish('');
    }
    let out = '';
    child.stdout && child.stdout.on('data', (d) => (out += String(d)));
    child.stderr && child.stderr.on('data', (d) => (out += String(d)));
    child.on('error', () => finish(''));
    child.on('close', () => finish(out));
  });
}

/**
 * 在应用内检测 ngrok：先扫 PATH，再扫各平台的常见安装目录。
 * 返回 { installed, path, version }；installed=false 时界面上不出现任何 ngrok 入口。
 */
async function findNgrok(opts = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homedir = os.homedir(),
    exists = (p) => fs.existsSync(p),
    stat = (p) => fs.statSync(p),
    spawnImpl = spawn,
    runVersion = runNgrokVersion,
  } = opts;
  const names = platform === 'win32' ? ['ngrok.exe', 'ngrok'] : ['ngrok'];
  const p = pathFor(platform);
  const dirs = opts.dirs || dirCandidates({ platform, env, homedir });
  for (const dir of dirs) {
    for (const name of names) {
      const full = p.join(dir, name);
      try {
        if (!exists(full)) continue;
        if (!stat(full).isFile()) continue;
        const version = parseNgrokVersion(await runVersion(full, { spawnImpl }));
        return { installed: true, path: full, version };
      } catch {
        // 目录没有读权限、文件在扫描瞬间消失：跳过继续找下一个
      }
    }
  }
  return { installed: false, path: '', version: '' };
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('隧道接口返回了无法解析的内容'));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('隧道接口无响应')));
    req.on('error', reject);
  });
}

/** 从 ngrok 的检查接口里挑出对外的 https 地址；按本机端口过滤，避免串到别人的隧道 */
function pickPublicUrl(payload, targetPort) {
  const list = (payload && Array.isArray(payload.tunnels) && payload.tunnels) || [];
  const port = Number(targetPort) > 0 ? String(targetPort) : '';
  return list
    .filter((t) => /^https:\/\//i.test(String((t && t.public_url) || '')))
    .find((t) => !port || new RegExp(`:${port}\\b`).test(String((t.config && t.config.addr) || '')))
    ?.public_url || '';
}

/** 从一行 ngrok 日志（JSON 或 key=value）里取公网地址 */
function urlFromLogLine(line) {
  const text = String(line || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      return '';
    }
    if (!obj || obj.msg !== 'started tunnel') return '';
    const direct = (obj.obj && obj.obj.url) || obj.url || '';
    return /^https:\/\//i.test(String(direct)) ? String(direct) : '';
  }
  const m = text.match(/url=(https:\/\/[^\s]+)/i);
  return m ? m[1] : '';
}

/** 检查接口实际监听端口：ngrok 发现 4040 被占时会自己顺延，顺延结果写在日志里 */
function webPortFromLogLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return '';
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return '';
  }
  if (!obj || obj.msg !== 'starting web service') return '';
  const m = String(obj.addr || '').match(/:(\d{1,5})$/);
  return m ? m[1] : '';
}

/**
 * 起一条指向本机 targetPort 的 ngrok 隧道，拿到公网 https 地址后 resolve。
 * 返回 { url, host, pid, stop }；失败时 reject 一条可操作的中文错误。
 */
async function startTunnel(opts = {}) {
  const {
    targetPort,
    ngrokPath,
    spawnImpl = spawn,
    getJsonImpl = getJson,
    waitFor = TUNNEL_WAIT,
    pollMs = TUNNEL_POLL,
    platform = process.platform,
    onExit = null,
  } = opts;
  let apiPort = Number(opts.apiPort) > 0 ? Number(opts.apiPort) : NGROK_API_PORT;
  const port = Number(targetPort) > 0 ? Number(targetPort) : 0;
  if (!port) throw new Error('中继端口不正确');
  const bin = ngrokPath || 'ngrok';
  // ngrok 3.x 的 http 子命令没有 --inspect-addr/--no-browser：检查端口被占时它自己顺延，
  // 也不会弹浏览器，所以这里只要把日志引到 stdout 就能拿到公网地址。
  const args = ['http', String(port), '--log=stdout', '--log-format=json'];
  const domain = normalizeNgrokDomain(opts.domain);
  if (domain) args.push(`--url=${domain}`);

  let child;
  try {
    child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new Error(ngrokErrorText(err.message));
  }
  if (!child || !child.stdout) {
    throw new Error('ngrok 启动失败：这台机器上的 ngrok 无法运行');
  }

  let detail = '';
  let logBuf = '';
  let exited = false;
  let adopted = false; // 已经把公网地址交给调用方了，之后的退出算「意外断开」
  let exitCode = null;
  const append = (buf) => {
    const text = String(buf);
    detail = (detail + text).slice(-4000);
    logBuf += text;
  };
  child.stdout.on('data', append);
  child.stderr && child.stderr.on('data', append);
  child.on('error', (err) => {
    exited = true;
    append(err.message);
  });
  child.on('close', (code) => {
    const wasRunning = adopted;
    exited = true;
    exitCode = code;
    // 已经交付给调用方的隧道再退出，要通知一声，否则界面会停在「运行中」
    if (wasRunning && onExit) {
      try {
        onExit(ngrokErrorText(detail || `ngrok 退出（code=${code}）`));
      } catch {}
    }
  });

  const stop = () => {
    if (exited) return;
    try {
      // Windows 上 child.kill() 走 TerminateProcess，信号名反而无效
      child.kill(platform === 'win32' ? undefined : 'SIGTERM');
    } catch {}
  };

  const adopt = (url) => ({
    url,
    host: String(url).replace(/^https:\/\//i, '').split('/')[0],
    pid: child.pid,
    stop,
  });

  const markAdopted = (url) => {
    adopted = true;
    return adopt(url);
  };

  const deadline = Date.now() + waitFor;
  for (;;) {
    // 公网地址以自家子进程的日志为准（检查接口可能被别的 ngrok 占着）
    const lines = logBuf.split('\n');
    logBuf = lines.pop() || '';
    let url = '';
    for (const line of lines) {
      if (!url) url = urlFromLogLine(line);
      const seen = webPortFromLogLine(line);
      if (seen) apiPort = seen;
    }
    if (url) return markAdopted(url);
    if (exited) break;
    try {
      const payload = await getJsonImpl(`http://127.0.0.1:${apiPort}/api/tunnels`);
      const fallback = pickPublicUrl(payload, port);
      if (fallback) return markAdopted(fallback);
    } catch {
      // 隧道进程刚起来的半秒里检查接口还没就绪，继续等
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  stop();
  throw new Error(
    exited
      ? ngrokErrorText(detail || `ngrok 退出（code=${exitCode}）`)
      : ngrokErrorText(detail || '等待 ngrok 分配公网地址超时，请确认这台机器能访问外网')
  );
}

module.exports = {
  AUTHTOKEN_HINT,
  NGROK_API_PORT,
  TUNNEL_WAIT,
  VERSION_TIMEOUT,
  findNgrok,
  dirCandidates,
  standardDirs,
  parseNgrokVersion,
  ngrokErrorText,
  normalizeNgrokDomain,
  pickPublicUrl,
  urlFromLogLine,
  webPortFromLogLine,
  getJson,
  startTunnel,
};
