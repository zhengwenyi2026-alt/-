'use strict';

const crypto = require('crypto');

// 握手与派生参数：换算法或帧格式时必须一起改，否则两侧派生出的密钥对不上
const E2EE_VERSION = 1;
const KDF_INFO = 'skydrop-e2ee-v1';
const NONCE_SIZE = 16;
const KEY_SIZE = 32;
const TAG_SIZE = 16;
const CTR_SIZE = 4;
const MAX_RECORDS = 0xffffffff; // 计数器只有 4 字节，超出即要求重新握手

// 指纹用去掉易混字符（I O 0 1）的 32 字母表，5 bit 一个字符，念给对方听不容易听错
const FP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FP_LENGTH = 6; // 取 30 bit ÷ 每字符 5 bit，改这个数要连位运算一起改

// X25519 裸公钥（32 字节）套上 SPKI 前缀就是可以直接喂给 createPublicKey 的 DER
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function toRaw(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** 随机数允许直接给 Buffer，也给 base64 字符串（走网络时是字符串） */
function toNonce(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'base64');
  if (buf.length !== NONCE_SIZE) throw new Error('握手随机数长度不对');
  return buf;
}

function fromRaw(base64) {
  const raw = Buffer.from(String(base64 || ''), 'base64');
  if (raw.length !== 32) throw new Error('对方的密钥格式不对');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 本次连接临时生成一对 X25519，用完即弃：不落盘，因此不存长期身份 */
function newHandshake() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    pub: toRaw(publicKey).toString('base64'),
    privateKey,
    nonce: crypto.randomBytes(NONCE_SIZE),
  };
}

/**
 * 两个方向各自一套记录密钥，靠比较裸公钥的大小决定谁是「甲」，
 * 这样双方不必事先约定谁先谁后也能算出一致的密钥表。
 */
function deriveSession({ privateKey, ourPub, ourNonce, peerPub, peerNonce, roomCode }) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: fromRaw(peerPub) });
  const ourRaw = Buffer.from(String(ourPub), 'base64');
  const theirs = Buffer.from(String(peerPub), 'base64');
  if (!ourRaw.length || !theirs.length) throw new Error('密钥长度不对');
  const weAreFirst = Buffer.compare(ourRaw, theirs) < 0;
  const lowFirst = (a, b) => (weAreFirst ? Buffer.concat([a, b]) : Buffer.concat([b, a]));
  const salt = lowFirst(toNonce(ourNonce), toNonce(peerNonce));
  const info = Buffer.from(`${KDF_INFO}|${E2EE_VERSION}|${String(roomCode || '')}`, 'utf8');
  const km = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, KEY_SIZE * 5));
  const slice = (i) => km.subarray(i * KEY_SIZE, (i + 1) * KEY_SIZE);
  const first = { bin: slice(0), ctl: slice(2), confirm: slice(4) };
  const second = { bin: slice(1), ctl: slice(3), confirm: slice(4) };
  const mine = weAreFirst ? first : second;
  const theirsKeys = weAreFirst ? second : first;
  // 指纹的输入必须与「谁在算」无关：公钥按大小排序后拼，两侧才会得到同一个字符串
  const fpSource = Buffer.concat([lowFirst(ourRaw, theirs), salt, Buffer.from(String(roomCode || ''), 'utf8')]);
  const mac = crypto.createHmac('sha256', km.subarray(4 * KEY_SIZE)).update(fpSource).digest();
  const bits = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 2; // 取高 30 bit
  let fingerprint = '';
  for (let i = 0; i < FP_LENGTH; i += 1) fingerprint += FP_ALPHABET[(bits >>> (25 - i * 5)) & 31];
  return {
    weAreFirst,
    fingerprint,
    sendBin: mine.bin,
    sendCtl: mine.ctl,
    recvBin: theirsKeys.bin,
    recvCtl: theirsKeys.ctl,
  };
}

/**
 * 一个方向的记录层：AES-256-GCM，nonce = 4 字节递增计数器（大端）+ 8 字节零，
 * 计数器随帧明文带出，接收端要求严格连续，因此重放与乱序都会当场解密失败。
 */
function createRecord(key) {
  const k = Buffer.from(key);
  if (k.length !== KEY_SIZE) throw new Error('记录密钥长度不对');
  let next = 0;
  let expected = 0;
  const nonceOf = (ctr) => {
    const n = Buffer.alloc(12);
    n.writeUInt32BE(ctr >>> 0, 0);
    return n;
  };
  return {
    get sent() {
      return next;
    },
    get received() {
      return expected;
    },
    /** 输出 [4 字节计数器][16 字节标签][密文]；aad 用来把帧绑到具体上下文 */
    seal(plain, aad) {
      if (next > MAX_RECORDS) throw new Error('本次连接的加密帧已用尽，请重新连接');
      const ctr = next;
      next += 1;
      const c = crypto.createCipheriv('aes-256-gcm', k, nonceOf(ctr));
      if (aad && aad.length) c.setAAD(Buffer.from(aad));
      const body = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
      const frame = Buffer.allocUnsafe(CTR_SIZE + TAG_SIZE + body.length);
      frame.writeUInt32BE(ctr >>> 0, 0);
      c.getAuthTag().copy(frame, CTR_SIZE);
      body.copy(frame, CTR_SIZE + TAG_SIZE);
      return frame;
    },
    open(frame, aad) {
      const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer ?? frame, frame.byteOffset ?? 0, frame.byteLength ?? frame.length);
      if (buf.length < CTR_SIZE + TAG_SIZE) throw new Error('加密帧长度不足');
      const ctr = buf.readUInt32BE(0);
      if (ctr !== expected) throw new Error('加密帧顺序异常，请重新连接');
      const d = crypto.createDecipheriv('aes-256-gcm', k, nonceOf(ctr));
      if (aad && aad.length) d.setAAD(Buffer.from(aad));
      d.setAuthTag(buf.subarray(CTR_SIZE, CTR_SIZE + TAG_SIZE));
      const plain = Buffer.concat([d.update(buf.subarray(CTR_SIZE + TAG_SIZE)), d.final()]);
      expected += 1;
      return plain;
    },
  };
}

module.exports = {
  E2EE_VERSION,
  TAG_SIZE,
  CTR_SIZE,
  FP_ALPHABET,
  FP_LENGTH,
  newHandshake,
  deriveSession,
  createRecord,
  fromRaw,
};
