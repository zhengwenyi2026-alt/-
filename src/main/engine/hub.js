'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const { Peer } = require('./peer');
const I18N = require('../../common/i18n');
const { parseRelayBase, dialRelay, openRelaySlots } = require('./relay');
const { CHUNK_SIZE, PROTO_VERSION } = require('./protocol');
const { generateRoomCode, normalizeRoomCode, formatRoomCode } = require('./roomCode');
const { lanInterfaces, broadcastTargets, isPrivateAddress } = require('./net');
const { collectItems } = require('./files');

const TCP_BASE_PORT = 47810; // 房间数据端口，被占用时向后顺延
const UDP_PORT = 47812; // 局域网发现端口（固定，房间码查询走这里）
const MULTICAST_GROUP = '239.255.47.81';
const MAGIC = 'skydrop1';
const MAX_PEERS = 8;
const HELLO_TIMEOUT = 10_000;
const APPROVE_TIMEOUT = 60_000;
const MAX_BAD_CODE_PER_IP = 8;
const RELAY_PROVIDERS = ['cloudflare', 'vercel', 'custom'];

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do {
    x /= 1024;
    i += 1;
  } while (x >= 1024 && i < units.length - 1);
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * 传输中枢：管理本机身份、房间（主机角色）、加入（访客角色）、已连接设备与传输任务，
 * 对外只抛出一份扁平的 UI 事件流 + 一份可序列化的状态快照。
 */
