'use strict';

const crypto = require('crypto');

// 6 位房间码使用的字符集：剔除 I/O/0/1 等易混淆字符，共 32 个（便于按 5 bit 均匀取值）
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** 生成一个随机房间码 */
function generateRoomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] & 31];
  return code;
}

/** 输入框过滤：仅保留合法字符并限制长度 */
function sanitizeRoomInput(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .split('')
    .filter((ch) => ALPHABET.includes(ch))
    .slice(0, CODE_LENGTH)
    .join('');
}

/** 规范化并校验房间码，非法返回空串 */
function normalizeRoomCode(raw) {
  const code = sanitizeRoomInput(raw);
  return CODE_RE.test(code) ? code : '';
}

/** 展示格式：ABC123 -> ABC-123 */
function formatRoomCode(code) {
  const c = String(code ?? '');
  return c.length === CODE_LENGTH ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

module.exports = { ALPHABET, CODE_LENGTH, generateRoomCode, normalizeRoomCode, sanitizeRoomInput, formatRoomCode };
