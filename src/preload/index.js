'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 渲染层唯一入口：只做参数校验和 IPC 转发，不暴露任何 Node 能力 */
const api = {
  getState: () => ipcRenderer.invoke('skydrop:state'),
  startRoom: () => ipcRenderer.invoke('skydrop:start-room'),
  stopRoom: () => ipcRenderer.invoke('skydrop:stop-room'),
  scan: () => ipcRenderer.invoke('skydrop:scan'),
  join: (code) => ipcRenderer.invoke('skydrop:join', String(code || '')),
  joinDirect: (address, code) => ipcRenderer.invoke('skydrop:join-direct', String(address || ''), String(code || '')),
  joinRelay: (code) => ipcRenderer.invoke('skydrop:join-relay', String(code || '')),
  checkRelay: (relayUrl, relayProvider) => ipcRenderer.invoke('skydrop:relay-check', { relayUrl: String(relayUrl || ''), relayProvider: String(relayProvider || '') }),
  leave: () => ipcRenderer.invoke('skydrop:leave'),
  cancelJoin: () => ipcRenderer.invoke('skydrop:cancel-join'),
  approveJoin: (deviceId, approve) => ipcRenderer.invoke('skydrop:approve-join', String(deviceId || ''), Boolean(approve)),
  respondOffer: (offerId, approve) => ipcRenderer.invoke('skydrop:respond-offer', String(offerId || ''), Boolean(approve)),
  send: (peerIds, paths) => ipcRenderer.invoke('skydrop:send', { peerIds, paths }),
  sendText: (payload) =>
    ipcRenderer.invoke('skydrop:send-text', {
      peerIds: Array.isArray(payload && payload.peerIds) ? payload.peerIds.map(String) : [],
      text: String((payload && payload.text) || ''),
      asFile: Boolean(payload && payload.asFile),
    }),
  clearTexts: () => ipcRenderer.invoke('skydrop:clear-texts'),
  preview: (paths) => ipcRenderer.invoke('skydrop:preview', paths),
  pick: () => ipcRenderer.invoke('skydrop:pick'),
  pickSaveDir: () => ipcRenderer.invoke('skydrop:pick-save-dir'),
  setSettings: (patch) => ipcRenderer.invoke('skydrop:settings', patch),
  reveal: (p) => ipcRenderer.invoke('skydrop:reveal', String(p || '')),
  openPanel: () => ipcRenderer.invoke('skydrop:open-panel'),
  openSaveDir: () => ipcRenderer.invoke('skydrop:open-save-dir'),
  copy: (text) => ipcRenderer.send('skydrop:copy', String(text || '')),
  pathForFile: (file) => {
    try {
      // Electron 32 之后必须用 webUtils 取拖放文件的绝对路径
      if (typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
      return file && typeof file.path === 'string' ? file.path : '';
    } catch {
      return '';
    }
  },
  onEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('skydrop:event', listener);
    return () => ipcRenderer.removeListener('skydrop:event', listener);
  },
};

contextBridge.exposeInMainWorld('skydrop', api);
