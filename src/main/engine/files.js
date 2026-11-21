'use strict';

const fsp = require('fs/promises');
const path = require('path');

const MAX_FILES = 5000;
const MAX_DEPTH = 16;
// 文件夹传输时忽略的系统垃圾文件
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'ehthumbs.db']);

/**
 * 把拖进来的路径（文件或文件夹）展开为待发送清单。
 * 返回的 rel 是相对接收端保存目录的路径，首层用被拖入条目自身的名字，
 * 这样接收端可以还原目录结构。
 */
async function collectItems(paths) {
  const items = [];
  for (const raw of paths) {
    const abs = path.resolve(String(raw));
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue; // 路径已失效，跳过
    }
    const base = path.basename(abs);
    if (st.isSymbolicLink()) {
      const target = await fsp.stat(abs).catch(() => null);
      if (!target || !target.isFile()) continue; // 不跟随目录软链，避免环路
      items.push(toItem(abs, base, target));
    } else if (st.isFile()) {
      items.push(toItem(abs, base, st));
    } else if (st.isDirectory()) {
      await walk(abs, base, 0, items);
    }
    if (items.length > MAX_FILES) throw new Error(`一次最多传送 ${MAX_FILES} 个文件`);
  }
  if (!items.length) throw new Error('没有可传送的文件');
  return items;
}

function toItem(absPath, name, st) {
  return { absPath, name, rel: name, size: st.size, mtimeMs: st.mtimeMs };
}

async function walk(dir, rel, depth, items) {
  if (depth > MAX_DEPTH || items.length > MAX_FILES) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const nextRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(abs, nextRel, depth + 1, items);
    } else if (entry.isFile()) {
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;
      items.push({ absPath: abs, name: entry.name, rel: nextRel, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (items.length > MAX_FILES) return;
  }
}

module.exports = { collectItems, MAX_FILES };
