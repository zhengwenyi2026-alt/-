// Cloudflare 版中继：一个房间码对应一个 Durable Object，配对关系写进 WebSocket 附件。
//
// 为什么要用 Durable Object：普通 Worker 每条请求都是全新隔离环境，两份连接之间
// 没法保存「谁和谁配对了」。DO 按房间码分片（idFromName(code)），同一个房间的所有
// 连接必然落到同一个实例上，跨网段的两台设备才能在这里握手。
//
// 又因为 DO 会在空闲时休眠（内存状态清空、连接由平台代管），所以每条连接的
// {id, 房间码, 角色, 对端 id} 都序列化在 WebSocket 附件里，唤醒后按附件重建登记表。
// 附件上限 16 KB，我们这几个字段远够用。
import { RELAY_PROTO, Relay, parseRelayPath, relayJoin } from '../pairing.js';

const MAX_WAITING = 16;

function readAttachment(ws) {
  try {
    return ws.deserializeAttachment() || null;
  } catch {
    return null;
  }
}

export class SkyDropRelayRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.relay = new Relay({ maxRooms: 4, maxWaitingPerRoom: MAX_WAITING });
    this.byId = new Map(); // id -> { id, code, role, peerId, ws, ctx }
    this.byCtx = new Map(); // ctx -> rec（Relay 只认 ctx 对象）
    this.loaded = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const { room, role } = parseRelayPath(`${url.pathname}${url.search}`);
    if (!room) return json({ ok: false, error: 'bad-room' }, 400);
    if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ ok: false, error: 'expected-websocket' }, 426);
    }

    this._load();
    const [client, server] = Object.values(new WebSocketPair());
    // accept 之后连接就交给平台代管，即使本实例被回收也不会断
    this.ctx.acceptWebSocket(server);
    const rec = this._restore(server, { id: crypto.randomUUID(), code: room, role, peer: '' });
    this._persist(rec);

    // 握手登记放在 waitUntil 里：DO 单线程，_settle 内部又是同步逻辑，
    // 多条连接同时进来不会把同一个等待槽配给两个访客。
    this.ctx.waitUntil(this._settle(rec));
    return new Response(null, { status: 101, webSocket: client });
  }

  async _settle(rec) {
    if (!this.byId.has(rec.id)) return;
    const failed = relayJoin(this.relay, { room: rec.code, role: rec.role, socket: rec.ctx });
    if (failed) {
      this._forget(rec);
      return;
    }
    const peerCtx = this.relay.peerOf(rec.ctx);
    if (!peerCtx) return;
    const peer = this.byCtx.get(peerCtx);
    if (!peer) return;
    rec.peerId = peer.id;
    peer.peerId = rec.id;
    this._persist(rec);
    this._persist(peer);
  }

  /** 休眠唤醒后内存是空的，先用附件把还活着的连接重建出来 */
  _load() {
    if (this.loaded) return;
    this.loaded = true;
    for (const ws of this.ctx.getWebSockets()) {
      const att = readAttachment(ws);
      if (!att || !att.id || this.byId.has(att.id)) continue;
      this._restore(ws, att);
    }
    const settled = new Set();
    for (const rec of this.byId.values()) {
      if (settled.has(rec.id)) continue;
      const peer = rec.peerId ? this.byId.get(rec.peerId) : null;
      if (peer) {
        this.relay.restorePair(rec.code, rec.ctx, peer.ctx);
        settled.add(rec.id);
        settled.add(peer.id);
      } else if (rec.role === 'host') {
        // 房主预开的槽：继续排队等访客，客户端那边的槽位池感觉不到这次休眠
        this.relay.restoreWaiting(rec.code, rec.ctx);
        settled.add(rec.id);
      } else {
        // 访客的对端已经不在了，关掉自己让对方重连
        rec.ctx.close(1000, 'peer-left');
        this._forget(rec);
      }
    }
  }

  _restore(ws, att) {
    const rec = { id: att.id, code: att.code || '', role: att.role || 'guest', peerId: att.peer || '', ws, ctx: null };
    rec.ctx = {
      send: (data) => {
        try {
          rec.ws.send(data);
        } catch {}
      },
      close: (code, reason) => {
        try {
          rec.ws.close(code, reason);
        } catch {}
      },
    };
    this.byId.set(rec.id, rec);
    this.byCtx.set(rec.ctx, rec);
    return rec;
  }

  _persist(rec) {
    try {
      rec.ws.serializeAttachment({ id: rec.id, code: rec.code, role: rec.role, peer: rec.peerId });
    } catch {}
  }

  /** 平台回调里的 ws 未必是当初 accept 的那个对象，一律按附件里的 id 找 */
  _rec(ws) {
    const att = readAttachment(ws);
    let rec = att && att.id ? this.byId.get(att.id) : null;
    if (!rec) {
      for (const r of this.byId.values()) {
        if (r.ws === ws) {
          rec = r;
          break;
        }
      }
    }
    if (rec) rec.ws = ws;
    return rec || null;
  }

  _forget(rec) {
    this.byId.delete(rec.id);
    this.byCtx.delete(rec.ctx);
  }

  async webSocketMessage(ws, message) {
    this._load();
    const rec = this._rec(ws);
    if (!rec) return;
    // 文本/二进制原样转发：上层 ws 协议感觉不到中间隔了一层中继
    this.relay.message(rec.ctx, message, typeof message !== 'string');
  }

  async webSocketClose(ws) {
    this._load();
    const rec = this._rec(ws);
    if (!rec) return;
    this._forget(rec);
    // leave() 会顺手关掉对端，两边都能立刻看到「对方已断开」
    this.relay.leave(rec.ctx);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, runtime: 'cloudflare-durable-object', proto: RELAY_PROTO });
    }
    const { room } = parseRelayPath(`${url.pathname}${url.search}`);
    if (!room) {
      // 路径像是冲着房间来的，就直接说房间码不对；否则当成访客浏览，给一句部署成功提示
      const wantsRoom = /\/(?:api\/)?room\//i.test(url.pathname) || url.searchParams.has('room');
      if (wantsRoom) return json({ ok: false, error: 'bad-room' }, 400);
      return new Response(`SkyDrop 中继已就绪。客户端「跨网传输」里填 ${url.host} 即可。\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (!env.SKYDROP_ROOM) return json({ ok: false, error: 'durable-object-unbound' }, 500);
    // 同一房间码 → 同一实例，这是跨网配对能成立的关键
    return env.SKYDROP_ROOM.get(env.SKYDROP_ROOM.idFromName(room)).fetch(request);
  },
};
