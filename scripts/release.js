'use strict';

// 一次跑完 mac + win 打包，并把最终安装包收进「可执行文件/」。
// dist/ 里还有 win-unpacked、mac/ 等中间目录，不适合直接发给别人。
// 运行：npm run release
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(ROOT, '可执行文件');
const ARTIFACTS = ['.dmg', '.exe', '.zip'];

function build(args) {
  console.log(`\n$ npx electron-builder ${args.join(' ')}`);
  const res = spawnSync('npx', ['electron-builder', ...args], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) throw new Error(`electron-builder ${args.join(' ')} 失败，退出码 ${res.status}`);
}

fs.mkdirSync(TARGET, { recursive: true });
for (const f of fs.readdirSync(TARGET)) {
  if (ARTIFACTS.some((ext) => f.endsWith(ext))) fs.rmSync(path.join(TARGET, f), { force: true });
}

build(['--mac']);
build(['--win']);

const copied = [];
for (const name of fs.readdirSync(DIST)) {
  if (!ARTIFACTS.some((ext) => name.endsWith(ext))) continue;
  if (name.endsWith('.blockmap')) continue;
  fs.copyFileSync(path.join(DIST, name), path.join(TARGET, name));
  copied.push([name, fs.statSync(path.join(TARGET, name)).size]);
}

console.log(`\n已复制到 ${TARGET}：`);
for (const [name, size] of copied) console.log(`  ${name}  ${(size / 1048576).toFixed(1)} MB`);
if (!copied.length) throw new Error('dist/ 里没有找到任何安装包');