class Hub extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.deviceId = opts.deviceId || crypto.randomUUID();
    this.deviceName = opts.deviceName || os.hostname() || '我的设备';
    this.saveDir = opts.saveDir || path.join(os.homedir(), 'Downloads', 'SkyDrop');
    this.autoAccept = Boolean(opts.autoAccept);
    this.autoApprove = Boolean(opts.autoApprove);
    this.allowPublic = Boolean(opts.allowPublic);
    // 跨网传输：房主在中继上挂若干「监听槽」，访客经同一个中继拨进来
    this.relayEnabled = Boolean(opts.relayEnabled);
    this.relayProvider = RELAY_PROVIDERS.includes(opts.relayProvider) ? opts.relayProvider : 'cloudflare';
    this.relayUrl = String(opts.relayUrl || '').trim().slice(0, 200);
    // 语言只用于界面，引擎本身保持中文原文，由渲染层查词典
    this.language = I18N.isSupported(opts.language) ? opts.language : I18N.DEFAULT_LANG;

    this.room = null; // { code, port, status }
    this.peers = new Map(); // deviceId -> Peer
    this.joinRequests = new Map(); // deviceId -> { peer, name, ip }
    this.offers = new Map(); // offerId -> 传输任务
    this.visible = []; // 扫描到的附近房间
    this.outgoing = null; // 正在进行的加入请求
    this.history = [];

    this._server = null;
    this._wss = null;
    this._udp = null;
    this._badCodes = new Map();
    this._offerSeq = 0;
    this._disposed = false;
    this._localGuestPeer = null; // 访客模式下唯一的外向连接
    this._joinedRoom = null; // 已加入的房间码
    this._pendingGuestWs = null; // 正在握手的出站连接
    this._relay = null; // 房主侧中继槽位池
    this._relayState = { status: 'off', error: '', host: '', endpoints: 0 };
    this._relaySeq = 0; // 给每条中继连接一个独立计数键，避免一个乱试房间码的人连带锁死别人
  }

  // ------------------------------------------------------------ 事件出口

  _emit(event) {
    if (this._disposed) return;
    this.emit('event', event);
  }

  // msg 是词典里的中文原文（可含 {param} 占位），译文由渲染层按当前语言生成，
  // 这样切换语言不需要重启主进程，也不会把语言状态塞进引擎。
  notice(msg, params = null, level = 'info') {
    this._emit({ type: 'notice', level, msg, params: params || undefined, at: Date.now() });
  }

  state() {
    return {
      self: { deviceId: this.deviceId, name: this.deviceName },
      settings: {
        saveDir: this.saveDir,
        autoAccept: this.autoAccept,
        autoApprove: this.autoApprove,
        allowPublic: this.allowPublic,
        relayEnabled: this.relayEnabled,
        relayProvider: this.relayProvider,
        relayUrl: this.relayUrl,
        language: this.language,
        addresses: lanInterfaces().map((i) => ({ name: i.name, address: i.address })),
      },
      room: this.room ? { ...this.room, codeDisplay: formatRoomCode(this.room.code) } : null,
      relay: { ...this._relayState, enabled: this.relayEnabled, provider: this.relayProvider, url: this.relayUrl },
      joined: this._localGuestPeer
        ? {
            room: this._joinedRoom,
            codeDisplay: this._joinedRoom ? formatRoomCode(this._joinedRoom) : '',
            name: this._localGuestPeer.peerName,
            ip: this._localGuestPeer.ip,
            via: this._localGuestPeer.via || 'lan',
          }
        : null,
      outgoing: this.outgoing,
      peers: [...this.peers.values()].map((p) => ({
        deviceId: p.peerDeviceId,
        name: p.peerName,
        ip: p.ip,
        via: p.via || 'lan',
        since: p._since || Date.now(),
      })),
      joinRequests: [...this.joinRequests.entries()].map(([deviceId, r]) => ({ deviceId, name: r.name, ip: r.ip })),
      offers: [...this.offers.values()].map((o) => this._offerView(o)),
      history: this.history,
      visible: this.visible,
    };
  }

  _pushState() {
    this._emit({ type: 'state', state: this.state() });
  }

  // ------------------------------------------------------------ 建房（本机作为主机）

  async startRoom() {
    if (this.room && this.room.status === 'listening') return this.room;
    const code = generateRoomCode();
    const { server, wss, port } = await this._listenTcp();
    this._server = server;
    this._wss = wss;
    wss.on('connection', (ws, req) => this._onIncoming(ws, req));
    const discovery = await this._startUdp(code, port);
    const addrs = lanInterfaces();
    this.room = {
      code,
      port,
      status: 'listening',
      discovery: discovery ? 'ok' : 'unavailable',
      codeDisplay: formatRoomCode(code),
      connectHint: addrs.map((a) => `${a.address}:${port}`).join('、') || `127.0.0.1:${port}`,
      startedAt: Date.now(),
      sent: 0,
      received: 0,
    };
    this._openRelay();
    this.notice(
      discovery ? '房间已开启，房间码 {code}' : '房间已开启，房间码 {code}（自动发现不可用，请在对方界面手动输入地址）',
      { code: formatRoomCode(code) }
    );
    this._pushState();
    return this.room;
  }

  stopRoom() {
    if (!this.room) return;
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    for (const r of this.joinRequests.values()) r.peer.close();
    this.joinRequests.clear();
    try {
      if (this._wss) this._wss.close();
    } catch {}
    try {
      if (this._server) this._server.close();
    } catch {}
    this._wss = null;
    this._server = null;
    this._closeUdp();
    this._closeRelay();
    this.room = null;
    this._badCodes.clear();
    this.notice('房间已关闭', null);
    this._pushState();
  }

  _listenTcp() {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryNext = () => {
        const port = TCP_BASE_PORT + attempt;
        const server = http.createServer((req, res) => {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('SkyDrop');
        });
        const wss = new WebSocket.Server({ noServer: true, maxPayload: CHUNK_SIZE + 4096 });
        server.on('upgrade', (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        });
        const onError = (err) => {
          if (err.code === 'EADDRINUSE' && attempt < 12) {
            attempt += 1;
            tryNext();
            return;
          }
          reject(err);
        };
        server.once('error', onError);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', onError);
          server.on('error', (err) => this.notice('房间服务出错：{msg}', { msg: err.message }, 'error'));
          resolve({ server, wss, port });
        });
      };
      tryNext();
    });
  }

  _onIncoming(ws, req) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    this._attachIncoming(ws, ip, 'lan');
  }

  /**
   * 入站连接统一接线。lan 直连要过私网白名单；中继穿透的连接由中继背书，
   * 只看房间码与房主批准，因此也不参与按 IP 的错误房间码限流（换成按连接计数）。
   */
  _attachIncoming(ws, addr, via = 'lan') {
    const relay = via === 'relay';
    const key = relay ? `relay#${++this._relaySeq}` : addr;
    const shown = relay ? '互联网中继' : addr;
    if (!relay && !this.allowPublic && !isPrivateAddress(addr)) {
      this.notice('已拒绝来自非可信地址 {ip} 的连接', { ip: shown }, 'warn');
      ws.close(1008, 'untrusted network');
      return;
    }
    if ((this._badCodes.get(key) || 0) >= MAX_BAD_CODE_PER_IP) {
      ws.close(1008, 'too many attempts');
      return;
    }
    const full = this.peers.size + this.joinRequests.size >= MAX_PEERS;
    const peer = this._createPeer(ws, relay ? '' : addr, 'host', via);
    const guard = setTimeout(() => {
      if (!peer.peerDeviceId) peer.close();
    }, HELLO_TIMEOUT);

    peer.once('hello', (msg) => {
      clearTimeout(guard);
      if (full) {
        peer.approvePeer({ ok: false, reason: '房间已满' });
        return;
      }
      if (msg.proto !== PROTO_VERSION) {
        peer.approvePeer({ ok: false, reason: '版本不匹配，请双方都更新到最新版' });
        return;
      }
      if (!this.room || normalizeRoomCode(msg.room) !== this.room.code) {
        this._badCodes.set(key, (this._badCodes.get(key) || 0) + 1);
        this.notice('设备 {name}（{ip}）房间码不正确', { name: peer.peerName, ip: shown }, 'warn');
        peer.approvePeer({ ok: false, reason: '房间码不正确' });
        return;
      }
      const deviceId = String(msg.deviceId || crypto.randomUUID());
      const dup = this.peers.get(deviceId);
      if (dup && dup !== peer) {
        dup.close();
        this.peers.delete(deviceId);
      }
      peer.peerDeviceId = deviceId;
      if (this.autoApprove) {
        // 可信网络下免打扰：房间码即凭证，匹配就直接放行
        peer.approvePeer({ ok: true, deviceId: this.deviceId, name: this.deviceName });
        this._pushState();
        return;
      }
      this.joinRequests.set(deviceId, { peer, name: peer.peerName, ip: shown });
      this._emit({ type: 'join-request', deviceId, name: peer.peerName, ip: shown });
      this._pushState();
    });
  }

  // ------------------------------------------------------------ 跨网中继

  _relayUsable() {
    if (!this.relayEnabled || !this.relayUrl) return false;
    try {
      parseRelayBase(this.relayUrl, this.relayProvider);
      return true;
    } catch {
      return false;
    }
  }

  /** 房间开着的期间，始终保持若干条挂在房间码上的中继连接 */
  _openRelay() {
    this._closeRelay();
    if (!this.room) return;
    if (!this.relayEnabled || !this.relayUrl) return;
    let handle = null;
    try {
      handle = openRelaySlots({
        input: this.relayUrl,
        code: this.room.code,
        provider: this.relayProvider,
        onSocket: (ws) => this._attachIncoming(ws, '', 'relay'),
        onStatus: (s) => {
          this._relayState = { status: s.status, error: s.error || '', host: s.host || '', endpoints: s.endpoints || 0 };
          this._pushState();
        },
      });
    } catch (err) {
      this._relayState = { status: 'error', error: err.message, host: '', endpoints: 0 };
      this.notice('中继不可用：{msg}', { msg: err.message }, 'error');
      this._pushState();
      return;
    }
    this._relay = handle;
    this.notice('房间已通过中继开放，对方在任意网络输入房间码即可加入', null);
  }

  _closeRelay() {
    if (!this._relay) return;
    try {
      this._relay.close();
    } catch {}
    this._relay = null;
    this._relayState = { status: 'off', error: '', host: '', endpoints: 0 };
  }

  approveJoin(deviceId, ok) {
    const req = this.joinRequests.get(deviceId);
    if (!req) return false;
    this.joinRequests.delete(deviceId);
    if (ok) req.peer.approvePeer({ ok: true, deviceId: this.deviceId, name: this.deviceName });
    else req.peer.approvePeer({ ok: false, reason: '房主拒绝了这个请求' });
    this._pushState();
    return true;
  }

  // ------------------------------------------------------------ 加入（本机作为访客）

  async joinRoom(codeRaw) {
    const code = normalizeRoomCode(codeRaw);
    if (!code) {
      const err = new Error('房间码应为 6 位字母或数字');
      this._emit({ type: 'join-error', msg: err.message });
      throw err;
    }
    if (this.outgoing) throw new Error('已有连接正在进行');
    if (this.peers.size && this._localGuestPeer) throw new Error('你已经加入了一个房间');
    this.outgoing = { room: code, codeDisplay: formatRoomCode(code), status: 'discovering' };
    this._pushState();

    const targets = await this._discover({ room: code, timeout: 2500 }).catch(() => []);
    if (!this.outgoing) throw new Error('已取消加入');
    if (!targets.length) {
      this.outgoing = null;
      if (this._relayUsable()) {
        // 同一 Wi-Fi 找不到就自动升级到中继，用户不需要关心走了哪条路
        this.notice('局域网里没找到这个房间，改走中继加入', null, 'warn');
        return this.joinRelay(code);
      }
      const err = new Error('局域网内没有找到这个房间，请确认两台设备连同一个 Wi-Fi');
      this._emit({ type: 'join-error', msg: err.message });
      this._pushState();
      throw err;
    }
    this.outgoing = { room: code, codeDisplay: formatRoomCode(code), status: 'connecting', host: targets[0].name };
    this._pushState();

    let lastError = new Error('无法连接房间');
    for (const target of targets) {
      if (!this.outgoing) {
        lastError = new Error('已取消加入');
        break;
      }
      try {
        const peer = await this._connectTo(target, code);
        this.outgoing = null;
        this._localGuestPeer = peer;
        this._joinedRoom = code;
        this.peers.set(peer.peerDeviceId, peer);
        this._pushState();
        return this._joinResult(code, peer);
      } catch (err) {
        lastError = err;
        if (/房间码不正确|拒绝/.test(err.message)) break;
      }
    }
    this.outgoing = null;
    this._emit({ type: 'join-error', msg: lastError.message });
    this._pushState();
    throw lastError;
  }

  /** 手动指定地址加入（跨网段、VPN 或广播被屏蔽时使用） */
  async joinDirect(address, codeRaw) {
    const code = normalizeRoomCode(codeRaw);
    if (!code) throw new Error('房间码应为 6 位字母或数字');
    const text = String(address || '').trim();
    if (!text) throw new Error('请输入对方显示的地址');
    let host = text;
    let explicitPort = 0;
    const m = /^\[?([^\]]+)\]?:(\d{1,5})$/.exec(text);
    if (m) {
      host = m[1];
      explicitPort = Number(m[2]);
    }
    if (!/^[^\s/]+$/.test(host)) throw new Error('地址格式不正确');
    const ports = explicitPort ? [explicitPort] : Array.from({ length: 13 }, (_, i) => TCP_BASE_PORT + i);
    let lastError = new Error('无法连接');
    for (const port of ports) {
      try {
        const peer = await this._connectTo({ ip: host, port, name: host }, code);
        this._localGuestPeer = peer;
        this._joinedRoom = code;
        this.peers.set(peer.peerDeviceId, peer);
        this._pushState();
        return this._joinResult(code, peer);
      } catch (err) {
        lastError = err;
        if (!/ECONNREFUSED|ETIMEDOUT|拒绝连接|超时/.test(err.message)) break;
      }
    }
    throw lastError;
  }

  leaveRoom() {
    if (this._localGuestPeer) {
      const peer = this._localGuestPeer;
      this._localGuestPeer = null;
      this._joinedRoom = null;
      this.peers.delete(peer.peerDeviceId);
      peer.close();
      this.notice('已离开房间', null);
      this._pushState();
    }
  }

  /** 取消进行中的加入请求（发现或等待批准阶段都可用） */
  cancelJoin() {
    if (!this.outgoing) return false;
    if (this._pendingGuestWs) {
      try {
        this._pendingGuestWs.close();
      } catch {}
      this._pendingGuestWs = null;
    }
    this.outgoing = null;
    this._pushState();
    return true;
  }

  _connectTo(target, code) {
    return this._openLanSocket(target).then((ws) => this._settleGuest(ws, code, target, 'lan'));
  }

  _openLanSocket(target) {
    return new Promise((resolve, reject) => {
      const url = `ws://${target.ip}:${target.port}/`;
      const ws = new WebSocket(url, { maxPayload: CHUNK_SIZE + 4096, handshakeTimeout: 6000 });
      this._pendingGuestWs = ws;
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (this._pendingGuestWs === ws) this._pendingGuestWs = null;
        fn(arg);
      };
      ws.once('open', () => done(resolve, ws));
      ws.on('error', (err) => done(reject, new Error(err.code === 'ECONNREFUSED' ? `对方端口 ${target.port} 拒绝连接` : err.message)));
    });
  }

  /** 连接已就绪之后：发 hello、等房主点「允许」 */
  _settleGuest(ws, code, target, via = 'lan') {
    return new Promise((resolve, reject) => {
      const peer = this._createPeer(ws, target.ip, 'guest', via);
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._pendingGuestWs === ws) this._pendingGuestWs = null;
        fn(arg);
      };
      const timer = setTimeout(() => {
        peer.close();
        finish(reject, new Error('等待对方点「允许」超时'));
      }, APPROVE_TIMEOUT);
      const greet = () => {
        peer.sendHello({ deviceId: this.deviceId, name: this.deviceName, room: code });
        this.outgoing = {
          room: code,
          codeDisplay: formatRoomCode(code),
          status: 'waiting-approve',
          host: target.name || target.ip || '互联网中继',
          via,
        };
        this._pushState();
      };
      if (ws.readyState === 1) greet();
      else ws.once('open', greet);
      ws.on('error', (err) => finish(reject, new Error(err.code === 'ECONNREFUSED' ? `对方端口 ${target.port} 拒绝连接` : err.message)));
      peer.once('ready', () => finish(resolve, peer));
      peer.once('rejected', (reason) => finish(reject, new Error(reason)));
      peer.once('close', () => finish(reject, new Error(via === 'relay' ? '中继连接已断开' : '对方设备断开了连接')));
    });
  }

  /** 明确走中继加入（不同网段、蜂窝网络、或局域网发现被屏蔽时） */
  async joinRelay(codeRaw) {
    const code = normalizeRoomCode(codeRaw);
    if (!code) {
      const err = new Error('房间码应为 6 位字母或数字');
      this._emit({ type: 'join-error', msg: err.message });
      throw err;
    }
    if (!this._relayUsable()) {
      const err = new Error('还没有填写可用的中继地址，请在「跨网传输」里选择 Cloudflare 或 Vercel 并填入地址');
      this._emit({ type: 'join-error', msg: err.message });
      throw err;
    }
    if (this.outgoing) throw new Error('已有连接正在进行');
    if (this._localGuestPeer) throw new Error('你已经加入了一个房间');
    this.outgoing = { room: code, codeDisplay: formatRoomCode(code), status: 'relaying', via: 'relay' };
    this._pushState();

    let ws = null;
    try {
      ws = await dialRelay({ input: this.relayUrl, code, role: 'guest', provider: this.relayProvider });
    } catch (err) {
      this.outgoing = null;
      this._emit({ type: 'join-error', msg: err.message });
      this._pushState();
      throw err;
    }
    if (!this.outgoing) {
      try {
        ws.close();
      } catch {}
      throw new Error('已取消加入');
    }
    const base = parseRelayBase(this.relayUrl, this.relayProvider);
    this._pendingGuestWs = ws;
    try {
      const peer = await this._settleGuest(ws, code, { ip: base.host, name: '互联网中继' }, 'relay');
      this.outgoing = null;
      this._localGuestPeer = peer;
      this._joinedRoom = code;
      this.peers.set(peer.peerDeviceId, peer);
      this._pushState();
      return this._joinResult(code, peer);
    } catch (err) {
      this.outgoing = null;
      this._emit({ type: 'join-error', msg: err.message });
      this._pushState();
      throw err;
    }
  }

  // ------------------------------------------------------------ Peer 接线（两种角色共用）

  _createPeer(ws, ip, role, via = 'lan') {
    const peer = new Peer(ws, { role, ip, saveDir: this.saveDir, autoAccept: this.autoAccept });
    peer.via = via;
    peer.setSelf({ deviceId: this.deviceId, name: this.deviceName });
    peer._since = Date.now();

    peer.on('ready', () => {
      this.peers.set(peer.peerDeviceId || peer.ip, peer);
      if (role === 'guest') this._localGuestPeer = peer;
      this._emit({
        type: 'peer-event',
        action: 'ready',
        peer: { deviceId: peer.peerDeviceId, name: peer.peerName, ip: peer.ip },
      });
      this.notice('已连接：{name}', { name: peer.peerName });
      this._pushState();
    });

    peer.on('close', () => {
      const key = peer.peerDeviceId || peer.ip;
      const known = this.peers.get(key) === peer;
      if (known) this.peers.delete(key);
      if (this._localGuestPeer === peer) {
        this._localGuestPeer = null;
        this._joinedRoom = null;
      }
      for (const [deviceId, req] of this.joinRequests) {
        if (req.peer === peer) this.joinRequests.delete(deviceId);
      }
      if (known) {
        this._emit({ type: 'peer-event', action: 'leave', peer: { deviceId: peer.peerDeviceId, name: peer.peerName, ip: peer.ip } });
        this.notice('{name} 已断开', { name: peer.peerName });
        this._pushState();
      }
    });

    peer.on('rejected', (reason) => this.notice('连接被拒绝：{reason}', { reason }, 'warn'));

    peer.on('offer-in', (rec) => {
      const offer = this._trackOffer({ dir: 'in', peer, transferId: rec.transferId, files: rec.files, totalSize: rec.totalSize, state: 'pending' });
      this._emit({ type: 'offer-in', offer: this._offerView(offer) });
      this._pushState();
    });

    peer.on('offer-out', (out) => {
      const offer = this._trackOffer({ dir: 'out', peer, transferId: out.transferId, files: out.files, totalSize: out.totalSize, state: 'waiting' });
      this._emit({ type: 'offer-out', offer: this._offerView(offer) });
      this._pushState();
    });

    peer.on('transfer-start', (d) => {
      const offer = this._findOffer(peer, d.transferId);
      if (!offer) return;
      offer.state = 'transfer';
      offer.startedAt = Date.now();
      this._emit({ type: 'offer-start', offer: this._offerView(offer) });
    });

    peer.on('progress', (p) => {
      const offer = this._findOffer(peer, p.transferId);
      if (!offer) return;
      const file = offer.files.find((f) => f.id === p.id);
      if (file) {
        file.bytes = p.bytes;
        file.state = offer.dir === 'in' ? 'receiving' : 'sending';
      }
      offer.bytes = offer.files.reduce((s, f) => s + (f.bytes || 0), 0);
      offer.rate = p.rate;
      offer.current = file ? file.name : offer.current;
      this._emit({ type: 'offer-progress', offer: this._offerView(offer) });
    });

    peer.on('item-done', (d) => {
      const offer = this._findOffer(peer, d.transferId);
      if (!offer) return;
      const file = offer.files.find((f) => f.name === d.file && f.state !== 'done' && f.state !== 'error');
      if (file) {
        file.state = d.ok ? 'done' : 'error';
        if (d.path) file.path = d.path;
        if (d.ok) file.bytes = file.size;
        if (!d.ok) file.error = d.error;
      }
      this._emit({ type: 'offer-item', offer: this._offerView(offer), file: d.file, ok: d.ok, path: d.path, error: d.error });
    });

    peer.on('transfer-done', (d) => {
      const offer = this._findOffer(peer, d.transferId);
      if (offer) {
        offer.state = d.ok ? 'done' : 'error';
        offer.reason = d.reason || '';
        offer.savedTo = d.savedTo || offer.savedTo;
        offer.finishedAt = Date.now();
        this._pushHistory(offer);
        this._emit({ type: 'offer-done', offer: this._offerView(offer), ok: d.ok, reason: d.reason, savedTo: offer.savedTo });
        this.offers.delete(offer.id);
      }
      if (this.room) {
        if (d.dir === 'out') this.room.sent = (this.room.sent || 0) + 1;
        else if (d.ok) this.room.received = (this.room.received || 0) + 1;
      }
      const label = d.dir === 'out' ? '发送' : '接收中';
      if (d.ok) this.notice('{label}完成：{n} 个文件', { label, n: offer ? offer.files.length : 0 });
      else if (d.failed > 1) this.notice('{label}失败：{n} 个文件出错', { label, n: d.failed }, 'error');
      else this.notice('{label}失败（{reason}）', { label, reason: d.reason || '未知原因' }, 'error');
      this._pushState();
    });

    peer.on('protocol-error', (msg) => this.notice('传输失败：{msg}', { msg }, 'error'));
    peer.on('remote-error', (msg) => this.notice('对方报告：{msg}', { msg }, 'warn'));
    peer.on('error', (err) => this.notice('连接异常：{msg}', { msg: err.message }, 'error'));
    return peer;
  }

  /** Peer 实例带 socket 与事件监听，不能直接经 IPC 返回，这里给一份可序列化的摘要 */
  _joinResult(code, peer) {
    return { room: code, codeDisplay: formatRoomCode(code), name: peer.peerName, ip: peer.ip, via: peer.via || 'lan' };
  }

  // ------------------------------------------------------------ 局域网发现（UDP）

  _startUdp(code, port) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        try {
          sock.close();
        } catch {}
        resolve(null);
      };
      sock.once('error', fail);
      sock.on('message', (msg, rinfo) => {
        if (!this.room) return;
        let q;
        try {
          q = JSON.parse(String(msg));
        } catch {
          return;
        }
        if (!q || q.m !== MAGIC || q.a !== 'find') return;
        if (q.room && q.room !== this.room.code) return; // 只应答本房间（空房间码表示扫描）
        if (this.peers.size + this.joinRequests.size >= MAX_PEERS) return;
        const answer = Buffer.from(
          JSON.stringify({
            m: MAGIC,
            a: 'here',
            proto: PROTO_VERSION,
            room: this.room.code,
            name: this.deviceName,
            deviceId: this.deviceId,
            ip: String(rinfo.address),
            port,
          })
        );
        try {
          sock.send(answer, rinfo.port, rinfo.address, () => {});
        } catch {}
      });
      sock.bind(UDP_PORT, '0.0.0.0', () => {
        try {
          sock.setBroadcast(true);
          for (const iface of lanInterfaces()) {
            try {
              sock.addMembership(MULTICAST_GROUP, iface.address);
            } catch {}
          }
        } catch {}
        if (settled) {
          try {
            sock.close();
          } catch {}
          return resolve(null);
        }
        settled = true;
        this._udp = sock;
        resolve(sock);
      });
    });
  }

  _closeUdp() {
    if (!this._udp) return;
    try {
      this._udp.close();
    } catch {}
    this._udp = null;
  }

  /** 广播查询房间；room 为具体房间码时用于加入，为空串时用于扫描附近房间 */
  _discover({ room = '', timeout = 1800 } = {}) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const found = new Map();
      const query = Buffer.from(JSON.stringify({ m: MAGIC, a: 'find', proto: PROTO_VERSION, room, from: this.deviceName }));
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          sock.close();
        } catch {}
        resolve([...found.values()]);
      };
      sock.once('error', finish);
      sock.on('message', (msg, rinfo) => {
        let r;
        try {
          r = JSON.parse(String(msg));
        } catch {
          return;
        }
        if (!r || r.m !== MAGIC || r.a !== 'here') return;
        if (room && r.room !== room) return;
        if (String(r.deviceId) === String(this.deviceId)) return; // 忽略自己
        const ip = r.ip && r.ip !== '0.0.0.0' ? r.ip : rinfo.address;
        const key = `${r.deviceId}:${r.port}`;
        if (!found.has(key)) found.set(key, { deviceId: r.deviceId, name: r.name, room: r.room, ip, port: r.port });
        if (room) finish(); // 精确加入拿到第一个响应即可
      });
      sock.bind(0, () => {
        try {
          sock.setBroadcast(true);
        } catch {}
        const targets = new Set([...broadcastTargets(), MULTICAST_GROUP]);
        for (const t of targets) {
          try {
            sock.send(query, UDP_PORT, t, () => {});
          } catch {}
        }
        // 本机自测兜底：同一台机器上开两个实例时广播可能收不到
        try {
          sock.send(query, UDP_PORT, '127.0.0.1', () => {});
        } catch {}
        setTimeout(finish, timeout);
      });
    });
  }

  /** 扫描附近正在开房的设备 */
  async scan() {
    this._emit({ type: 'scan', status: 'scanning' });
    const list = await this._discover({ room: '', timeout: 1800 });
    this.visible = list;
    this._emit({ type: 'scan', status: 'done', rooms: list });
    return list;
  }

  // ------------------------------------------------------------ 传输任务

  async send({ peerIds, paths }) {
    const ids = Array.isArray(peerIds) && peerIds.length ? peerIds : [...this.peers.keys()];
    const targets = ids.map((id) => this.peers.get(id)).filter(Boolean);
    if (!targets.length) throw new Error('还没有已连接的设备');
    const items = await collectItems(paths);
    const total = items.reduce((s, i) => s + i.size, 0);
    this.notice('正在向 {n} 台设备申请传送 {m} 个文件（{size}）', { n: targets.length, m: items.length, size: formatBytes(total) });
    for (const peer of targets) {
      try {
        peer.sendFiles(items);
      } catch (err) {
        this.notice('发送给 {name} 失败：{msg}', { name: peer.peerName, msg: err.message }, 'error');
      }
    }
    this._pushState();
    return { count: items.length, bytes: total };
  }

  respondOffer(offerId, ok) {
    const offer = this.offers.get(offerId);
    if (!offer || offer.dir !== 'in') return false;
    const peer = this.peers.get(offer.peerId);
    if (!peer) return false;
    if (ok) {
      peer.acceptIncoming(offer.transferId, this.saveDir);
      offer.state = 'accepted';
      offer.savedTo = this.saveDir;
    } else {
      peer.declineIncoming(offer.transferId, '对方拒绝接收');
      offer.state = 'declined';
    }
    this._emit({ type: 'offer-responded', offer: this._offerView(offer), ok });
    this._pushState();
    return true;
  }

  disconnect(deviceId) {
    const peer = this.peers.get(deviceId);
    if (peer) {
      if (this._localGuestPeer === peer) {
        this._localGuestPeer = null;
        this._joinedRoom = null;
      }
      peer.close();
    }
  }

  _trackOffer({ dir, peer, transferId, files, totalSize, state }) {
    const id = `o${++this._offerSeq}`;
    const offer = {
      id,
      dir,
      transferId,
      peerId: peer.peerDeviceId || peer.ip,
      peerName: peer.peerName,
      state,
      totalSize,
      bytes: 0,
      rate: 0,
      current: '',
      savedTo: dir === 'in' ? this.saveDir : undefined,
      createdAt: Date.now(),
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        rel: f.rel || f.name,
        size: f.size,
        bytes: 0,
        state: 'pending',
      })),
    };
    this.offers.set(id, offer);
    return offer;
  }

  _findOffer(peer, transferId) {
    for (const offer of this.offers.values()) {
      if (offer.transferId !== transferId) continue;
      if (offer.peerId === peer.peerDeviceId || offer.peerId === peer.ip || !peer.peerDeviceId) return offer;
    }
    return null;
  }

  _offerView(offer) {
    return {
      ...offer,
      files: offer.files.map((f) => ({ name: f.name, rel: f.rel, size: f.size, bytes: f.bytes || 0, state: f.state, path: f.path })),
    };
  }

  _pushHistory(offer) {
    this.history.unshift({
      id: offer.id,
      dir: offer.dir,
      peerName: offer.peerName,
      state: offer.state,
      files: offer.files.map((f) => ({ name: f.rel || f.name, size: f.size, state: f.state, path: f.path })),
      totalSize: offer.totalSize,
      savedTo: offer.savedDir || offer.savedTo,
      at: offer.finishedAt || Date.now(),
    });
    this.history = this.history.slice(0, 60);
  }

  // ------------------------------------------------------------ 设置与生命周期

  setSettings(patch = {}) {
    if (typeof patch.deviceName === 'string' && patch.deviceName.trim()) {
      this.deviceName = patch.deviceName.trim().slice(0, 40);
    }
    if (typeof patch.saveDir === 'string' && patch.saveDir.trim()) {
      this.saveDir = patch.saveDir.trim();
      for (const peer of this.peers.values()) peer.setSaveDir(this.saveDir);
    }
    if (typeof patch.autoAccept === 'boolean') {
      this.autoAccept = patch.autoAccept;
      for (const peer of this.peers.values()) peer.autoAccept = patch.autoAccept;
    }
    if (typeof patch.autoApprove === 'boolean') this.autoApprove = patch.autoApprove;
    if (typeof patch.allowPublic === 'boolean') this.allowPublic = patch.allowPublic;
    const relayTouched =
      (typeof patch.relayEnabled === 'boolean' && patch.relayEnabled !== this.relayEnabled) ||
      (typeof patch.relayProvider === 'string' && RELAY_PROVIDERS.includes(patch.relayProvider) && patch.relayProvider !== this.relayProvider) ||
      (typeof patch.relayUrl === 'string' && patch.relayUrl.trim() !== this.relayUrl);
    if (typeof patch.relayEnabled === 'boolean') this.relayEnabled = patch.relayEnabled;
    if (RELAY_PROVIDERS.includes(patch.relayProvider)) this.relayProvider = patch.relayProvider;
    if (typeof patch.relayUrl === 'string') this.relayUrl = patch.relayUrl.trim().slice(0, 200);
    if (relayTouched && this.room) this._openRelay(); // 槽位池按新配置重开
    if (I18N.isSupported(patch.language)) this.language = patch.language;
    this._pushState();
  }

  dispose() {
    this._disposed = true;
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.stopRoom();
  }
}

module.exports = { Hub, formatBytes, TCP_BASE_PORT, UDP_PORT, MULTICAST_GROUP, MAGIC, MAX_PEERS };
