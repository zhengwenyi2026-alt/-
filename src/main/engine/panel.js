'use strict';

/**
 * 本机传输面板的前端脚本，由 dashboard.js 以 /panel.js 提供。
 * 只用 textContent 写动态值：文件名、设备名、路径都来自对端，属于不可信输入，
 * 走 innerHTML 就等于把「对方发一个带脚本的文件名」变成 XSS。
 */
(function () {
  const I = window.I18N;
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'skydrop-panel-lang';

  let lang = localStorage.getItem(LS_KEY) || I.DEFAULT_LANG;
  if (!I.isSupported(lang)) lang = I.DEFAULT_LANG;
  let langFollowed = !localStorage.getItem(LS_KEY); // 没手动选过时，跟随应用内语言一次

  let paused = false;
  let snap = null;
  let errorText = '';
  const openTasks = new Set(); // 记住哪些任务展开了文件明细，刷新后不折叠回去

  const t = (key, params) => I.t(key, params, lang);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  const LOCALE = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };

  function bytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i += 1;
    }
    return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
  }

  function rate(n) {
    const v = Number(n) || 0;
    return v > 0 ? `${bytes(v)}/s` : '—';
  }

  function dur(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return t('{n} 秒', { n: s });
    if (s < 3600) return t('{n} 分 {s} 秒', { n: Math.floor(s / 60), s: s % 60 });
    return t('{n} 小时 {m} 分', { n: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  }

  function clock(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleTimeString(LOCALE[lang] || 'zh-CN');
    } catch {
      return new Date(ts).toISOString();
    }
  }

  function pct(done, total) {
    const tt = Number(total) || 0;
    if (!tt) return 0;
    return Math.min(100, Math.max(0, ((Number(done) || 0) / tt) * 100));
  }

  const STATES = {
    pending: ['warn', '等待确认'],
    waiting: ['warn', '等待对方接收'],
    accepted: ['ok', '已开始'],
    transfer: ['ok', '传输中'],
    receiving: ['ok', '接收中'],
    sending: ['ok', '发送中'],
    done: ['ok', '完成'],
    declined: ['warn', '已拒绝'],
    error: ['err', '出错'],
  };

  // 文件级状态：pending 在这里是「还没轮到它传」，不是等用户确认
  const FILE_STATES = {
    pending: '排队中',
    receiving: '接收中',
    sending: '发送中',
    done: '完成',
    error: '出错',
  };

  function statePill(state) {
    const p = STATES[state] || ['warn', String(state || '—')];
    return el('span', `pill ${p[0]}`, t(p[1]));
  }

  function kv(label, value, mono) {
    const box = el('div', 'kv');
    box.appendChild(el('b', null, t(label)));
    const empty = value === null || value === undefined || value === '';
    box.appendChild(el('span', mono ? 'mono' : null, empty ? '—' : String(value)));
    return box;
  }

  function kvNode(label, node) {
    const box = el('div', 'kv');
    box.appendChild(el('b', null, t(label)));
    box.appendChild(node);
    return box;
  }

  function card(title, nodes) {
    const c = el('div', 'card');
    c.appendChild(el('h2', null, t(title)));
    for (const n of nodes) if (n) c.appendChild(n);
    return c;
  }

  function grid(items) {
    const g = el('div', 'grid');
    for (const i of items) g.appendChild(i);
    return g;
  }

  function table(cols, rows) {
    if (!rows.length) return el('div', 'empty', t('暂无数据'));
    const tb = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const c of cols) head.appendChild(el('th', null, t(c)));
    thead.appendChild(head);
    const body = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      for (const cell of r) {
        const td = el('td');
        // 单元格可能是节点（例如复制按钮）：el() 的 textContent 赋值会把节点变成 "[object …]" 字符串
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = String(cell);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    tb.appendChild(thead);
    tb.appendChild(body);
    return tb;
  }

  function progressBar(done, total) {
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${pct(done, total).toFixed(1)}%`;
    track.appendChild(fill);
    return track;
  }

  // ---------------------------------------------------------------- 各区块

  function overviewCard(s) {
    const a = s.app || {};
    const set = s.settings || {};
    const room = s.room;
    const relay = s.relay || {};
    const nodes = [
      grid([
        kv('设备名', s.self && s.self.name),
        kv('设备 ID', s.self && s.self.deviceId, true),
        kv('应用版本', `${a.version || '—'} · ${a.platform || '—'} ${a.arch || ''}`),
        kv('运行时长', dur(a.uptimeMs)),
        kv('面板地址', s.panel ? s.panel.url : null, true),
        kv('本机地址', (set.addresses || []).map((i) => i.address).join('、')),
        kv('接收保存目录', set.saveDir, true),
        kv('自动接收文件', set.autoAccept ? t('开') : t('关')),
        kv('自动允许加入', set.autoApprove ? t('开') : t('关')),
        kv('允许公网地址', set.allowPublic ? t('开') : t('关')),
        kv('端到端加密', set.e2ee === false ? t('关') : t('开')),
      ]),
      room
        ? grid([
            kvNode('房间状态', statePill('accepted')),
            kv('房间码', room.codeDisplay || room.code, true),
            kv('数据端口', room.port),
            kv('对方可用地址', room.connectHint, true),
            kv('自动发现', room.discovery === 'ok' ? t('可用') : t('不可用')),
            kv('本房间发送任务', room.sent || 0),
            kv('本房间接收任务', room.received || 0),
            kv('开启时间', clock(room.startedAt)),
          ])
        : el('div', 'empty', t('还没有创建房间')),
      s.joined
        ? grid([
            kv('已加入房间', s.joined.codeDisplay || s.joined.room, true),
            kv('房主', s.joined.name),
            kv('房主地址', s.joined.ip, true),
            kv('连接方式', s.joined.via === 'relay' ? t('互联网中继') : t('局域网直连')),
            kv('加密状态', secText(s.joined.sec)),
          ])
        : null,
      s.outgoing ? grid([kv('正在加入', s.outgoing.codeDisplay || s.outgoing.room, true), kv('目标', s.outgoing.host || s.outgoing.status)]) : null,
      grid([
        kv('跨网传输', relay.enabled ? t('已开启') : t('已关闭')),
        kv('服务商', relay.provider),
        kv('中继地址', relay.url, true),
        kv('中继状态', relay.status),
        kv('槽位连接数', relay.endpoints || 0),
        kv('中继错误', relay.error),
      ]),
    ];
    return card('概览', nodes);
  }

  /** 一条连接的加密状态，与窗口里的徽标同源 */
  function secText(sec) {
    if (!sec || !sec.active) {
      if (sec && sec.reason === 'off') return t('未加密：本机已关闭');
      if (sec && sec.reason === 'legacy') return t('未加密：对方未开启加密');
      if (sec && sec.reason === 'timeout') return t('未加密：对方没有响应加密握手');
      return t('未加密');
    }
    return t('已加密 · 指纹 {fp}', { fp: sec.fingerprint });
  }

  function peersCard(s) {
    const peers = (s.peers || []).map((p) => [
      p.name,
      p.ip,
      p.via === 'relay' ? t('互联网中继') : t('局域网直连'),
      secText(p.sec),
      dur(Date.now() - (p.since || Date.now())),
      p.deviceId,
    ]);
    const reqs = (s.joinRequests || []).map((r) => [r.name, r.ip, t('等待房主确认'), r.deviceId]);
    const vis = (s.visible || []).map((r) => [r.name, r.ip, r.room, String(r.port)]);
    return card('设备与连接', [
      table(['设备名', '地址', '连接方式', '加密', '已连接时长', '设备 ID'], peers),
      el('h2', null, t('等待确认的加入请求')),
      table(['设备名', '地址', '状态', '设备 ID'], reqs),
      el('h2', null, t('附近的房间')),
      table(['房间名', '地址', '房间码', '端口'], vis),
    ]);
  }

  function taskBox(o) {
    const box = el('div', 'task');
    const elapsed = o.startedAt ? Date.now() - o.startedAt : 0;
    const left = o.rate > 0 ? (((Number(o.totalSize) || 0) - (Number(o.bytes) || 0)) / o.rate) * 1000 : 0;
    box.appendChild(
      grid([
        kv('方向', o.dir === 'in' ? t('传入') : t('传出')),
        kv('对端', o.peerName),
        kvNode('状态', statePill(o.state)),
        kv('进度', `${pct(o.bytes, o.totalSize).toFixed(1)}%`),
        kv('已传 / 总大小', `${bytes(o.bytes)} / ${bytes(o.totalSize)}`),
        kv('速率', rate(o.rate)),
        kv('剩余时间', left > 0 ? dur(left) : null),
        kv('已用时间', elapsed ? dur(elapsed) : null),
        kv('文件数', o.files.length),
        kv('任务号', `${o.id} · ${o.transferId}`, true),
        kv('保存位置', o.savedTo, true),
      ])
    );
    box.appendChild(progressBar(o.bytes, o.totalSize));

    const detailId = `task-${o.id}`;
    const detail = el('div');
    const buildDetail = () =>
      table(
        ['文件名', '大小', '已传', '进度', '状态'],
        o.files.map((f) => [
          f.rel || f.name,
          bytes(f.size),
          bytes(f.bytes),
          `${pct(f.bytes, f.size).toFixed(1)}%`,
          t(FILE_STATES[f.state] || String(f.state)),
        ])
      );
    const toggle = el('button', null, t(openTasks.has(detailId) ? '收起文件明细' : '展开文件明细'));
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      if (openTasks.has(detailId)) {
        openTasks.delete(detailId);
        detail.replaceChildren();
        toggle.textContent = t('展开文件明细');
      } else {
        openTasks.add(detailId);
        detail.replaceChildren(buildDetail());
        toggle.textContent = t('收起文件明细');
      }
    });
    if (openTasks.has(detailId)) detail.replaceChildren(buildDetail());
    box.appendChild(toggle);
    box.appendChild(detail);
    return box;
  }

  function offersCard(s) {
    const list = s.offers || [];
    if (!list.length) return card('传输任务', [el('div', 'empty', t('当前没有进行中的传输'))]);
    return card('传输任务', list.map(taskBox));
  }

  function historyCard(s) {
    const rows = (s.history || []).map((h) => [
      clock(h.at),
      h.dir === 'in' ? t('传入') : t('传出'),
      h.peerName || '—',
      String((h.files || []).length),
      bytes(h.totalSize),
      (STATES[h.state] || ['warn', String(h.state)])[0] === 'ok' ? t('成功') : t('失败'),
      h.savedTo || '—',
    ]);
    return card('历史记录', [table(['时间', '方向', '对端', '文件数', '大小', '结果', '保存位置'], rows)]);
  }

  // 面板页面跑在 http://localhost 上（属于安全上下文），优先用异步 Clipboard API，
  // 失败时退回 textarea + execCommand 的老办法。
  async function copyPlain(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  function textsCard(s) {
    const list = s.texts || [];
    if (!list.length) return card('传送的文本', [el('div', 'empty', t('还没有传送过的文本。'))]);
    const rows = list.map((x) => {
      const full = String(x.text || '');
      const shown = full.length > 300 ? `${full.slice(0, 300)}…` : full;
      const btn = el('button', null, t('复制'));
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const done = await copyPlain(full);
        btn.textContent = done ? t('已复制') : t('复制失败');
        setTimeout(() => {
          btn.textContent = t('复制');
          btn.disabled = false;
        }, 1200);
      });
      return [clock(x.at), x.dir === 'in' ? t('传入') : t('传出'), x.peerName || '—', bytes(x.size), shown, btn];
    });
    return card('传送的文本', [table(['时间', '方向', '对端', '大小', '文本', ''], rows)]);
  }

  function totalsCard(s) {
    const x = s.totals || {};
    return card('统计', [
      grid([
        kv('累计发送', bytes(x.sentBytes)),
        kv('累计接收', bytes(x.recvBytes)),
        kv('发送文件数', x.sentFiles),
        kv('接收文件数', x.recvFiles),
        kv('完成任务', x.ok),
        kv('失败任务', x.failed),
        kv('被拒绝任务', x.declined),
        kv('峰值速率', rate(x.peakRate)),
        kv('进行中任务', x.active),
        kv('进行中已传', `${bytes(x.activeBytes)} / ${bytes(x.activeSize)}`),
      ]),
    ]);
  }

  function limitsCard(s) {
    const l = s.limits || {};
    // 这些值必须由词典带参数生成：直接拼中文字面量的话，切到英文/日文就只剩半句中文
    const backoff = (l.relayBackoff || []).map((x) => t('{n} 秒', { n: Math.round(x / 1000) })).join(' → ');
    return card('协议与参数', [
      grid([
        kv('协议版本', l.proto),
        kv('端到端加密', l.e2eeVersion ? `v${l.e2eeVersion} · X25519 + AES-256-GCM` : t('未启用')),
        kv('加密帧开销', t('{n} 字节', { n: l.e2eeOverhead })),
        kv('指纹', t('{n} 位 · 字符集 {m}', { n: l.e2eeFpLength, m: l.e2eeFpAlphabet })),
        kv('分片大小', bytes(l.chunkSize)),
        kv('分片帧头', t('{n} 字节', { n: l.headerSize })),
        kv('并发分片', l.sendPipeline),
        kv('单任务文件上限', l.maxFilesPerOffer),
        kv('单条文本上限', bytes(l.textMaxBytes)),
        kv('房间人数上限', l.maxPeers),
        kv('房间码长度', t('{n} 位 · 字符集 {m}', { n: l.codeLength, m: l.codeAlphabetSize })),
        kv('错误房间码封禁', t('{n} 次/来源', { n: l.maxBadCodes })),
        kv('历史保留', t('{n} 条', { n: l.historyKeep })),
        kv('发现端口 UDP', l.udpPort),
        kv('数据端口范围', `${l.tcpBasePort}–${l.tcpBasePort + (l.tcpPortSpan || 13) - 1}`),
        kv('面板端口', t('{n} 起顺延（仅 127.0.0.1）', { n: l.panelBasePort })),
        kv('中继槽位', l.relaySlots),
        kv('中继心跳', t('{n} 秒', { n: Math.round((l.relayPingMs || 0) / 1000) })),
        kv('配对超时', t('{n} 秒', { n: Math.round((l.pairTimeoutMs || 0) / 1000) })),
        kv('重连退避', backoff),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 渲染

  function renderStatic() {
    document.documentElement.lang = lang;
    document.title = t('SkyDrop 传输面板');
    $('pageTitle').textContent = t('SkyDrop 传输面板');
    $('langLabel').textContent = t('语言');
    $('pauseBtn').textContent = paused ? t('继续刷新') : t('暂停刷新');
    $('foot').textContent = t('面板只监听 127.0.0.1，局域网里的其它设备打不开这个页面；数据每 1 秒从本机引擎读取一次。');
  }

  function render() {
    const main = $('app');
    if (!snap) {
      const box = el('div', 'card');
      box.appendChild(errorText ? el('span', 'pill err', errorText) : el('span', 'empty', t('加载中…')));
      main.replaceChildren(box);
      return;
    }
    const s = snap;
    const bar = el('div', 'bar');
    bar.appendChild(el('span', 'pill', t('更新于 {time}', { time: clock(s.at) })));
    if (errorText) bar.appendChild(el('span', 'pill err', errorText));
    main.replaceChildren(bar, overviewCard(s), offersCard(s), peersCard(s), historyCard(s), textsCard(s), totalsCard(s), limitsCard(s));
  }

  async function poll() {
    if (paused) return;
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      snap = await res.json();
      errorText = '';
      if (langFollowed && I.isSupported(snap.language) && snap.language !== lang) {
        lang = snap.language;
        langFollowed = false;
        renderStatic();
        fillLangSelect();
      }
    } catch (err) {
      errorText = t('读取失败：{msg}', { msg: (err && err.message) || String(err) });
    }
    render();
  }

  function fillLangSelect() {
    const sel = $('langSel');
    sel.replaceChildren();
    for (const l of I.LANGS) {
      const o = el('option', null, l.native);
      o.value = l.code;
      sel.appendChild(o);
    }
    sel.value = lang;
  }

  function boot() {
    renderStatic();
    fillLangSelect();
    $('langSel').addEventListener('change', (e) => {
      lang = I.isSupported(e.target.value) ? e.target.value : I.DEFAULT_LANG;
      langFollowed = false;
      localStorage.setItem(LS_KEY, lang);
      renderStatic();
      render();
    });
    $('pauseBtn').addEventListener('click', () => {
      paused = !paused;
      renderStatic();
      if (!paused) poll();
    });
    poll();
    setInterval(poll, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
