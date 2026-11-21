// 中继的运行时无关部分：把 pairing.js 的配对状态机接到一个 node:http 服务器上。
// node-server.js（自建）和 api/room.js（Vercel）都复用这一份，避免两处逻辑漂移。
import { WebSocketServer } from 'ws';
import { Relay, parseRelayPath, relayJoin } from './pairing.js';

const PING_INTERVAL = 25_000; // 小于常见 60~100 秒空闲断连阈值
const MAX_FRAME = 1024 * 1024; // 应用层分片 256 KB，这里留足余量

function toBuffer(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/**
 * 在已有 http 服务器上挂出 /room/:code 与 /health。
 * 返回 { relay, wss, close }，close 只断连接、不关调用方的 server。
 */
export function attachRelay(server, { relay = new Relay() } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // 调用方自己挂了 request 处理就不抢它的；Vercel 的导出形态也是 http.Server
  if (!server.listenerCount('request')) {
    server.on('request', (req, res) => {
      if (String(req.url || '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...relay.stats() }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('SkyDrop relay\n');
    });
  }

  wss.on('connection', (ws, req) => {
    const { room, role } = parseRelayPath(req.url);
    const ctx = {
      send: (data, isBinary) => {
        if (ws.readyState !== 1) return;
        ws.send(toBuffer(data), { binary: Boolean(isBinary) });
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
      },
    };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      relay.message(ctx, toBuffer(data), isBinary);
    });
    ws.on('close', () => relay.leave(ctx));
    ws.on('error', () => relay.leave(ctx));

    relayJoin(relay, { room, role, socket: ctx });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL);
  timer.unref?.();

  return {
    relay,
    wss,
    stats: () => relay.stats(),
    close: () =>
      new Promise((done) => {
        clearInterval(timer);
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch {}
        }
        wss.close(() => done());
      }),
  };
}
