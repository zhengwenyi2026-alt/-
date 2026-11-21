'use strict';

const fs = require('fs');
const path = require('path');

/** 极小的 JSON 设置存储：先写临时文件再改名，避免崩溃时留下半个文件 */
class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      this.data = {};
    }
  }

  get(key, fallback) {
    return this.data[key] === undefined ? fallback : this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('保存设置失败：', err.message);
    }
  }
}

module.exports = { Store };
