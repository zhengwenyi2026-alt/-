'use strict';

/**
 * 本机传输面板：把 Hub 的状态快照用一个纯 HTML 页面呈现出来，浏览器打开
 * http://localhost:<端口>/ 就能看到实时传输详情（进度、速率、文件级明细、历史）。
 *
 * 房间的数据端口绑定的是 0.0.0.0（局域网里的设备要连它），所以这里必须做两层判断：
 * 来源地址是回环 + Host 头是本机名字。缺任何一层，同网段的机器或一个 DNS 重绑定
 * 网页就能读到本机传过的文件名与保存路径。非本机请求一律走原来的 404 'SkyDrop'，
 * 加了面板之后局域网侧的行为和之前完全一致。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const { PROTO_VERSION, CHUNK_SIZE, HEADER_SIZE, MAX_FILES_PER_OFFER, MAX_TEXT_BYTES } = require('./protocol');
const { SEND_PIPELINE } = require('./peer');
const { RELAY_SLOTS, RELAY_BACKOFF, PAIR_TIMEOUT, RELAY_PING } = require('./relay');
const { ALPHABET, CODE_LENGTH } = require('./roomCode');

const PANEL_BASE_PORT = 47830; // 常驻面板端口，与房间数据端口分开，房间没开也能看
const PANEL_PORT_SPAN = 13;
const I18N_FILE = path.join(__dirname, '..', '..', 'common', 'i18n.js');
const PANEL_FILE = path.join(__dirname, 'panel.js');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 只有真正的回环来源才给面板：127.0.0.0/8 与 ::1（含 IPv4 映射写法） */
function isLoopbackAddress(addr) {
  const s = String(addr || '').replace(/^::ffff:/i, '').toLowerCase();
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  return /^127\./.test(s);
}

/** Host 头必须是本机名字，挡住「域名解析到 127.0.0.1 的第三方网页」跨源读取 */
function isLocalHostHeader(host) {
  const raw = String(host || '').toLowerCase();
  if (!raw) return false;
  const bracketed = raw.match(/^\[([^\]]*)\](?::\d+)?$/);
  const bare = bracketed ? bracketed[1] : raw.split(':')[0];
  return LOOPBACK_HOSTS.has(bare);
}

function sendText(res, code, type, body, extra = {}) {
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
  res.writeHead(code, headers);
  res.end(body);
}

let i18nCache = { mtime: 0, text: '' };
function readI18n() {
  try {
    const st = fs.statSync(I18N_FILE);
    if (st.mtimeMs !== i18nCache.mtime) i18nCache = { mtime: st.mtimeMs, text: fs.readFileSync(I18N_FILE, 'utf8') };
  } catch {
    return '';
  }
  return i18nCache.text;
}

/** 累计统计：历史里是已完成的任务，offers 里是正在进行或刚结束的 */
function totalsOf(hub) {
  const t = {
    transfers: 0, ok: 0, failed: 0, declined: 0,
    sentBytes: 0, recvBytes: 0, sentFiles: 0, recvFiles: 0,
    peakRate: 0, active: 0, activeBytes: 0, activeSize: 0,
  };
  for (const h of hub.history) {
    t.transfers += 1;
    const files = Array.isArray(h.files) ? h.files.length : 0;
    if (h.state === 'done') t.ok += 1;
    else if (h.state === 'declined') t.declined += 1;
    else t.failed += 1;
    if (h.dir === 'out') {
      t.sentBytes += Number(h.totalSize) || 0;
      t.sentFiles += files;
    } else {
      t.recvBytes += Number(h.totalSize) || 0;
      t.recvFiles += files;
    }
  }
  for (const o of hub.offers.values()) {
    t.peakRate = Math.max(t.peakRate, Number(o.rate) || 0);
    if (o.state === 'transfer' || o.state === 'accepted' || o.state === 'pending') {
      t.active += 1;
      t.activeBytes += Number(o.bytes) || 0;
      t.activeSize += Number(o.totalSize) || 0;
    }
  }
  // offers 只留在传的任务，历史任务的速度靠 hub.peakRate 记住
  t.peakRate = Math.max(t.peakRate, Number(hub.peakRate) || 0);
  return t;
}

