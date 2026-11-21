'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { Hub, formatBytes } = require('./engine/hub');
const { generateRoomCode } = require('./engine/roomCode');
const { probeRelay } = require('./engine/relay');
const { MAX_TEXT_BYTES } = require('./engine/protocol');
const { Store } = require('./store');
const I18N = require('../common/i18n');

let win = null;
let hub = null;
let store = null;

const MAX_PREVIEW = 300;

/** 当前界面语言：优先用户设置，其次按系统 locale 探测 */
function currentLang() {
  const saved = store ? store.get('language', null) : null;
  if (I18N.isSupported(saved)) return saved;
  try {
    return I18N.detect(app.getLocale());
  } catch {
    return I18N.DEFAULT_LANG;
  }
}

const tt = (key, params) => I18N.t(key, params, currentLang());

function defaultSaveDir() {
  let base;
  try {
    base = app.getPath('downloads');
  } catch {
    base = path.join(os.homedir(), 'Downloads');
  }
  // 中文环境用「隔空传」，其它语言用 ASCII 目录名，避免资源管理器里出现难读路径
  const folder = currentLang().startsWith('zh') ? '隔空传' : 'SkyDrop';
  return path.join(base, folder);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 660,
    show: false,
    title: '隔空传',
    backgroundColor: '#0b0d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // 传输在后台进行时也要能刷新进度
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
  // 新窗口与外链一律拦截，避免渲染层被引导到外部页面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  return win;
}

function push(event) {
  if (win && !win.isDestroyed()) win.webContents.send('skydrop:event', event);
}

function initHub() {
  const deviceId = store.get('deviceId', null) || crypto.randomUUID();
  store.set({ deviceId });
  hub = new Hub({
    deviceId,
    deviceName: store.get('deviceName', null) || os.hostname() || tt('我的设备'),
    language: currentLang(),
    saveDir: store.get('saveDir', null) || defaultSaveDir(),
    autoAccept: Boolean(store.get('autoAccept', false)),
    autoApprove: Boolean(store.get('autoApprove', false)),
    allowPublic: Boolean(store.get('allowPublic', false)),
    relayEnabled: Boolean(store.get('relayEnabled', false)),
    relayProvider: store.get('relayProvider', 'cloudflare'),
    relayUrl: store.get('relayUrl', ''),
    appVersion: app.getVersion(),
  });
  hub.on('event', push);
  fsp.mkdir(hub.saveDir, { recursive: true }).catch(() => {});
  // 本机传输面板常驻，房间没开的时候也能看历史与设置；只绑 127.0.0.1
  hub.startPanel().catch(() => {});
  return hub;
}

// ------------------------------------------------------------------ IPC

function ok(fn) {
  // 统一把引擎异常转成 {ok:false, error} 给渲染层，避免未捕获拒绝。
  // 注意：ipcMain.handle 的第一个参数是 event，必须剥掉再传给业务函数。
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 4096);
}

