'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const {
  PROTO_VERSION,
  CHUNK_SIZE,
  HEADER_SIZE,
  MAX_FILES_PER_OFFER,
  MAX_TEXT_BYTES,
  encodeChunk,
  chunkHeader,
  decodeChunk,
  sanitizeName,
  sanitizeRel,
  uniquePath,
} = require('./protocol');
const { E2EE_VERSION, newHandshake, deriveSession, createRecord } = require('./crypto');

const WS_OPEN = 1;
const ACCEPT_TIMEOUT = 180_000; // 等待对方点「接收」的最长时间
const RECEIPT_TIMEOUT = 60_000; // 单个文件落盘确认的最长时间
const PROGRESS_INTERVAL = 120; // 进度事件最小间隔（毫秒）
const SEND_PIPELINE = 8; // 同时在途的数据帧数量（8 × 256KB = 2MB 缓冲）
const KX_TIMEOUT = 5_000; // 加密握手只有一次往返的耐心，超时按旧版本处理
const CTL_AAD = Buffer.from('skydrop-ctl-v1');

/**
 * 一台已连接设备的会话：负责握手之后的文件收发状态机。
 * 协议约定：文本帧为 JSON 控制消息，二进制帧为文件数据（12 字节头 + 载荷），
 * 同一条连接上的文件严格串行传输，因此接收端只需跟踪「当前文件」。
 * 双方都是 1.0.5 及以上时，握手后先做一轮 X25519 密钥交换，之后控制帧与数据帧
 * 全部走 AES-256-GCM；没完成加密握手不会进入 ready，避免头几帧漏成明文。
 */
class Peer extends EventEmitter {
  constructor(ws, meta = {}) {
    super();
    this.ws = ws;
    this.localRole = meta.role || 'host';
    this.ip = meta.ip || '';
    this.peerDeviceId = null;
    this.peerName = '未知设备';
    this.approved = false;
    this.destroyed = false;
    this.saveDir = meta.saveDir || null;
    this.autoAccept = Boolean(meta.autoAccept);
    this._room = String(meta.room || '');
    this.e2ee = {
      supported: meta.e2ee !== false,
      peerSupport: false,
      active: false,
      fingerprint: '',
      reason: '', // 没加密的原因：off（本机设置里关了）/ legacy（对方版本较旧）/ timeout（握手没回音）
    };
    this._hs = null;
    this._peerKx = null;
    this._peerGotOurs = false;
    this._kxOpen = false;
    this._kxReplied = false;
    this._kxTimer = null;
    this._sec = null;

    this._waiters = new Map();
    this._offersOut = new Map();
    this._offersIn = new Map();
    this._startedInbound = new Set(); // 已上报过开始时间戳的入站传输
    this._recv = null;
    this._pumpQueue = [];
    this._pumping = false;
    this._msgChain = Promise.resolve();
    this._transferSeq = 0;

    ws.on('message', (data, isBinary) => this._enqueue(data, isBinary));
    ws.on('close', () => {
      this._teardown('对端已断开');
      this.emit('close');
    });
    ws.on('error', (err) => this.emit('error', err));
  }

  get key() {
    return this.peerDeviceId || `${this.ip}`;
  }

  // ---------------------------------------------------------------- 握手

  sendHello({ deviceId, name, room }) {
    this._room = String(room || this._room || '');
    this._sendPlain({
      type: 'hello',
      proto: PROTO_VERSION,
      deviceId,
      name,
      room,
      os: process.platform,
      e2ee: this.e2ee.supported ? E2EE_VERSION : 0,
    });
  }

  /** 主机端：处理访客的 hello（房间码校验在 hub 完成），并回复批准结果 */
  onHello(msg) {
    this.peerDeviceId = String(msg.deviceId || '');
    this.peerName = sanitizeName(msg.name || '未知设备');
    this.e2ee.peerSupport = Number(msg.e2ee) === E2EE_VERSION;
    // 房间码是派生密钥的一部分：直接沿用对方发来的字节串，免得两边规范化写法不一致
    this._room = String(msg.room ?? this._room ?? '');
    this.emit('hello', msg);
  }

