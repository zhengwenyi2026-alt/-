'use strict';

const api = window.skydrop;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 多语言
// 词典由 src/common/i18n.js 提供（主进程用同一份）。中文原文即 key，
// 未命中译文时自动回显中文，所以新增文案不会因为没有翻译而显示空白。
const I18N = window.I18N;
let LANG = I18N.DEFAULT_LANG;
// 参数值本身也可能是待翻译原文（例如「对方拒绝接收」），所以先翻译参数再填模板。
const t = (key, params) => {
  const mapped = {};
  for (const [k, v] of Object.entries(params || {})) mapped[k] = typeof v === 'string' ? I18N.t(v, null, LANG) : v;
  return I18N.t(key, mapped, LANG);
};

const S = {
  state: null,
  picked: [], // [{ path, name, size, isDir }]
  selected: new Set(), // 已勾选的目标设备 id
  scanning: false,
};

// 跨网传输：服务商 → 该服务商的填写指引（中文原文，渲染时查词典）
const RELAY_HELP = {
  cloudflare: '部署 relay/cloudflare 里的 Worker，再把 xxx.workers.dev 地址粘贴到上面。',
  vercel: '部署 relay/vercel 里的服务，再把 xxx.vercel.app 地址粘贴到上面（Vercel 的 WebSocket 需要在项目里开启 Fluid 计算）。',
  custom: '填自建中继的地址，例如 relay.example.com 或 1.2.3.4:8790（node relay/node-server.js 起的就是这种）。',
  ngrok: '点「启动隧道」：本机起一个中继并让 ngrok 给它一个公网地址，把地址发给对方，对方粘到「自建 / 其它」的中继地址里即可。',
};

// ngrok 只有应用内检测到才可选项里出现
const RELAY_PROVIDERS = ['cloudflare', 'vercel', 'custom', 'ngrok'];

function activeProvider(st) {
  const tun = (st && st.tunnel) || {};
  const p = (st && st.relay && st.relay.provider) || 'cloudflare';
  if (p === 'ngrok' && !tun.installed) return 'cloudflare';
  return RELAY_PROVIDERS.includes(p) ? p : 'cloudflare';
}

/** 把 HTML 里带 data-i18n* 的静态文案换成当前语言 */
function applyStatic() {
  document.documentElement.lang = LANG;
  document.title = t('隔空传 SkyDrop');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.getAttribute('data-i18n'));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.getAttribute('data-i18n-title'));
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria')));
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
  renderLangList();
}

function renderLangList() {
  const box = $('langList');
  if (!box) return;
  clear(box);
  for (const item of I18N.LANGS) {
    const row = el('button', `langrow${item.code === LANG ? ' on' : ''}`);
    row.appendChild(el('span', 'native', item.native));
    // 原生名和英文名相同时（English）不必重复一遍
    if (item.english !== item.native) row.appendChild(el('span', 'english', item.english));
    if (item.code === LANG) row.appendChild(el('span', 'tick', '✓'));
    row.addEventListener('click', async () => {
      await call(api.setSettings({ language: item.code }));
      await refresh();
    });
    box.appendChild(row);
  }
  const sel = $('setLang');
  if (sel) {
    clear(sel);
    for (const item of I18N.LANGS) {
      const opt = el('option', null, item.native);
      opt.value = item.code;
      opt.selected = item.code === LANG;
      sel.appendChild(opt);
    }
  }
}


// ---------------------------------------------------------------- 小工具

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do {
    x /= 1024;
    i += 1;
  } while (x >= 1024 && i < units.length - 1);
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtRate(bps) {
  const v = Number(bps) || 0;
  return v > 0 ? `${fmtBytes(v)}/s` : '—';
}

function fmtLeft(sec) {
  if (!Number.isFinite(sec) || sec <= 0 || sec > 24 * 3600) return '';
  if (sec < 60) return t('剩余约 {s} 秒', { s: Math.ceil(sec) });
  return t('剩余约 {m} 分 {s} 秒', { m: Math.floor(sec / 60), s: Math.ceil(sec % 60) });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function hint(text) {
  return el('p', 'hint', text);
}

let renderQueued = false;
// 用 setTimeout 合帧而不是 requestAnimationFrame：窗口被遮挡时 rAF 会停摆，
// 那样后台进行中的传输就再也刷不出进度了。
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 50);
}

function toast(msg, level = 'info') {
  if (!msg) return;
  const box = $('toasts');
  // 同一条消息在展示期间只弹一次：加入失败会同时走 join-error 事件和 IPC 返回值，两条一模一样
  const last = box.lastElementChild;
  if (last && last.dataset.msg === msg) return;
  const node = el('div', `toast ${level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'success' ? 'success' : ''}`, msg);
  node.dataset.msg = msg;
  box.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, 3600);
  while (box.children.length > 4) box.removeChild(box.firstChild);
}

