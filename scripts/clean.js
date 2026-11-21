'use strict';

// 清理构建产物与临时文件，避免占用磁盘
const fs = require('fs');
const path = require('path');

const targets = ['dist', 'out', path.join(require('os').tmpdir(), 'skydrop-e2e')];
for (const t of targets) {
  const abs = path.isAbsolute(t) ? t : path.join(__dirname, '..', t);
  try {
    if (fs.existsSync(abs)) {
      const size = du(abs);
      fs.rmSync(abs, { recursive: true, force: true });
      console.log(`已删除 ${abs}（约 ${(size / 1048576).toFixed(0)} MB）`);
    }
  } catch (err) {
    console.error(`删除 ${abs} 失败：${err.message}`);
  }
}

function du(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const abs = path.join(p, entry.name);
    total += entry.isDirectory() ? du(abs) : fs.statSync(abs).size;
  }
  return total;
}