  approvePeer(info) {
    this._sendPlain({
      type: 'approve',
      ok: Boolean(info.ok),
      reason: info.reason || '',
      deviceId: info.deviceId,
      name: info.name,
      proto: PROTO_VERSION,
      e2ee: this.e2ee.supported && this.e2ee.peerSupport ? E2EE_VERSION : 0,
    });
    if (info.ok) {
      this._afterApproved();
    } else {
      this.close();
    }
  }

  // ------------------------------------------------------------ 加密握手

  /** 批准完成后统一走这里：能加密的先握手，握完才对外算「已连接」 */
  _afterApproved() {
    if (!this.e2ee.supported) {
      this.e2ee.reason = 'off';
      this._fireReady();
      return;
    }
    if (!this.e2ee.peerSupport) {
      this.e2ee.reason = 'legacy';
      this._fireReady();
      return;
    }
    // 只有本端已经批准了这条连接，才接受对方发起的密钥交换；
    // 否则未批准的访客发两帧 kx 就能把会话推到 ready，等于绕过房主的「允许」
    this._kxOpen = true;
    this._startKx();
  }

  _fireReady() {
    if (this._readyFired) return;
    this._readyFired = true;
    if (this._kxTimer) {
      clearTimeout(this._kxTimer);
      this._kxTimer = null;
    }
    this.approved = true;
    this.emit('ready');
  }

  _startKx() {
    if (this._hs) return;
    this._hs = newHandshake();
    this._sendPlain({ type: 'kx-init', v: E2EE_VERSION, p: this._hs.pub, n: this._hs.nonce.toString('base64') });
    this._kxTimer = setTimeout(() => {
      this._kxTimer = null;
      if (this._sec || this.destroyed) return;
      this.e2ee.reason = 'timeout';
      this._fireReady();
    }, KX_TIMEOUT);
    if (this._kxTimer.unref) this._kxTimer.unref();
  }

  _onKx(msg, isReply) {
    if (!this.e2ee.supported || !this._kxOpen || Number(msg.v) !== E2EE_VERSION) return;
    this.e2ee.peerSupport = true;
    this._peerKx = { pub: String(msg.p || ''), nonce: String(msg.n || '') };
    this._startKx();
    if (!isReply && !this._kxReplied) {
      this._kxReplied = true;
      this._sendPlain({ type: 'kx-reply', v: E2EE_VERSION, p: this._hs.pub, n: this._hs.nonce.toString('base64') });
    }
    // 对方回了 reply，说明它已经拿到我们的公钥，两边这才算凑齐
    if (isReply) this._peerGotOurs = true;
    this._trySecure();
  }

  _trySecure() {
    if (this._sec || !this._hs || !this._peerKx || !this._peerGotOurs) return;
    let session;
    try {
      session = deriveSession({
        privateKey: this._hs.privateKey,
        ourPub: this._hs.pub,
        ourNonce: this._hs.nonce,
        peerPub: this._peerKx.pub,
        peerNonce: this._peerKx.nonce,
        roomCode: this._room,
      });
    } catch (err) {
      this.e2ee.reason = 'error';
      this._fatal(`加密握手失败：${err.message}`);
      return;
    }
    this._sec = {
      binOut: createRecord(session.sendBin),
      binIn: createRecord(session.recvBin),
      ctlOut: createRecord(session.sendCtl),
      ctlIn: createRecord(session.recvCtl),
    };
    this.e2ee.active = true;
    this.e2ee.fingerprint = session.fingerprint;
    this.e2ee.reason = '';
    this._hs.privateKey = null; // 交换完就丢，之后只用派生出的会话密钥
    this._fireReady();
    this.emit('secure', { fingerprint: session.fingerprint });
  }

  // ---------------------------------------------------------------- 发送

