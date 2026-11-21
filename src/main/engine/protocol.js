'use strict';

const path = require('path');

// 协议版本；双方不一致时直接拒绝连接，避免半兼容带来的诡异错误
const PROTO_VERSION = 1;

// 单个数据帧载荷大小：256KB，在局域网吞吐与内存占用之间折中
const CHUNK_SIZE = 256 * 1024;

// 二进制帧头：4 字节文件序号 + 8 字节偏移 = 12 字节
const HEADER_SIZE = 12;

// 限制单次传输的文件数量与目录深度，防止恶意对端耗尽资源
const MAX_FILES_PER_OFFER = 5000;
const MAX_PATH_DEPTH = 16;

// 单条文本消息的 UTF-8 字节上限。控制帧走 JSON，最坏转义后每字节膨胀 6 倍，
// 32KB 落在 ws maxPayload（CHUNK_SIZE + 4096 ≈ 260KB）之内，不会触发 1009 断连
const MAX_TEXT_BYTES = 32 * 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function encodeChunk(fileId, offset, data) {
  const frame = Buffer.allocUnsafe(HEADER_SIZE + data.length);
  frame.writeUInt32BE(fileId >>> 0, 0);
  frame.writeBigUInt64BE(BigInt(offset), 4);
  data.copy(frame, HEADER_SIZE);
  return frame;
}

function decodeChunk(frame) {
  if (!Buffer.isBuffer(frame) && !ArrayBuffer.isView(frame)) throw new Error('数据帧格式错误');
  const buf = Buffer.from(frame.buffer ?? frame, frame.byteOffset ?? 0, frame.byteLength ?? frame.length);
  if (buf.length < HEADER_SIZE) throw new Error('数据帧长度不足');
  return {
    fileId: buf.readUInt32BE(0),
    offset: Number(buf.readBigUInt64BE(4)),
    data: buf.subarray(HEADER_SIZE),
  };
}

/** 清洗单个文件名：去掉路径分隔符、控制字符与 Windows 非法字符 */
function sanitizeName(name) {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  base = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_') // eslint-disable-line no-control-regex
    .replace(/[.\s]+$/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!base) base = '未命名文件';
  if (WINDOWS_RESERVED.test(base.split('.')[0])) base = `_${base}`;
  if (base.length > 180) {
    const ext = path.extname(base);
    base = `${base.slice(0, 180 - ext.length)}${ext}`;
  }
  return base;
}

/** 清洗相对路径（文件夹传输场景）：逐段消毒并剔除 .. 越界 */
function sanitizeRel(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const parts = rel
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  if (parts.length <= 1) return null; // 只有文件名时交由 name 字段处理
  if (parts.length > MAX_PATH_DEPTH) return null;
  return parts.map(sanitizeName).join('/');
}

/** 目标目录内若已存在同名文件，追加 " (1)"、" (2)" 后缀 */
async function uniquePath(fs, dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i += 1) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

module.exports = {
  PROTO_VERSION,
  CHUNK_SIZE,
  HEADER_SIZE,
  MAX_FILES_PER_OFFER,
  MAX_TEXT_BYTES,
  encodeChunk,
  decodeChunk,
  sanitizeName,
  sanitizeRel,
  uniquePath,
};