function registerIpc() {
  ipcMain.handle('skydrop:state', () => ({ ...hub.state(), app: { version: app.getVersion(), platform: process.platform } }));
  ipcMain.handle('skydrop:start-room', ok(() => hub.startRoom()));
  ipcMain.handle('skydrop:stop-room', ok(() => hub.stopRoom()));
  ipcMain.handle('skydrop:scan', ok(() => hub.scan()));

  ipcMain.handle(
    'skydrop:join',
    ok((code) => {
      if (typeof code !== 'string') throw new Error('房间码格式不正确');
      return hub.joinRoom(code);
    })
  );
  ipcMain.handle(
    'skydrop:join-direct',
    ok((address, code) => {
      if (typeof address !== 'string' || typeof code !== 'string') throw new Error('参数不正确');
      return hub.joinDirect(address, code);
    })
  );
  ipcMain.handle('skydrop:leave', ok(() => hub.leaveRoom()));
  ipcMain.handle('skydrop:cancel-join', ok(() => hub.cancelJoin()));
  ipcMain.handle(
    'skydrop:join-relay',
    ok((code) => {
      if (typeof code !== 'string') throw new Error('房间码格式不正确');
      return hub.joinRelay(code);
    })
  );
  ipcMain.handle(
    'skydrop:relay-check',
    ok(async ({ relayUrl, relayProvider } = {}) => {
      const url = typeof relayUrl === 'string' && relayUrl.trim() ? relayUrl : hub.relayUrl;
      // 界面上还没保存的选择也要能先测，所以 provider 只认三个合法值，否则回落到已保存的
      const provider = ['cloudflare', 'vercel', 'custom'].includes(relayProvider) ? relayProvider : hub.relayProvider;
      if (!String(url || '').trim()) throw new Error('请填写中继地址');
      return probeRelay({ input: url, provider, code: generateRoomCode() });
    })
  );
  ipcMain.handle(
    'skydrop:approve-join',
    ok((deviceId, approve) => {
      if (typeof deviceId !== 'string') throw new Error('参数不正确');
      return hub.approveJoin(deviceId, Boolean(approve));
    })
  );
  ipcMain.handle(
    'skydrop:respond-offer',
    ok((offerId, approve) => {
      if (typeof offerId !== 'string') throw new Error('参数不正确');
      return hub.respondOffer(offerId, Boolean(approve));
    })
  );

  ipcMain.handle(
    'skydrop:send',
    ok(({ peerIds, paths }) => {
      if (!isStringArray(paths) || !paths.length) throw new Error('没有选择要传送的文件');
      if (paths.length > 2000) throw new Error('一次选择的项目过多');
      const ids = isStringArray(peerIds) ? peerIds : [];
      return hub.send({ peerIds: ids, paths });
    })
  );

  ipcMain.handle(
    'skydrop:send-text',
    ok(({ peerIds, text, asFile }) => {
      if (typeof text !== 'string') throw new Error('文本内容为空');
      if (text.length > MAX_TEXT_BYTES) throw new Error('文本过长（超过 32 KB 上限）');
      const ids = isStringArray(peerIds) ? peerIds : [];
      return hub.sendText({ peerIds: ids, text, asFile: Boolean(asFile) });
    })
  );

  ipcMain.handle('skydrop:clear-texts', ok(() => hub.clearTexts()));

  ipcMain.handle(
    'skydrop:preview',
    ok(async (paths) => {
      if (!isStringArray(paths)) return { items: [], total: 0, dirs: 0 };
      const items = [];
      let total = 0;
      let dirs = 0;
      for (const p of paths.slice(0, MAX_PREVIEW)) {
        let st;
        try {
          st = await fsp.lstat(p);
        } catch {
          continue;
        }
        const name = path.basename(p);
        if (st.isDirectory()) {
          dirs += 1;
          items.push({ path: p, name, isDir: true, size: 0 });
        } else if (st.isFile()) {
          total += st.size;
          items.push({ path: p, name, isDir: false, size: st.size });
        }
      }
      return { items, total, dirs, truncated: paths.length > MAX_PREVIEW, totalText: formatBytes(total) };
    })
  );

  ipcMain.handle('skydrop:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: tt('选择要传送的文件或文件夹'),
      buttonLabel: tt('加入清单'),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      defaultPath: app.getPath('home'),
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('skydrop:pick-save-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: tt('选择接收文件的保存目录'),
      buttonLabel: tt('用作保存目录'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: hub.saveDir,
    });
    if (res.canceled || !res.filePaths.length) return hub.saveDir;
    hub.setSettings({ saveDir: res.filePaths[0] });
    store.set({ saveDir: hub.saveDir });
    fsp.mkdir(hub.saveDir, { recursive: true }).catch(() => {});
    return hub.saveDir;
  });

  ipcMain.handle(
    'skydrop:settings',
    ok((patch) => {
      if (!patch || typeof patch !== 'object') throw new Error('参数不正确');
      hub.setSettings(patch);
      store.set({
        deviceName: hub.deviceName,
        saveDir: hub.saveDir,
        autoAccept: hub.autoAccept,
        autoApprove: hub.autoApprove,
        allowPublic: hub.allowPublic,
        relayEnabled: hub.relayEnabled,
        relayProvider: hub.relayProvider,
        relayUrl: hub.relayUrl,
        language: hub.language,
      });
      return true;
    })
  );

  // 只在保存目录范围内打开，避免渲染层传入任意路径被系统打开
  ipcMain.handle(
    'skydrop:reveal',
    ok(async (target) => {
      if (typeof target !== 'string') throw new Error('参数不正确');
      const real = await fsp.realpath(path.resolve(target)).catch(() => null);
      const root = await fsp.realpath(path.resolve(hub.saveDir)).catch(() => hub.saveDir);
      if (!real || !real.startsWith(root + path.sep)) throw new Error('只能打开保存目录内的文件');
      shell.showItemInFolder(real);
      return true;
    })
  );

  ipcMain.handle('skydrop:open-save-dir', async () => {
    await fsp.mkdir(hub.saveDir, { recursive: true }).catch(() => {});
    shell.openPath(hub.saveDir);
    return hub.saveDir;
  });

  ipcMain.handle('skydrop:open-panel', async () => {
    const url = hub.panel && hub.panel.url;
    if (!url || !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) throw new Error('面板未就绪');
    await shell.openExternal(url);
    return url;
  });

  // Electron 的 file:// 页面里 navigator.clipboard 并不可靠，统一走主进程。
  // 上限与文本传送一致，收到的长文本也要能复制。
  ipcMain.on('skydrop:copy', (_e, text) => {
    if (typeof text === 'string' && text.length <= MAX_TEXT_BYTES) clipboard.writeText(text);
  });
}

// ------------------------------------------------------------------ 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName('隔空传');
  if (process.platform === 'win32') app.setAppUserModelId('com.xiaopacaisky.skydrop');
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    store = new Store(path.join(app.getPath('userData'), 'settings.json'));
    initHub();
    registerIpc();
    createWindow();
  });

  app.on('before-quit', () => {
    try {
      hub && hub.dispose();
    } catch {}
  });

  app.on('window-all-closed', () => app.quit());
}