  /**
   * 发起一次文件推送。
   * @param {Array<{absPath:string, rel?:string, name:string, size:number, mtimeMs?:number}>} items
   */
  sendFiles(items) {
    if (!this.approved) throw new Error('尚未与对方设备建立连接');
    if (!items || !items.length) throw new Error('没有选择要传送的文件');
    if (items.length > MAX_FILES_PER_OFFER) throw new Error(`一次最多传送 ${MAX_FILES_PER_OFFER} 个文件`);

    const transferId = `t${Date.now().toString(36)}-${++this._transferSeq}`;
    const files = items.map((it, idx) => ({
      id: idx + 1,
      name: sanitizeName(it.rel ? path.basename(it.rel) : it.name),
      rel: sanitizeRel(it.rel || it.name),
      size: Number(it.size) || 0,
      mtime: Math.round(Number(it.mtimeMs) || 0),
      absPath: it.absPath,
      state: 'pending',
    }));
    const out = { transferId, files, totalSize: files.reduce((s, f) => s + f.size, 0), state: 'waiting' };
    this._offersOut.set(transferId, out);
    this._sendCtl({
      type: 'offer',
      transferId,
      from: { deviceId: this._selfId, name: this._selfName },
      files: files.map(({ id, name, rel, size, mtime }) => ({ id, name, rel, size, mtime })),
      totalSize: out.totalSize,
    });
    this.emit('offer-out', out);
    this._runTransfer(out).catch((err) => this._transferFailed(out, err.message));
    return out;
  }

  async _runTransfer(out) {
    const decision = await this._wait(`decision:${out.transferId}`, ACCEPT_TIMEOUT);
    if (!decision.accepted) {
      out.state = 'declined';
      this._offersOut.delete(out.transferId);
      this.emit('transfer-done', { dir: 'out', transferId: out.transferId, ok: false, reason: decision.reason || '对方拒绝接收' });
      return;
    }
    out.state = 'sending';
    this.emit('transfer-start', { dir: 'out', transferId: out.transferId, files: out.files.map(({ id, name, rel, size }) => ({ id, name, rel, size })) });

    for (const file of out.files) {
      if (this.destroyed) throw new Error('连接已中断');
      file.state = 'sending';
      await this._streamFile(out, file);
      const receipt = await this._wait(`receipt:${out.transferId}:${file.id}`, RECEIPT_TIMEOUT);
      file.state = receipt.ok ? 'done' : 'error';
      file.error = receipt.error || '';
      this.emit('item-done', { dir: 'out', transferId: out.transferId, file: file.name, ok: receipt.ok, error: file.error });
    }

    const failed = out.files.filter((f) => f.state === 'error');
    out.state = failed.length ? 'partial' : 'done';
    this._offersOut.delete(out.transferId);
    this.emit('transfer-done', {
      dir: 'out',
      transferId: out.transferId,
      ok: !failed.length,
      failed: failed.length,
      reason: failed.length ? failed[0].error : '',
    });
  }