async function call(promise, silent = false) {
  try {
    const res = await promise;
    if (res && res.ok === false && !silent) toast(t(res.error || '操作失败'), 'error');
    return res && res.ok === false ? undefined : res && res.data;
  } catch (err) {
    if (!silent) toast(t(err.message || '操作失败'), 'error');
    return undefined;
  }
}

async function refresh() {
  const state = await api.getState();
  const nextLang = state && state.settings && state.settings.language ? state.settings.language : I18N.DEFAULT_LANG;
  S.state = state;
  if (nextLang !== LANG) {
    LANG = nextLang;
    applyStatic();
  }
  syncSettingsInputs(state);
  scheduleRender();
}

// ---------------------------------------------------------------- 渲染

function render() {
  const st = S.state;
  if (!st) return;
  renderHeader(st);
  renderHost(st);
  renderJoin(st);
  renderRelay(st);
  renderSend(st);
  renderActive(st);
  renderHistory(st);
  renderTexts(st);
  renderRequests(st);
}

function renderHeader(st) {
  $('deviceName').textContent = st.self.name;
  const addrs = st.settings.addresses || [];
  const chip = $('netChip');
  chip.textContent = addrs.length
    ? t('局域网 {ip}', { ip: `${addrs[0].address}${addrs.length > 1 ? ` +${addrs.length - 1}` : ''}` })
    : t('未检测到局域网连接');
  chip.classList.toggle('muted', true);
  $('aboutText').textContent = t('版本 {ver} · {plat}', { ver: st.app ? st.app.version : t('开发版'), plat: st.app ? st.app.platform : 'dev' });
  $('saveDir').textContent = st.settings.saveDir;
}

function peerRow(peer, extra) {
  const row = el('div', 'peer');
  const viaRelay = peer.via === 'relay';
  const avatar = el('div', 'avatar', (peer.name || '?').trim().slice(0, 1).toUpperCase());
  const meta = el('div', 'meta');
  meta.appendChild(el('b', null, t(peer.name || '未命名设备')));
  meta.appendChild(
    el(
      'small',
      null,
      viaRelay
        ? t('经中继连接 · {time}', { time: fmtTime(peer.since) })
        : peer.ip
          ? t('{ip} · 连接于 {time}', { ip: peer.ip, time: fmtTime(peer.since) })
          : t('未知地址')
    )
  );
  row.appendChild(avatar);
  row.appendChild(meta);
  if (viaRelay) row.appendChild(el('span', 'via', t('互联网中继')));
  if (extra) row.appendChild(extra);
  return row;
}

/** 中继当前的可用状态，用中文原文之外的语言查词典后展示 */
function relayStateText(st) {
  const r = st.relay || {};
  if (!r.enabled) return t('未开启');
  // ngrok 这一路的「中继地址」就是隧道地址，没启动隧道时无从填写，提示要指着按钮说
  if (activeProvider(st) === 'ngrok' && (st.tunnel || {}).status !== 'running') return t('先启动隧道');
  if (!String(r.url || '').trim()) return t('请先填写中继地址');
  if (!st.room) return t('已开启 · 创建房间后自动挂上');
  if (r.status === 'error') return t('中继不可用：{msg}', { msg: r.error || t('未知原因') });
  if (r.status === 'ready') return t('已开放 · {n} 条空闲通道', { n: r.endpoints || 0 });
  if (r.status === 'retrying') return t('中继连接中断，正在重试');
  if (r.status === 'connecting') return t('正在接入中继…');
  return t('等待中继响应');
}

function renderRelay(st) {
  const r = st.relay || {};
  const tun = st.tunnel || {};
  // 没开启时只留一个开关，避免界面里长期挂着一段用不上的配置
  $('relayBody').hidden = !r.enabled;
  const provider = activeProvider(st);
  const usingNgrok = provider === 'ngrok';
  // 没检测到 ngrok：下拉里不留这一项，隧道配置块也整个不出现
  $('ngrokOption').hidden = !tun.installed;
  $('ngrokBox').hidden = !tun.installed;
  $('relayUrlField').hidden = usingNgrok;
  if (tun.installed) renderTunnel(st);
  const filled = String(r.url || '').trim();
  $('relayHelp').textContent = t(
    usingNgrok
      ? filled
        ? RELAY_HELP.ngrok
        : '点「启动隧道」，本机自动起一个中继并拿到公网地址，再把地址发给对方。'
      : filled
        ? RELAY_HELP[provider]
        : '填好地址后点「测试连接」，通了再创建房间。'
  );
  const state = $('relayState');
  state.textContent = relayStateText(st);
  state.className = r.enabled && r.status === 'ready' ? 'ok' : r.enabled && r.status === 'error' ? 'bad' : '';
  $('relayTestBtn').disabled = usingNgrok || !String($('setRelayUrl').value || '').trim();
  $('joinRelayBtn').classList.toggle('mutedbtn', !(r.enabled && Boolean(filled)));
}

