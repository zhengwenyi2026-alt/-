// 房间配对状态机：与具体运行时无关，Node / Cloudflare Worker / Vercel 三种适配层共用一份。
//
// 语义：
//   role=host   房主预开的「监听槽」，先进入 waiting 队列挂着
//   role=guest  访客，命中一个 waiting 槽就配对成功，没有就直接 no-host 关闭
// 配对之后中继只做字节搬运（保留文本/二进制类型），上层 ws 协议完全不知道自己在中继后面。

export const RELAY_PROTO = 1;

const ROOM_RE = /^[A-Z0-9]{6}$/;

export function normalizeRoom(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOM_RE.test(code) ? code : '';
}

// 中继自己只在连接建立阶段说这几句话，之后全是字节搬运。
// 三种运行时（Node / Vercel / Cloudflare）共用同一组帧格式，客户端只认这一种。
export function helloFrame(code, state) {
  return { t: 'hello-ack', proto: RELAY_PROTO, room: code, state };
}

export function pairedFrame(code, peer) {
  return { t: 'paired', proto: RELAY_PROTO, room: code, peer };
}

export function errorFrame(code) {
  return { t: 'error', code };
}

function sendJson(socket, obj) {
  socket.send(JSON.stringify(obj), false);
}

/**
 * socket 约定：`send(data, isBinary)` 与 `close(code, reason)`。
 * Node 的 ws 与 Cloudflare 的 WebSocket 都用这一层薄封装适配。
 */
export class Relay {
  constructor({ maxRooms = 256, maxPairsPerRoom = 8, maxWaitingPerRoom = 16 } = {}) {
    this.maxRooms = maxRooms;
    this.maxPairsPerRoom = maxPairsPerRoom;
    this.maxWaitingPerRoom = maxWaitingPerRoom;
    this.rooms = new Map(); // code -> { waiting: Set, pairs: Map<socket, pair> }
    this.owner = new Map(); // socket -> { code, pair }
  }

  _room(code) {
    let entry = this.rooms.get(code);
    if (!entry) {
      if (this.rooms.size >= this.maxRooms) this._gc();
      if (this.rooms.size >= this.maxRooms) return null;
      entry = { waiting: new Set(), pairs: new Map() };
      this.rooms.set(code, entry);
    }
    return entry;
  }

  _gc() {
    for (const [code, entry] of this.rooms) {
      if (!entry.waiting.size && !entry.pairs.size) this.rooms.delete(code);
    }
  }

  /** 返回 'waiting' | 'paired' | 错误码字符串 */
  join({ room, role, socket }) {
    const code = normalizeRoom(room);
    if (!code) return 'bad-room';
    if (role !== 'host' && role !== 'guest') return 'bad-role';

    if (role === 'host') {
      const entry = this._room(code);
      if (!entry) return 'room-limit';
      if (entry.waiting.size >= this.maxWaitingPerRoom) return 'slot-limit';
      entry.waiting.add(socket);
      this.owner.set(socket, { code });
      sendJson(socket, helloFrame(code, 'waiting'));
      return 'waiting';
    }

    // 访客不创建房间条目，否则无人值守的尝试会留下越来越多空壳
    const entry = this.rooms.get(code);
    const host = entry && entry.waiting.values().next().value;
    if (!host) return 'no-host';
    entry.waiting.delete(host);
    const pair = { a: host, b: socket };
    entry.pairs.set(host, pair);
    entry.pairs.set(socket, pair);
    this.owner.set(host, { code, pair });
    this.owner.set(socket, { code, pair });
    sendJson(host, pairedFrame(code, 'guest'));
    sendJson(socket, pairedFrame(code, 'host'));
    return 'paired';
  }

  /**
   * Cloudflare Durable Object 唤醒后重建「等待槽」，不发控制帧
   * （连接还活着，只是内存里的登记表被回收了）。
   */
  restoreWaiting(room, socket) {
    const code = normalizeRoom(room);
    const entry = code && this._room(code);
    if (!entry || entry.waiting.has(socket)) return false;
    entry.waiting.add(socket);
    this.owner.set(socket, { code });
    return true;
  }

  /** 同上，重建一条已配对的连接；两端都要还活着才恢复 */
  restorePair(room, socket, peer) {
    const code = normalizeRoom(room);
    if (!code || !peer) return false;
    // 唤醒时 Relay 是全新的，房间条目也要跟着重建
    const entry = this._room(code);
    if (!entry) return false;
    const pair = { a: socket, b: peer };
    entry.waiting.delete(socket);
    entry.waiting.delete(peer);
    entry.pairs.set(socket, pair);
    entry.pairs.set(peer, pair);
    this.owner.set(socket, { code, pair });
    this.owner.set(peer, { code, pair });
    return true;
  }

  /** 配对后的数据帧转发；未配对时一律丢弃（控制帧只在 join 里发过） */
  message(socket, data, isBinary) {
    const info = this.owner.get(socket);
    const pair = info && info.pair;
    if (!pair) return false;
    const target = pair.a === socket ? pair.b : pair.a;
    target.send(data, Boolean(isBinary));
    return true;
  }

  /** 取对端的 socket 封装，配对成功后用（Cloudflare 要把它写进连接附件） */
  peerOf(socket) {
    const info = this.owner.get(socket);
    const pair = info && info.pair;
    if (!pair) return null;
    return pair.a === socket ? pair.b : pair.a;
  }

  leave(socket) {
    const info = this.owner.get(socket);
    if (!info) return;
    this.owner.delete(socket);
    const entry = this.rooms.get(info.code);
    if (!entry) return;
    entry.waiting.delete(socket);
    if (info.pair) {
      entry.pairs.delete(socket);
      const other = info.pair.a === socket ? info.pair.b : info.pair.a;
      entry.pairs.delete(other);
      this.owner.delete(other);
      try {
        other.close(1000, 'peer-left');
      } catch {}
    }
    if (!entry.waiting.size && !entry.pairs.size) this.rooms.delete(info.code);
  }

  stats() {
    let waiting = 0;
    let pairs = 0;
    for (const entry of this.rooms.values()) {
      waiting += entry.waiting.size;
      pairs += entry.pairs.size / 2;
    }
    return { rooms: this.rooms.size, waiting, pairs };
  }
}

/**
 * 从请求 URL 里取房间码与角色，兼容 /room/ABC123 与 /api/room/ABC123。
 * 房间码同时允许放在 query（?room=ABC123）：Vercel 的 rewrite 会把路径改写成
 * 固定函数名，只有 query 能原样带过去，所以两条路都要认。
 */
export function parseRelayPath(url) {
  const path = String(url || '').split('?')[0];
  const query = new URLSearchParams(String(url).split('?')[1] || '');
  const m = /\/(?:api\/)?room\/([^/?]+)/i.exec(path);
  const fromPath = m ? normalizeRoom(m[1]) : '';
  const room = fromPath || normalizeRoom(query.get('room'));
  if (!room) return { room: '', role: '' };
  return { room, role: String(query.get('role') || 'guest').toLowerCase() };
}

/**
 * 三种运行时共用的「接入一条新连接」：成功返回 null，
 * 失败时把错误帧交给 socket 并关闭它（closeReason 给适配层记日志）。
 */
export function relayJoin(relay, { room, role, socket }) {
  const result = relay.join({ room, role, socket });
  if (result === 'waiting' || result === 'paired') return null;
  sendJson(socket, errorFrame(result));
  socket.close(1008, result);
  return result;
}

export { ROOM_RE };