  async _streamFile(out, file) {
    const hash = crypto.createHash('sha256');
    this._sendCtl({ type: 'file-start', transferId: out.transferId, id: file.id, name: file.name, rel: file.rel, size: file.size });

    const handle = await fsp.open(file.absPath, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    const inflight = []; // 允许有限个数据帧在途，避免读-发串行造成的速率损失
    let offset = 0;
    let lastAt = Date.now();
    let lastBytes = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, CHUNK_SIZE, offset);
        if (bytesRead === 0) break;
        const piece = buf.subarray(0, bytesRead);
        hash.update(piece);
        const pending = this._sendBin(encodeChunk(file.id, offset, piece));
        pending.catch(() => {}); // 真正的错误在下面的 await 处抛出
        inflight.push(pending);
        if (inflight.length >= SEND_PIPELINE) await inflight.shift();
        offset += bytesRead;
        if (offset >= file.size || Date.now() - lastAt >= PROGRESS_INTERVAL) {
          const now = Date.now();
          const rate = ((offset - lastBytes) / Math.max(1, now - lastAt)) * 1000;
          this.emit('progress', {
            dir: 'out',
            transferId: out.transferId,
            id: file.id,
            name: file.name,
            bytes: offset,
            size: file.size,
            rate: Number.isFinite(rate) ? rate : 0,
          });
          lastAt = now;
          lastBytes = offset;
        }
        if (offset >= file.size) break;
      }
      await Promise.all(inflight);
      if (offset !== file.size) throw new Error(`文件大小变化（读取 ${offset} / 声明 ${file.size}）`);
    } finally {
      await handle.close();
    }
    this._sendCtl({ type: 'file-done', transferId: out.transferId, id: file.id, sha256: hash.digest('hex'), size: offset });
  }

  /**
   * 推送一段纯文本：控制帧即时送达，无需对方确认，收到即出现在对方的文本栏。
   * 与文件共用「approved 之后才能发」的门槛；大小校验在 hub 与这里各做一次，
   * 这里是协议层兜底（防止绕过 IPC 的调用方）。
   */
  sendText(text) {
    if (!this.approved) throw new Error('尚未与对方设备建立连接');
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('文本内容为空');
    const size = Buffer.byteLength(body, 'utf8');
    if (size > MAX_TEXT_BYTES) throw new Error('文本过长（超过 32 KB 上限）');
    const textId = `x${Date.now().toString(36)}-${++this._transferSeq}`;
    this._sendCtl({ type: 'text', textId, text: body, size });
    this.emit('text-out', { textId, text: body, size });
    return { textId, size };
  }

  // ---------------------------------------------------------------- 接收

  acceptIncoming(transferId, saveDir) {    const rec = this._offersIn.get(transferId);
    if (!rec || rec.state !== 'pending') return false;
    rec.state = 'accepted';
    if (saveDir) rec.saveDir = saveDir;
    this._sendCtl({ type: 'accept', transferId });
    this._notify(`decision:${transferId}`, { accepted: true });
    return true;
  }

  declineIncoming(transferId, reason = '用户拒绝') {
    const rec = this._offersIn.get(transferId);
    if (!rec || rec.state === 'done') return false;
    rec.state = 'declined';
    this._sendCtl({ type: 'decline', transferId, reason });
    this._notify(`decision:${transferId}`, { accepted: false, reason });
    return true;
  }

  async _onOffer(msg) {
    const files = Array.isArray(msg.files) ? msg.files.slice(0, MAX_FILES_PER_OFFER) : [];
    if (!files.length) return;
    const transferId = String(msg.transferId || `t${Date.now()}`);
    const rec = {
      transferId,
      state: 'pending',
      saveDir: this.saveDir,
      files: files.map((f) => ({
        id: Number(f.id),
        name: sanitizeName(f.name),
        rel: sanitizeRel(f.rel || f.name),
        size: Math.max(0, Number(f.size) || 0),
        mtime: Number(f.mtime) || 0,
        state: 'pending',
        bytes: 0,
      })),
    };
    rec.totalSize = msg.totalSize || rec.files.reduce((s, f) => s + f.size, 0);
    this._offersIn.set(transferId, rec);
    this.emit('offer-in', rec);
    if (this.autoAccept) {
      // 自动接收模式：UI 决定后立即落盘到保存目录
      setImmediate(() => this.acceptIncoming(transferId));
    }
  }

  async _onFileStart(msg) {
    const rec = this._offersIn.get(String(msg.transferId));
    if (!rec || rec.state !== 'accepted') throw new Error('收到未经同意的文件数据');
    const file = rec.files.find((f) => f.id === Number(msg.id));
    if (!file) throw new Error('未知的文件序号');
    const dir = await this._resolveDir(rec, file.rel);
    const tempPath = path.join(dir, `.skydrop-${rec.transferId}-${file.id}.part`);
    await fsp.mkdir(dir, { recursive: true });
    await this._cleanupRecv();
    this._recv = {
      rec,
      file,
      dir,
      tempPath,
      handle: await fsp.open(tempPath, 'w'),
      hash: crypto.createHash('sha256'),
      written: 0,
      startedAt: Date.now(),
      lastAt: Date.now(),
      lastBytes: 0,
    };
    file.state = 'receiving';
    if (!this._startedInbound) this._startedInbound = new Set();
    if (!this._startedInbound.has(rec.transferId)) {
      this._startedInbound.add(rec.transferId);
      this.emit('transfer-start', { dir: 'in', transferId: rec.transferId });
    }
  }

  async _resolveDir(rec, rel) {
    const base = rec.saveDir || this.saveDir;
    if (!base) throw new Error('未设置保存目录');
    if (!rel) return base;
    // rel 已在 sanitizeRel 中剔除 .. 与绝对路径，这里再校验一次结果必须落在 base 内
    const resolved = path.resolve(base, rel);
    const relCheck = path.relative(path.resolve(base), resolved);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new Error('非法的文件路径');
    return path.dirname(resolved);
  }

  async _onChunk(frame) {
    const recv = this._recv;
    if (!recv) throw new Error('收到没有对应文件的数据帧');
    const { fileId, offset, data } = decodeChunk(frame);
    if (fileId !== recv.file.id) throw new Error('数据帧文件序号不匹配');
    if (offset !== recv.written) throw new Error('数据不连续，传输中断');
    const plain = this._sec ? this._sec.binIn.open(data, chunkHeader(fileId, offset)) : data;
    await recv.handle.write(plain, 0, plain.length, offset);
    recv.hash.update(plain);
    recv.written += plain.length;
    recv.file.bytes = recv.written;
    const now = Date.now();
    if (now - recv.lastAt >= PROGRESS_INTERVAL) {
      const rate = ((recv.written - recv.lastBytes) / Math.max(1, now - recv.lastAt)) * 1000;
      this.emit('progress', {
        dir: 'in',
        transferId: recv.rec.transferId,
        id: recv.file.id,
        name: recv.file.name,
        bytes: recv.written,
        size: recv.file.size,
        rate: Number.isFinite(rate) ? rate : 0,
      });
      recv.lastAt = now;
      recv.lastBytes = recv.written;
    }
  }

  async _onFileDone(msg) {
    const recv = this._recv;
    const transferId = String(msg.transferId);
    if (!recv || recv.rec.transferId !== transferId || recv.file.id !== Number(msg.id)) {
      throw new Error('文件结束帧与当前接收状态不一致');
    }
    const { file, rec } = recv;
    const digest = recv.hash.digest('hex');
    await recv.handle.close();
    this._recv = null;

    try {
      if (file.size !== Number(msg.size)) throw new Error(`大小不符（接收 ${file.size} / 期望 ${msg.size}）`);
      if (digest !== String(msg.sha256)) throw new Error('校验和不一致，文件可能已损坏');
      const target = await uniquePath(fsp, recv.dir, file.name);
      await fsp.rename(recv.tempPath, target);
      if (file.mtime) {
        const t = file.mtime / 1000;
        await fsp.utimes(target, t, t).catch(() => {});
      }
      file.state = 'done';
      file.path = target;
      file.bytes = file.size;
      this.emit('item-done', { dir: 'in', transferId, file: file.name, ok: true, path: target });
      this._sendCtl({ type: 'receipt', transferId, id: file.id, ok: true, path: target });
    } catch (err) {
      file.state = 'error';
      file.error = err.message;
      await fsp.rm(recv.tempPath, { force: true }).catch(() => {});
      this.emit('item-done', { dir: 'in', transferId, file: file.name, ok: false, error: err.message });
      this._sendCtl({ type: 'receipt', transferId, id: file.id, ok: false, error: err.message });
    }
    await this._finishInboundIfNeeded(rec);
  }

  async _finishInboundIfNeeded(rec) {
    if (rec.files.some((f) => f.state === 'receiving' || f.state === 'pending')) return;
    const failed = rec.files.filter((f) => f.state === 'error');
    rec.state = failed.length ? 'partial' : 'done';
    this.emit('transfer-done', {
      dir: 'in',
      transferId: rec.transferId,
      ok: !failed.length,
      failed: failed.length,
      reason: failed.length ? failed[0].error : '',
      savedTo: rec.saveDir || this.saveDir,
      files: rec.files.map((f) => ({ name: f.name, rel: f.rel, state: f.state, path: f.path })),
    });
  }

  async _cleanupRecv() {
    if (!this._recv) return;
    const { handle, tempPath } = this._recv;
    this._recv = null;
    await handle.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- 帧处理

  _enqueue(data, isBinary) {
    // 消息串行处理，保证写入顺序与哈希顺序严格一致
    this._msgChain = this._msgChain
      .then(() => (isBinary ? this._onChunk(data) : this._onText(data)))
      .catch((err) => this._fatal(err.message));
  }

  async _onText(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      throw new Error('无法解析的控制帧');
    }
    if (msg.type === 'kx-init') {
      this._onKx(msg, false);
      return;
    }
    if (msg.type === 'kx-reply') {
      this._onKx(msg, true);
      return;
    }
    if (msg.type === 'sec') {
      if (!this._sec) throw new Error('收到未预期的加密帧');
      const frame = Buffer.from(String(msg.d || ''), 'base64');
      // 必须把内层的 await 交回消息链：否则 file-start 还没处理完就到 file-done，接收状态机错位
      return this._onCtl(JSON.parse(this._sec.ctlIn.open(frame, CTL_AAD).toString('utf8')));
    }
    // 加密已经启用就不再收明文业务帧，免得对端（或中间人）掺一条未加密的
    if (this._sec && !['ping', 'pong', 'error'].includes(msg.type)) throw new Error('加密已启用，拒收明文控制帧');
    await this._onCtl(msg);
  }

  async _onCtl(msg) {
    switch (msg.type) {
      case 'hello':
        if (this.peerDeviceId) throw new Error('重复的握手消息');
        this.onHello(msg);
        break;
      case 'approve':
        if (msg.proto !== PROTO_VERSION) throw new Error(`协议版本不匹配（对方 ${msg.proto}）`);
        if (msg.ok) {
          this.peerDeviceId = String(msg.deviceId || this.peerDeviceId || '');
          this.peerName = sanitizeName(msg.name || this.peerName);
          this.e2ee.peerSupport = Number(msg.e2ee) === E2EE_VERSION;
          this._afterApproved();
        } else {
          this.emit('rejected', msg.reason || '对方拒绝');
          this.close();
        }
        break;
      case 'offer':
        this._assertReady();
        await this._onOffer(msg);
        break;
      case 'accept':
        this._notify(`decision:${String(msg.transferId)}`, { accepted: true });
        break;
      case 'decline':
        this._notify(`decision:${String(msg.transferId)}`, { accepted: false, reason: String(msg.reason || '') });
        break;
      case 'file-start':
        this._assertReady();
        await this._onFileStart(msg);
        break;
      case 'file-done':
        this._assertReady();
        await this._onFileDone(msg);
        break;
      case 'receipt':
        this._notify(`receipt:${String(msg.transferId)}:${Number(msg.id)}`, {
          ok: Boolean(msg.ok),
          error: String(msg.error || ''),
          path: String(msg.path || ''),
        });
        break;
      case 'text':
        this._assertReady();
        this._onTextMsg(msg);
        break;
      case 'ping':
        this._sendCtl({ type: 'pong' });
        break;
      case 'error':
        this.emit('remote-error', String(msg.msg || '对端报错'));
        break;
      default:
        break;
    }
  }

  _assertReady() {
    if (!this.approved) throw new Error('收到未经批准设备的数据');
  }

  _onTextMsg(msg) {
    if (typeof msg.text !== 'string') throw new Error('文本消息格式不正确');
    if (Buffer.byteLength(msg.text, 'utf8') > MAX_TEXT_BYTES) throw new Error('文本消息超出长度限制');
    if (!msg.text.trim()) return; // 空白文本不展示也不报错，等价于对方什么都没发
    this.emit('text-in', {
      textId: String(msg.textId || `x${Date.now().toString(36)}`),
      text: msg.text,
      size: Buffer.byteLength(msg.text, 'utf8'),
    });
  }

  _fatal(message) {
    this.emit('protocol-error', message);
    this._sendCtl({ type: 'error', msg: message });
    for (const rec of this._offersIn.values()) {
      if (rec.state === 'pending' || rec.state === 'accepted') this.declineIncoming(rec.transferId, message);
    }
    this.close();
  }

  _transferFailed(out, message) {
    if (this._offersOut.get(out.transferId) !== out) return; // 已由其它路径收尾
    out.state = 'error';
    this._offersOut.delete(out.transferId);
    this.emit('transfer-done', { dir: 'out', transferId: out.transferId, ok: false, reason: message });
  }

  _teardown(reason) {
    this.destroyed = true;
    if (this._kxTimer) {
      clearTimeout(this._kxTimer);
      this._kxTimer = null;
    }
    this._cleanupRecv().catch(() => {});
    for (const [key, w] of this._waiters) {
      w.reject(new Error(reason));
      this._waiters.delete(key);
    }
    for (const out of this._offersOut.values()) this._transferFailed(out, reason);
    for (const rec of this._offersIn.values()) {
      if (rec.state === 'accepted' || rec.state === 'pending') {
        rec.state = 'error';
        this.emit('transfer-done', { dir: 'in', transferId: rec.transferId, ok: false, reason });
      }
    }
  }

  _wait(key, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(key);
        reject(new Error('等待对方响应超时'));
      }, ms);
      this._waiters.set(key, { resolve, reject, timer });
    });
  }

  _notify(key, value) {
    const w = this._waiters.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    this._waiters.delete(key);
    w.resolve(value);
  }

  // ---------------------------------------------------------------- 底层发送

  _sendCtl(obj) {
    if (this.ws.readyState !== WS_OPEN) return;
    if (this._sec) {
      this._sendPlain({ type: 'sec', d: this._sec.ctlOut.seal(Buffer.from(JSON.stringify(obj), 'utf8'), CTL_AAD).toString('base64') });
      return;
    }
    this._sendPlain(obj);
  }

  _sendPlain(obj) {
    if (this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** 帧头 12 字节保持明文（同时作为 AAD，把密文钉死在「这个文件的这个偏移」），载荷整体换成密文 */
  _sealFrame(frame) {
    const buf = Buffer.from(frame.buffer ?? frame, frame.byteOffset ?? 0, frame.byteLength ?? frame.length);
    const head = buf.subarray(0, HEADER_SIZE);
    return Buffer.concat([head, this._sec.binOut.seal(buf.subarray(HEADER_SIZE), head)]);
  }

  _sendBin(frame) {
    if (this.ws.readyState !== WS_OPEN) return Promise.reject(new Error('连接已断开'));
    const out = this._sec ? this._sealFrame(frame) : frame;
    return new Promise((resolve, reject) => {
      this.ws.send(out, { binary: true }, (err) => (err ? reject(err) : resolve()));
    });
  }

  setSaveDir(dir) {
    this.saveDir = dir;
  }

  setSelf(info) {
    this._selfId = info.deviceId;
    this._selfName = info.name;
  }

  close() {
    if (this.ws.readyState === WS_OPEN || this.ws.readyState === 0) {
      try {
        this.ws.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

module.exports = { Peer, CHUNK_SIZE, PROGRESS_INTERVAL, SEND_PIPELINE, MAX_TEXT_BYTES };