/** 隧道状态一句话说清楚，异常时直接带上 ngrok 给出的原因 */
function tunnelStateText(st) {
  const u = st.tunnel || {};
  if (!u.installed) return t('未检测到 ngrok');
  if (u.status === 'running') return t('隧道运行中');
  if (u.status === 'starting') return t('正在启动隧道…');
  if (u.status === 'error') return t('隧道异常：{msg}', { msg: u.error || t('未知原因') });
  return t('未启动');
}

function renderTunnel(st) {
  const u = st.tunnel || {};
  const running = u.status === 'running';
  const starting = u.status === 'starting';
  $('tunnelStartBtn').hidden = running;
  $('tunnelStartBtn').disabled = starting;
  // 域名改了要重连才生效，运行中直接锁住，避免出现「界面写的和实际通的不一样」
  $('ngrokDomain').disabled = running || starting;
  $('tunnelStopBtn').hidden = !running;
  $('tunnelUrl').textContent = running ? u.url : '—';
  $('tunnelUrl').className = running ? 'ok' : u.status === 'error' ? 'bad' : '';
  $('tunnelCopyBtn').hidden = !running;
  const label = $('tunnelState');
  label.textContent = tunnelStateText(st);
  label.className = running ? 'ok' : u.status === 'error' ? 'bad' : '';
}

function renderHost(st) {
  $('hostIdle').hidden = Boolean(st.room);
  $('hostLive').hidden = !st.room;
  if (!st.room) return;
  $('roomCode').textContent = st.room.codeDisplay;
  $('roomPort').textContent = String(st.room.port);
  $('roomHint').textContent = st.room.connectHint || '—';
  const r = st.relay || {};
  const note = $('relayNote');
  const on = r.enabled && Boolean(String(r.url || '').trim());
  note.hidden = !on;
  if (on) {
    note.textContent =
      r.status === 'ready' ? t('已通过中继开放：对方在任意网络输入房间码 {code} 都能连上', { code: st.room.codeDisplay }) : relayStateText(st);
    note.className = `hint relaynote ${r.status === 'ready' ? 'ok' : r.status === 'error' ? 'bad' : ''}`;
  }
  const box = $('hostPeers');
  clear(box);
  if (st.joinRequests.length) box.appendChild(hint(t('{n} 个加入请求待处理（右下角）', { n: st.joinRequests.length })));
  if (!st.peers.length) box.appendChild(hint(t('还没有设备加入。把房间码发给对方，或让对方扫描。')));
  else box.appendChild(el('div', 'targets-label', t('已连接 {n} 台设备', { n: st.peers.length })));
  for (const p of st.peers) box.appendChild(peerRow(p));
}

function renderJoin(st) {
  const pending = Boolean(st.outgoing);
  $('joinIdle').hidden = pending || Boolean(st.joined);
  $('joinPending').hidden = !pending;
  $('joinLive').hidden = !st.joined || pending;
  if (pending) {
    const map = {
      discovering: t('正在局域网里查找房间 {code}…', { code: st.outgoing.codeDisplay }),
      connecting: t('正在连接 {host}…', { host: st.outgoing.host || t('对方设备') }),
      relaying: t('正在通过中继连接房间 {code}…', { code: st.outgoing.codeDisplay }),
      'waiting-approve': t('已连接，等待 {host} 点「允许」…', { host: st.outgoing.host || t('房主') }),
    };
    $('joinStatus').textContent = map[st.outgoing.status] || t('连接中…');
  }
  if (st.joined) {
    $('joinedRoom').textContent = st.joined.codeDisplay || st.joined.room;
    $('joinedHost').textContent = `${st.joined.name || st.joined.ip || t('互联网中继')}${st.joined.via === 'relay' ? t('（经中继）') : ''}`;
    const box = $('guestPeers');
    clear(box);
    for (const p of st.peers) box.appendChild(peerRow(p));
  }
  if (!S.scanning && st.visible && st.visible.length) renderNearby(st.visible);
  else if (!st.visible || !st.visible.length) {
    const list = $('nearbyList');
    if (!list.querySelector('.near') && !S.scanning) {
      clear(list);
      list.appendChild(hint(t('点「重新扫描」查找同一局域网内已开启的房间。')));
    }
  }
}

