'use strict';

const WebSocket = require('ws');
const { CHUNK_SIZE } = require('./protocol');

// 房主侧预开的「监听槽」数量：每来一个访客消耗一个槽，立刻补一个，
// 这样房主不需要知道什么时候有人来，也不需要中继支持反向拨号。
const RELAY_SLOTS = 3;
const RELAY_BACKOFF = [1000, 2000, 4000, 8000, 15000];
const HANDSHAKE_TIMEOUT = 8000;
const PAIR_TIMEOUT = 20000;
// Cloudflare 大约 100 秒无流量就掐掉 WebSocket，而「等对方点接收」经常更久，
// 所以每条中继连接都定时发 ping 帧（中继只需回 pong，不必理解应用协议）。
const RELAY_PING = 25_000;

/** 给一条连接挂上 keepalive，连接关闭时自动撤掉 */
function keepAlive(ws) {
  const timer = setInterval(() => {
    try {
      ws.ping();
    } catch {}
  }, RELAY_PING);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  ws.once('close', stop);
  ws.once('error', stop);
  return stop;
}

const PROVIDER_PATH = { cloudflare: '', vercel: '/api', custom: '' };
const RELAY_PROVIDERS = ['cloudflare', 'vercel', 'custom'];

// 中继回的错误码 → 中文原文（渲染层再查词典）
const RELAY_ERRORS = {
  'no-host': '中继上没有这个房间，请确认对方已开启「跨网传输」并创建房间',
  'bad-room': '房间码格式不正确',
  'bad-role': '中继角色参数不正确',
  'room-limit': '中继上的房间数量已达上限',
  'slot-limit': '中继上该房间的等待槽已满',
};

function relayErrorText(code) {
  return RELAY_ERRORS[String(code)] || `中继返回错误：${code}`;
}

/**
 * 把用户输入统一成可拨号的地址。允许：
 *   skydrop-relay.xxx.workers.dev
 *   https://skydrop-relay.vercel.app
 *   wss://1.2.3.4:8790/relay
 *   ws://127.0.0.1:8790          （本地自建中继 / 自动化测试）
 * 已经填了完整 /room/CODE 的也接受，会截掉尾部。
 * provider 决定缺省路由前缀（Vercel 的函数挂在 /api 下），地址命中
 * *.vercel.app 时忽略 provider，避免服务商选错就完全连不上。
 */
function parseRelayBase(input, provider = 'cloudflare') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请填写中继地址');
  const looksLocal = /^(localhost|127\.0\.0\.1|::1|\[::1\])(:\d+)?([/?].*)?$/i.test(raw) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?].*)?$/.test(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${looksLocal ? 'ws' : 'wss'}://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('中继地址格式不正确');
  }
  const proto = url.protocol.toLowerCase();
  const secure = proto === 'https:' || proto === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(proto)) throw new Error('中继地址只支持 http/https/ws/wss');
  if (!url.hostname) throw new Error('中继地址格式不正确');
  // 服务商选错但地址粘对的情况很常见：*.vercel.app 一律按 Vercel 的路由前缀处理
  const named = RELAY_PROVIDERS.includes(provider) ? provider : 'cloudflare';
  const effective = /\.vercel\.app$/i.test(url.hostname) ? 'vercel' : named;
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/room\/[^/?]+$/i, ''); // 允许直接粘贴完整拨号串
  if (!pathname) pathname = PROVIDER_PATH[effective] ?? '';
  return { secure, host: url.host, prefix: pathname === '/' ? '' : pathname };
}

function relaySocketUrl(input, code, role, provider) {
  const base = parseRelayBase(input, provider);
  const scheme = base.secure ? 'wss' : 'ws';
  // 房间码写两遍：路径给 Cloudflare / 自建中继，query 给会被 rewrite 改路径的 Vercel
  return `${scheme}://${base.host}${base.prefix}/room/${encodeURIComponent(code)}?role=${role}&room=${encodeURIComponent(code)}`;
}

function readBase(url) {
  const i = String(url).indexOf('://');
  return i > 0 ? String(url).slice(i + 3).split('/')[0] : String(url);
}