/** 面板拿到的一份完整快照：状态 + 统计 + 协议参数，全部是可 JSON 化的原始数字 */
function snapshot(hub, limits) {
  const st = hub.state();
  return {
    ok: true,
    at: Date.now(),
    app: {
      version: limits.version || '',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron || 'dev',
      hostname: os.hostname(),
      startedAt: hub.startedAt || Date.now(),
      uptimeMs: Math.max(0, Date.now() - (hub.startedAt || Date.now())),
    },
    self: st.self,
    language: st.settings.language,
    panel: hub.panel ? { port: hub.panel.port, url: hub.panel.url } : null,
    room: st.room,
    joined: st.joined,
    outgoing: st.outgoing,
    relay: st.relay,
    peers: st.peers,
    joinRequests: st.joinRequests,
    offers: st.offers,
    history: st.history,
    texts: st.texts,
    visible: st.visible,
    settings: st.settings,
    totals: totalsOf(hub),
    limits: {
      proto: PROTO_VERSION,
      chunkSize: CHUNK_SIZE,
      headerSize: HEADER_SIZE,
      maxFilesPerOffer: MAX_FILES_PER_OFFER,
      textMaxBytes: MAX_TEXT_BYTES,
      sendPipeline: SEND_PIPELINE,
      maxPeers: limits.maxPeers,
      codeLength: CODE_LENGTH,
      codeAlphabetSize: ALPHABET.length,
      maxBadCodes: limits.maxBadCodes,
      historyKeep: limits.historyKeep,
      udpPort: limits.udpPort,
      tcpBasePort: limits.tcpBasePort,
      tcpPortSpan: limits.tcpPortSpan,
      panelBasePort: PANEL_BASE_PORT,
      relaySlots: RELAY_SLOTS,
      relayPingMs: RELAY_PING,
      pairTimeoutMs: PAIR_TIMEOUT,
      relayBackoff: RELAY_BACKOFF,
    },
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>SkyDrop 传输面板</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f1a; --card:#141a2b; --line:#232c44; --fg:#e8ecf7; --dim:#8e9ab8;
          --ok:#35d07f; --warn:#f5b73d; --err:#ff6b6b; --acc:#5b8cff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 20px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:18px; }
  h1 { font-size:20px; margin:0; letter-spacing:.3px; }
  h2 { font-size:14px; margin:0 0 12px; color:var(--dim); font-weight:600; letter-spacing:.4px; }
  .sp { flex:1 1 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
  .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  select, button { background:#1b2338; color:var(--fg); border:1px solid var(--line); border-radius:9px;
                   padding:6px 11px; font:inherit; cursor:pointer; }
  button:hover, select:hover { border-color:var(--acc); }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; border:1px solid var(--line);
          font-size:12px; color:var(--dim); }
  .pill.ok { color:var(--ok); border-color:#1d5c3c; }
  .pill.warn { color:var(--warn); border-color:#6b5320; }
  .pill.err { color:var(--err); border-color:#6b2626; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px 18px; }
  .kv { min-width:0; }
  .kv b { display:block; font-size:12px; color:var(--dim); font-weight:500; margin-bottom:2px; }
  .kv span { word-break:break-all; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--dim); font-weight:500; padding:6px 10px 6px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:7px 10px 7px 0; border-bottom:1px solid #1a2136; vertical-align:top; word-break:break-all; }
  tr:last-child td { border-bottom:0; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
  .track { background:#1b2338; border-radius:6px; height:8px; min-width:110px; overflow:hidden; }
  .fill { background:linear-gradient(90deg,var(--acc),#7ae0ff); height:100%; width:0; transition:width .35s; }
  .empty { color:var(--dim); font-style:italic; }
  .task { background:#111827; border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  .task .track { margin:12px 0 10px; }
  .card h2 + h2 { margin-top:16px; }
  footer { color:var(--dim); font-size:12px; margin-top:22px; text-align:center; }
  a { color:var(--acc); }
  @media (max-width:640px){ body{padding:14px 12px 40px} .grid{grid-template-columns:1fr 1fr} }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="pageTitle">SkyDrop</h1>
    <span class="sp"></span>
    <label class="pill" for="langSel" id="langLabel">语言</label>
    <select id="langSel" aria-label="语言"></select>
    <button id="pauseBtn" type="button"></button>
  </header>
  <main id="app"><div class="card"><span class="empty">加载中…</span></div></main>
  <footer id="foot"></footer>
</div>
<script src="/i18n.js"></script>
<script src="/panel.js"></script>
</body>
</html>`;

/**
 * @param hub Hub 实例
 * @param limits { version, maxPeers, maxBadCodes, historyKeep, udpPort, tcpBasePort, tcpPortSpan }
 */
function dashboardHandler(hub, limits = {}) {
  return (req, res) => {
    let p;
    try {
      p = new URL(req.url || '/', 'http://localhost/').pathname;
    } catch {
      return sendText(res, 400, 'text/plain; charset=utf-8', 'bad request');
    }
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      !isLoopbackAddress(req.socket.remoteAddress) ||
      !isLocalHostHeader(req.headers.host)
    ) {
      // 与加面板之前一模一样：局域网里的设备只会看到一个没有内容的 404
      return sendText(res, 404, 'text/plain; charset=utf-8', 'SkyDrop');
    }
    if (p === '/' || p === '/index.html') {
      return sendText(res, 200, 'text/html; charset=utf-8', PAGE, {
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
    }
    if (p === '/panel.js') {
      try {
        return sendText(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(PANEL_FILE, 'utf8'));
      } catch {
        return sendText(res, 500, 'text/plain; charset=utf-8', 'panel.js missing');
      }
    }
    if (p === '/i18n.js') {
      const text = readI18n();
      if (!text) return sendText(res, 500, 'text/plain; charset=utf-8', 'i18n missing');
      return sendText(res, 200, 'text/javascript; charset=utf-8', text);
    }
    if (p === '/api/state') {
      let body = '{}';
      try {
        body = JSON.stringify(snapshot(hub, limits));
      } catch (err) {
        return sendText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(err && err.message) }));
      }
      return sendText(res, 200, 'application/json; charset=utf-8', body);
    }
    if (p === '/favicon.ico') return sendText(res, 204, 'text/plain; charset=utf-8', '');
    return sendText(res, 404, 'text/plain; charset=utf-8', 'SkyDrop');
  }
}

/** 常驻面板服务：只绑 127.0.0.1，房间没开也一直在，端口被占就顺延 */
function startPanelServer(hub, limits = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const handler = dashboardHandler(hub, limits);
    const tryNext = () => {
      const port = PANEL_BASE_PORT + attempt;
      const server = http.createServer(handler);
      const onErr = (err) => {
        if (err && err.code === 'EADDRINUSE' && attempt < PANEL_PORT_SPAN - 1) {
          attempt += 1;
          return tryNext();
        }
        resolve(null);
      };
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        server.on('error', () => {});
        resolve({ server, port, url: `http://localhost:${port}/` });
      });
    };
    tryNext();
  });
}

module.exports = {
  dashboardHandler,
  startPanelServer,
  snapshot,
  totalsOf,
  isLoopbackAddress,
  isLocalHostHeader,
  PANEL_BASE_PORT,
  PANEL_PORT_SPAN,
};