function renderNearby(rooms) {
  const list = $('nearbyList');
  clear(list);
  if (!rooms.length) {
    list.appendChild(hint(t('没有发现其它房间。让对方先点「创建房间」。')));
    return;
  }
  for (const r of rooms) {
    const row = el('div', 'near');
    row.appendChild(el('b', null, r.name || t('未命名设备')));
    row.appendChild(el('code', null, r.room));
    row.appendChild(el('span', 'muted', r.ip));
    const btn = el('button', 'ghost small', t('加入'));
    btn.addEventListener('click', () => {
      $('codeInput').value = r.room;
      doJoin(r.room);
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function renderSend(st) {
  const list = $('fileList');
  clear(list);
  let total = 0;
  for (const item of S.picked) {
    total += item.size || 0;
    const li = el('li');
    li.appendChild(el('span', 'fi', item.isDir ? '▤' : '▢'));
    li.appendChild(el('span', 'fn', item.name)).title = item.path;
    li.appendChild(el('span', 'fs', item.isDir ? t('文件夹') : fmtBytes(item.size)));
    const rm = el('button', 'rm', '×');
    rm.title = t('从清单移除');
    rm.addEventListener('click', () => {
      S.picked = S.picked.filter((p) => p.path !== item.path);
      scheduleRender();
    });
    li.appendChild(rm);
    list.appendChild(li);
  }
  const peers = st.peers || [];
  const alive = new Set(peers.map((p) => p.deviceId));
  S.selected = new Set([...S.selected].filter((id) => alive.has(id)));
  if (!S.selected.size) for (const p of peers) S.selected.add(p.deviceId);

  const tl = $('targetList');
  clear(tl);
  if (!peers.length) tl.appendChild(el('em', 'hint', st.room ? t('等待对方加入后就能发送') : t('先创建房间，或输入房间码加入对方的房间')));
  for (const p of peers) {
    const chip = el('button', `target${S.selected.has(p.deviceId) ? ' on' : ''}`);
    const tick = el('span', 'tick', S.selected.has(p.deviceId) ? '✓' : '');
    chip.appendChild(tick);
    chip.appendChild(el('span', null, p.name));
    if (p.via === 'relay') chip.appendChild(el('span', 'via', t('中继')));
    chip.addEventListener('click', () => {
      if (S.selected.has(p.deviceId)) S.selected.delete(p.deviceId);
      else S.selected.add(p.deviceId);
      scheduleRender();
    });
    tl.appendChild(chip);
  }
  $('sendSummary').textContent = S.picked.length
    ? t('{n} 项 · {size} · 发给 {sel}/{tot} 台设备', { n: S.picked.length, size: fmtBytes(total), sel: S.selected.size, tot: peers.length })
    : t('未选择文件');
  $('sendBtn').disabled = !S.picked.length || !peers.length || !S.selected.size;
  $('clearBtn').disabled = !S.picked.length;
  updateTextButtons();
}

/** 文本发送按钮跟随「有内容 + 有已连接设备」两个条件 */
function updateTextButtons() {
  const has = Boolean($('textInput') && $('textInput').value.trim());
  const peers = (S.state && S.state.peers) || [];
  const disabled = !has || !peers.length;
  if ($('sendTextBtn')) $('sendTextBtn').disabled = disabled;
  if ($('sendTextFileBtn')) $('sendTextFileBtn').disabled = disabled;
}

function renderActive(st) {
  const box = $('activeList');
  clear(box);
  const offers = (st.offers || []).filter((o) => o.state !== 'done' && o.state !== 'error');
  $('activityCount').textContent = offers.length ? t('{n} 个任务进行中', { n: offers.length }) : '';
  if (!offers.length) {
    box.appendChild(hint(t('暂无传输任务。')));
    return;
  }
  for (const o of offers) box.appendChild(taskCard(o));
}

function taskCard(o) {
  const card = el('div', 'task');
  const head = el('div', 'task-head');
  head.appendChild(el('span', `dir ${o.dir}`, o.dir === 'in' ? '↓' : '↑'));
  head.appendChild(el('span', 'who', `${o.dir === 'in' ? t('接收自') : t('发送给')} ${o.peerName}`));
  const pct = o.totalSize ? Math.round((Math.min(o.bytes, o.totalSize) / o.totalSize) * 100) : 0;
  head.appendChild(el('span', 'pct', `${pct}%`));
  card.appendChild(head);

  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const foot = el('div', 'task-foot');
  const left = o.rate > 0 && o.totalSize - o.bytes > 0 ? fmtLeft((o.totalSize - o.bytes) / o.rate) : '';
  foot.appendChild(el('span', null, `${fmtBytes(o.bytes)} / ${fmtBytes(o.totalSize)}`));
  foot.appendChild(
    el(
      'span',
      null,
      o.state === 'waiting' ? t('等待对方点「接收」') : o.state === 'accepted' ? t('等待对方开始发送') : `${fmtRate(o.rate)} ${left}`.trim()
    )
  );
  card.appendChild(foot);

  if (o.files.length > 1) {
    const ul = el('ul', 'task-files');
    for (const f of o.files.slice(0, 8)) {
      const li = el('li');
      const cls = f.state === 'done' ? 'done' : f.state === 'error' ? 'error' : f.state === 'sending' || f.state === 'receiving' ? 'active' : '';
      li.appendChild(el('span', `s ${cls}`));
      li.appendChild(el('span', null, `${f.rel || f.name} · ${fmtBytes(f.size)}`));
      ul.appendChild(li);
    }
    if (o.files.length > 8) ul.appendChild(el('li', null, t('…共 {n} 个文件', { n: o.files.length })));
    card.appendChild(ul);
  }
  return card;
}

function renderHistory(st) {
  const box = $('historyList');
  clear(box);
  const items = st.history || [];
  if (!items.length) {
    box.appendChild(hint(t('还没有完成过的传输。')));
    return;
  }
  for (const h of items.slice(0, 12)) {
    const row = el('div', 'hist');
    row.appendChild(el('span', `dir ${h.dir}`, h.dir === 'in' ? '↓' : '↑'));
    const txt = el('div', 'txt');
    txt.appendChild(
      el('b', null, `${h.dir === 'in' ? t('收到') : t('发出')} ${h.peerName || ''} · ${t('{n} 个文件', { n: h.files.length })} · ${fmtBytes(h.totalSize)}`)
    );
    txt.appendChild(el('small', null, h.files.map((f) => f.rel || f.name).join('、')));
    row.appendChild(txt);
    row.appendChild(el('span', 'muted', fmtTime(h.at)));
    const target = (h.files.find((f) => f.path) || {}).path;
    if (target) {
      const btn = el('button', 'linkbtn', t('位置'));
      btn.addEventListener('click', () => call(api.reveal(target)));
      row.appendChild(btn);
    }
    box.appendChild(row);
  }
}

function renderTexts(st) {
  const box = $('textList');
  clear(box);
  const items = st.texts || [];
  if (!items.length) {
    box.appendChild(hint(t('还没有传送过的文本。')));
    return;
  }
  for (const x of items.slice(0, 30)) {
    const row = el('div', 'hist text-item');
    row.appendChild(el('span', `dir ${x.dir}`, x.dir === 'in' ? '↓' : '↑'));
    const txt = el('div', 'txt');
    txt.appendChild(
      el('b', null, `${x.dir === 'in' ? t('收到') : t('发出')} ${x.peerName || ''} · ${fmtBytes(x.size)} · ${fmtTime(x.at)}`)
    );
    const body = el('p', 'textbody', x.text.length > 400 ? `${x.text.slice(0, 400)}…` : x.text);
    body.title = t('点击展开完整文本');
    body.addEventListener('click', () => {
      body.classList.toggle('expanded');
      body.classList.contains('expanded') ? body.replaceChildren(x.text) : body.replaceChildren(x.text.length > 400 ? `${x.text.slice(0, 400)}…` : x.text);
    });
    txt.appendChild(body);
    row.appendChild(txt);
    const btn = el('button', 'linkbtn', t('复制'));
    btn.addEventListener('click', () => {
      api.copy(x.text);
      toast(t('已复制文本'), 'success');
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
}

function renderRequests(st) {
  const box = $('requests');
  clear(box);
  for (const req of st.joinRequests || []) {
    const card = el('div', 'req');
    card.appendChild(el('h4', null, t('{name} 想加入房间', { name: req.name })));
    card.appendChild(el('p', null, t('来自 {ip}。允许后对方就能向你发送文件。', { ip: req.ip })));
    const actions = el('div', 'req-actions');
    const deny = el('button', null, t('拒绝'));
    deny.addEventListener('click', () => call(api.approveJoin(req.deviceId, false)));
    const allow = el('button', 'accept', t('允许'));
    allow.addEventListener('click', () => call(api.approveJoin(req.deviceId, true)));
    actions.appendChild(deny);
    actions.appendChild(allow);
    card.appendChild(actions);
    box.appendChild(card);
  }
  for (const o of (st.offers || []).filter((x) => x.dir === 'in' && x.state === 'pending')) {
    const card = el('div', 'req');
    card.appendChild(el('h4', null, t('{name} 想发送 {n} 个文件', { name: o.peerName, n: o.files.length })));
    const ul = el('ul');
    for (const f of o.files.slice(0, 6)) ul.appendChild(el('li', null, `${f.rel || f.name} · ${fmtBytes(f.size)}`));
    if (o.files.length > 6) ul.appendChild(el('li', null, t('…共 {n} 个文件', { n: o.files.length })));
    card.appendChild(ul);
    card.appendChild(el('p', null, t('将保存到 {dir}', { dir: o.savedTo || st.settings.saveDir })));
    const actions = el('div', 'req-actions');
    const deny = el('button', null, t('拒绝'));
    deny.addEventListener('click', () => call(api.respondOffer(o.id, false)));
    const accept = el('button', 'accept', t('接收'));
    accept.addEventListener('click', () => call(api.respondOffer(o.id, true)));
    actions.appendChild(deny);
    actions.appendChild(accept);
    card.appendChild(actions);
    box.appendChild(card);
  }
}

// ---------------------------------------------------------------- 行为

function normalizeRoomInput(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 7);
}

async function doJoin(code) {
  const value = code || $('codeInput').value;
  if (!/^[A-Z0-9]{6}$/.test(String(value).replace(/-/g, ''))) {
    toast(t('房间码应为 6 位字母或数字'), 'warn');
    return;
  }
  // join 失败的提示由 join-error 事件统一弹（带附近房间等上下文）；这里的 IPC 错误静默，避免双份弹窗
  await call(api.join(value), true);
  await refresh();
}

/** 明确经中继加入：局域网发现失败时引擎也会自动走到这条路上 */
async function doJoinRelay(code) {
  const value = code || $('codeInput').value;
  if (!/^[A-Z0-9]{6}$/.test(String(value).replace(/-/g, ''))) {
    toast(t('房间码应为 6 位字母或数字'), 'warn');
    return;
  }
  await call(api.joinRelay(value), true);
  await refresh();
}

async function addPaths(paths) {
  if (!paths || !paths.length) return;
  const res = await call(api.preview(paths));
  if (!res) return;
  const known = new Set(S.picked.map((p) => p.path));
  for (const item of res.items) if (!known.has(item.path)) S.picked.push(item);
  if (res.truncated) toast(t('仅加入前 {n} 项', { n: res.items.length }), 'warn');
  scheduleRender();
}

function bindStatic() {
  $('createRoomBtn').addEventListener('click', async () => {
    await call(api.startRoom());
    await refresh();
  });
  $('closeRoomBtn').addEventListener('click', async () => {
    await call(api.stopRoom());
    await refresh();
  });
  $('copyCodeBtn').addEventListener('click', () => {
    const code = S.state && S.state.room ? S.state.room.code : '';
    if (!code) return;
    api.copy(code);
    toast(t('已复制房间码 {code}', { code }), 'success');
  });
  $('copyAddrBtn').addEventListener('click', () => {
    // connectHint 可能是多块网卡用顿号连起来的，直连只认单个 IP:端口，取第一块网卡的
    const addr = ($('roomHint').textContent || '').split('、')[0].trim();
    if (!addr || addr === '—') return;
    api.copy(addr);
    toast(t('已复制'), 'success');
  });
  $('joinBtn').addEventListener('click', () => doJoin());
  $('joinRelayBtn').addEventListener('click', () => {
    const r = S.state && S.state.relay;
    if (!r || !r.enabled || !String(r.url || '').trim()) {
      // 地址都没填就别让请求空跑，直接把用户带到配置入口
      toast(t('请先在「跨网传输」里填好中继地址'), 'warn');
      $('relayCard').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    doJoinRelay();
  });
  $('codeInput').addEventListener('input', (e) => {
    e.target.value = normalizeRoomInput(e.target.value);
  });
  $('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  $('joinDirectBtn').addEventListener('click', async () => {
    const addr = $('addrInput').value.trim();
    if (!addr) {
      toast(t('请输入对方的 IP 地址'), 'warn');
      return;
    }
    await call(api.joinDirect(addr, $('codeInput').value));
    await refresh();
  });
  $('cancelJoinBtn').addEventListener('click', async () => {
    await call(api.cancelJoin());
    await refresh();
  });
  $('leaveBtn').addEventListener('click', async () => {
    await call(api.leave());
    await refresh();
  });
  $('scanBtn').addEventListener('click', async () => {
    S.scanning = true;
    const list = $('nearbyList');
    clear(list);
    const spin = el('div', 'waiting');
    spin.appendChild(el('span', 'spinner'));
    spin.appendChild(el('span', null, t('正在查找附近的房间…')));
    list.appendChild(spin);
    await call(api.scan());
    S.scanning = false;
    await refresh();
  });
  $('pickBtn').addEventListener('click', async () => {
    const paths = await api.pick();
    await addPaths(paths);
  });
  $('clearBtn').addEventListener('click', () => {
    S.picked = [];
    scheduleRender();
  });
  $('sendBtn').addEventListener('click', async () => {
    const paths = S.picked.map((p) => p.path);
    const res = await call(api.send([...S.selected], paths));
    if (res) {
      S.picked = [];
      toast(t('已发起传送：{n} 个文件', { n: res.count }), 'success');
    }
    await refresh();
  });
  const doSendText = async (asFile) => {
    const text = $('textInput').value;
    if (!text.trim()) {
      toast(t('文本内容为空'), 'warn');
      return;
    }
    const res = await call(api.sendText({ peerIds: [...S.selected], text, asFile }));
    if (res) {
      $('textInput').value = '';
      updateTextButtons();
      toast(asFile ? t('已生成 TXT 并发起传送') : t('文本已发送'), 'success');
    }
    await refresh();
  };
  $('sendTextBtn').addEventListener('click', () => doSendText(false));
  $('sendTextFileBtn').addEventListener('click', () => doSendText(true));
  $('textInput').addEventListener('input', updateTextButtons);
  $('textInput').addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter 直接发纯文本，与文件传送的快捷键区分开
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSendText(false);
    }
  });
  $('clearTextsBtn').addEventListener('click', async () => {
    await call(api.clearTexts());
    await refresh();
  });
  $('openSaveDirBtn').addEventListener('click', () => call(api.openSaveDir()));
  $('changeSaveDirBtn').addEventListener('click', async () => {
    await call(api.pickSaveDir());
    await refresh();
  });

  // 拖拽：整窗可投放，dropzone 高亮
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    $('dropzone').classList.add('hover');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropzone').classList.remove('hover');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('hover');
    const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      toast(t('没能读取到文件路径，请改用「浏览选择」'), 'warn');
      return;
    }
    await addPaths(paths);
  });

  $('langBtn').addEventListener('click', () => {
    renderLangList();
    $('langOverlay').hidden = false;
  });
  $('langClose').addEventListener('click', () => {
    $('langOverlay').hidden = true;
  });
  $('langOverlay').addEventListener('click', (e) => {
    if (e.target === $('langOverlay')) $('langOverlay').hidden = true;
  });
  $('setLang').addEventListener('change', async () => {
    await call(api.setSettings({ language: $('setLang').value }));
    await refresh();
  });

  // 设置面板
  $('settingsBtn').addEventListener('click', () => {
    syncSettingsInputs(S.state);
    $('settingsOverlay').hidden = false;
    $('setNameInput').focus();
  });
  $('deviceChip').addEventListener('click', () => {
    $('settingsOverlay').hidden = false;
    $('setNameInput').focus();
    $('setNameInput').select();
  });
  $('settingsClose').addEventListener('click', async () => {
    await saveSettings();
    $('settingsOverlay').hidden = true;
  });
  $('settingsOverlay').addEventListener('click', async (e) => {
    if (e.target === $('settingsOverlay')) {
      await saveSettings();
      $('settingsOverlay').hidden = true;
    }
  });
  $('setDirPickBtn').addEventListener('click', async () => {
    const dir = await call(api.pickSaveDir());
    if (dir) $('setDirInput').value = dir;
    await refresh();
  });
  $('panelCopyBtn').addEventListener('click', () => {
    const url = S.state && S.state.panel ? S.state.panel.url : '';
    if (!url) return;
    api.copy(url);
    toast(t('已复制面板地址'), 'success');
  });
  $('panelOpenBtn').addEventListener('click', async () => {
    await call(api.openPanel());
  });
  for (const id of ['setAutoAccept', 'setAutoApprove', 'setAllowPublic', 'setRelayEnabled', 'setRelayProvider']) {
    $(id).addEventListener('change', async () => {
      // 选中 ngrok 就是要用互联网通道，顺带把总开关打开，免得界面上还看不见隧道配置
      if (id === 'setRelayProvider' && $('setRelayProvider').value === 'ngrok') $('setRelayEnabled').checked = true;
      await call(api.setSettings(settingsPatch()));
      await refresh();
    });
  }
  $('tunnelStartBtn').addEventListener('click', async () => {
    const btn = $('tunnelStartBtn');
    btn.disabled = true;
    await call(api.startTunnel(), true); // 失败提示由 notice 事件统一弹，这里不重复弹窗
    btn.disabled = false;
    await refresh();
  });
  $('tunnelStopBtn').addEventListener('click', async () => {
    await call(api.stopTunnel());
    await refresh();
  });
  $('tunnelCopyBtn').addEventListener('click', () => {
    const url = String((S.state && S.state.tunnel && S.state.tunnel.url) || '');
    if (!/^https:\/\//.test(url)) return;
    api.copy(url);
    toast(t('已复制隧道地址'), 'success');
  });
  // 地址一边打字一边保存会让房主侧槽位池反复重开，所以只在失焦或回车时提交
  const saveRelayUrl = async () => {
    await call(api.setSettings(settingsPatch()));
    await refresh();
  };
  $('setRelayUrl').addEventListener('change', saveRelayUrl);
  $('ngrokDomain').addEventListener('change', saveRelayUrl);
  $('ngrokDomain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRelayUrl();
  });
  $('setRelayUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRelayUrl();
  });
  $('relayTestBtn').addEventListener('click', async () => {
    const url = $('setRelayUrl').value.trim();
    if (!url) {
      toast(t('请先填写中继地址'), 'warn');
      return;
    }
    const btn = $('relayTestBtn');
    btn.disabled = true;
    // 测的就是界面上这份配置，先落盘再探测，避免「测的是旧地址、用的是新地址」
    await call(api.setSettings(settingsPatch()));
    const res = await call(api.checkRelay(url, $('setRelayProvider').value));
    if (res) toast(t('中继可用 · {host}', { host: res.host }), 'success');
    await refresh();
    renderRelay(S.state);
  });
  $('setNameInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await saveSettings();
      $('settingsOverlay').hidden = true;
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('settingsOverlay').hidden = true;
      $('langOverlay').hidden = true;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('sendBtn').disabled) $('sendBtn').click();
  });
}