/** 打开一条连接并等中继回 paired；用于访客侧 */
function dialRelay({ input, code, role, provider = 'cloudflare', timeoutMs = PAIR_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    const url = relaySocketUrl(input, code, role, provider);
    const ws = new WebSocket(url, { maxPayload: CHUNK_SIZE + 4096, handshakeTimeout: HANDSHAKE_TIMEOUT });
    keepAlive(ws);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      finish(reject, new Error(role === 'host' ? '中继连接超时' : '中继配对超时，请确认地址可用'));
    }, timeoutMs);
    ws.on('message', (data, isBinary) => {
      if (isBinary || settled) return;
      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'paired') finish(resolve, ws);
      else if (msg.t === 'error') finish(reject, new Error(relayErrorText(msg.code)));
    });
    ws.on('error', (err) => finish(reject, new Error(err.message ? `中继连接失败：${err.message}` : '中继连接失败')));
    ws.on('close', () => finish(reject, new Error('中继断开了连接')));
  });
}

/**
 * 房主侧槽位池：保持 n 条 role=host 连接挂在房间码上，
 * 每条一旦被配对就交给 onSocket，并马上补一条新的。
 */
function openRelaySlots({ input, code, provider = 'cloudflare', slots = RELAY_SLOTS, onSocket, onStatus }) {
  const base = parseRelayBase(input, provider);
  const url = relaySocketUrl(input, code, 'host', provider);
  let stopped = false;
  let active = 0;
  let failures = 0;
  const live = new Set();
  const timers = new Set();

  const report = (status, error) => {
    if (onStatus) onStatus({ status, error: error || '', endpoints: active, host: readBase(url) });
  };

  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timers.add(timer);
  };

  const fill = () => {
    while (!stopped && active + timers.size < slots) open();
  };

  const open = () => {
    if (stopped || active >= slots) return;
    active += 1;
    const entry = { ws: null };
    let paired = false;
    // 只有还挂在队列里的槽才算数：配对成功的槽当场移交并补位，之后它的关闭不再影响池子
    const drop = () => {
      if (!live.has(entry)) return;
      live.delete(entry);
      active = Math.max(0, active - 1);
      if (stopped) return;
      failures += 1;
      const backoff = RELAY_BACKOFF[Math.min(failures - 1, RELAY_BACKOFF.length - 1)];
      if (failures === 1 || failures % 5 === 0) report('retrying', '中继连接中断，正在重试');
      later(open, backoff);
    };
    try {
      entry.ws = new WebSocket(url, { maxPayload: CHUNK_SIZE + 4096, handshakeTimeout: HANDSHAKE_TIMEOUT });
    } catch (err) {
      drop();
      report('error', err.message);
      return;
    }
    const ws = entry.ws;
    keepAlive(ws);
    live.add(entry);
    ws.on('open', () => {
      failures = 0;
      report(active >= slots ? 'ready' : 'connecting');
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary || paired) return;
      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || msg.t !== 'paired') return;
      paired = true;
      if (live.has(entry)) {
        live.delete(entry);
        active = Math.max(0, active - 1);
      }
      fill();
      if (onSocket) onSocket(ws, { host: readBase(url) });
    });
    ws.on('close', drop);
    ws.on('error', () => {});
  };

  report('connecting');
  fill();

  return {
    host: readBase(url),
    slots,
    get endpoints() {
      return active;
    },
    close() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of live) {
        try {
          entry.ws.close();
        } catch {}
      }
      live.clear();
      active = 0;
    },
  };
}

/**
 * 连通性探测：拿一个随机房间码挂一个 host 槽，收到中继的 hello-ack 就算通，
 * 立刻断开。用于界面上的「测试连接」按钮。
 */
function probeRelay({ input, provider = 'cloudflare', code, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const url = relaySocketUrl(input, code, 'host', provider);
    const base = parseRelayBase(input, provider);
    const ws = new WebSocket(url, { maxPayload: 65536, handshakeTimeout: timeoutMs });
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('中继响应超时')), timeoutMs);
    ws.on('message', (data, isBinary) => {
      if (isBinary || settled) return;
      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'hello-ack' || msg.t === 'paired') finish(resolve, { host: base.host, secure: base.secure });
      else if (msg.t === 'error') finish(reject, new Error(relayErrorText(msg.code)));
    });
    ws.on('error', (err) => finish(reject, new Error(`连不上中继：${err.message}`)));
    ws.on('close', () => finish(reject, new Error('中继断开了连接')));
  });
}

module.exports = {
  RELAY_SLOTS,
  RELAY_PROVIDERS,
  parseRelayBase,
  relaySocketUrl,
  relayErrorText,
  dialRelay,
  openRelaySlots,
  probeRelay,
  readBase,
};