function settingsPatch() {
  const provider = $('setRelayProvider').value;
  const patch = {
    deviceName: $('setNameInput').value.trim(),
    language: $('setLang').value || LANG,
    autoAccept: $('setAutoAccept').checked,
    autoApprove: $('setAutoApprove').checked,
    allowPublic: $('setAllowPublic').checked,
    relayEnabled: $('setRelayEnabled').checked,
    relayProvider: provider,
    relayUrl: $('setRelayUrl').value.trim(),
    ngrokDomain: $('ngrokDomain').value.trim(),
  };
  // ngrok 的中继地址由隧道自己写入引擎，输入框是空的，不能把空串存回去覆盖掉
  if (provider === 'ngrok') delete patch.relayUrl;
  return patch;
}

async function saveSettings() {
  const patch = settingsPatch();
  if (!patch.deviceName) $('setNameInput').value = (S.state && S.state.self.name) || t('我的设备');
  await call(api.setSettings(settingsPatch()));
  await refresh();
}

function syncSettingsInputs(st) {
  if (!st) return;
  if (document.activeElement !== $('setNameInput')) $('setNameInput').value = st.self.name;
  if (st.settings.language && st.settings.language !== LANG) {
    LANG = st.settings.language;
    applyStatic();
  }
  if (document.activeElement !== $('setLang')) $('setLang').value = LANG;
  $('setDirInput').value = st.settings.saveDir;
  $('setAutoAccept').checked = Boolean(st.settings.autoAccept);
  $('setAutoApprove').checked = Boolean(st.settings.autoApprove);
  $('setAllowPublic').checked = Boolean(st.settings.allowPublic);
  if (st.panel && document.activeElement !== $('panelUrlInput')) $('panelUrlInput').value = st.panel.url;
  $('setRelayEnabled').checked = Boolean(st.settings.relayEnabled);
  if (document.activeElement !== $('setRelayUrl')) $('setRelayUrl').value = st.settings.relayUrl || '';
  if (document.activeElement !== $('setRelayProvider')) $('setRelayProvider').value = activeProvider(st);
  if (document.activeElement !== $('ngrokDomain')) $('ngrokDomain').value = (st.tunnel || {}).domain || '';
}

// ---------------------------------------------------------------- 启动

api.onEvent((e) => {
  switch (e.type) {
    case 'state':
      S.state = e.state;
      syncSettingsInputs(e.state);
      break;
    case 'notice':
      toast(t(e.msg, e.params), e.level);
      break;
    case 'join-error':
      toast(t(e.msg, e.params), 'error');
      break;
    case 'offer-in':
      toast(t('{name} 想发送 {n} 个文件', { name: e.offer.peerName, n: e.offer.files.length }));
      break;
    case 'offer-done':
      toast(
        e.ok ? t(e.offer.dir === 'in' ? '已接收 {n} 个文件' : '已发送 {n} 个文件', { n: e.offer.files.length }) : t('传输失败：{reason}', { reason: t(e.reason || '未知原因') }),
        e.ok ? 'success' : 'error'
      );
      break;
    default:
      break;
  }
  scheduleRender();
});

applyStatic();
bindStatic();
refresh();
setInterval(() => {
  if (S.state && (S.state.offers || []).some((o) => o.state === 'transfer')) scheduleRender();
}, 1000);
