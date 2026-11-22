'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { once } = require('events');
const WebSocket = require('ws');

const { Hub } = require('../src/main/engine/hub');
const { lanInterfaces, unicastProbeTargets, pickLanAddress, resolveHostIp } = require('../src/main/engine/net');
const { PROTO_VERSION, CHUNK_SIZE, encodeChunk, decodeChunk, sanitizeName, sanitizeRel } = require('../src/main/engine/protocol');
const { generateRoomCode, normalizeRoomCode, formatRoomCode, sanitizeRoomInput } = require('../src/main/engine/roomCode');

const SAMPLE_KEYS = [
  '创建房间', '加入房间', '开始传送', '传输中', '最近记录', '设置', '语言', '设备名',
  '房间码不正确', '已离开房间', '未检测到局域网连接', '把文件或文件夹拖到这里',
  '房间只在这台应用运行期间存在，关闭后需要重新创建。',
  '没能读取到文件路径，请改用「浏览选择」',
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skydrop-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function tmpDir(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nextEvent(hub, type, pred, ms = 25_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hub.off('event', on);
      reject(new Error(`等待事件 ${type} 超时`));
    }, ms);
    const on = (e) => {
      if (e.type === type && (!pred || pred(e))) {
        clearTimeout(timer);
        hub.off('event', on);
        resolve(e);
      }
    };
    hub.on('event', on);
  });
}

/** 读取下一条原始帧（文本或二进制都原样返回 Buffer） */
function nextRaw(ws, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', on);
      reject(new Error('等待数据帧超时'));
    }, ms);
    const on = (data) => {
      clearTimeout(timer);
      ws.off('message', on);
      resolve(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
    };
    ws.on('message', on);
  });
}

/** 读取下一条 JSON 控制帧（ws 的 message 事件可能分片，需先拼接） */
function nextFrame(ws, pred = () => true, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', on);
      reject(new Error('等待控制帧超时'));
    }, ms);
    const on = (data, isBinary) => {
      if (isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      let obj;
      try {
        obj = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (!pred(obj)) return;
      clearTimeout(timer);
      ws.off('message', on);
      resolve(obj);
    };
    ws.on('message', on);
  });
}

async function makeFixtureTree(root) {
  const files = [];
  await fsp.writeFile(path.join(root, '空文件.txt'), '');
  files.push(path.join(root, '空文件.txt'));
  const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
  await fsp.writeFile(path.join(root, '大文件 中文.bin'), big);
  files.push(path.join(root, '大文件 中文.bin'));
  await fsp.mkdir(path.join(root, '素材包', '子目录'), { recursive: true });
  await fsp.writeFile(path.join(root, '素材包', 'readme.md'), '# 你好 SkyDrop\n');
  await fsp.writeFile(path.join(root, '素材包', '子目录', 'nested.json'), JSON.stringify({ ok: true }));
  files.push(path.join(root, '素材包'));
  return {
    files,
    expect: {
      '空文件.txt': Buffer.alloc(0),
      '大文件 中文.bin': big,
      '素材包/readme.md': Buffer.from('# 你好 SkyDrop\n'),
      '素材包/子目录/nested.json': Buffer.from('{"ok":true}'),
    },
  };
}

async function assertTree(dir, expected) {
  for (const [rel, content] of Object.entries(expected)) {
    const p = path.join(dir, rel);
    const actual = await fsp.readFile(p).catch(() => null);
    assert.ok(actual, `缺少文件 ${rel}`);
    assert.equal(actual.length, content.length, `${rel} 大小不一致`);
    if (content.length) assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), crypto.createHash('sha256').update(content).digest('hex'), `${rel} 内容不一致`);
  }
  // 不允许残留临时文件
  const leftovers = await fsp.readdir(dir);
  assert.ok(!leftovers.some((n) => n.includes('.part')), `残留临时文件：${leftovers.join(', ')}`);
}

function makePair({ hostName = '主机房', autoApprove = true } = {}) {
  const host = new Hub({ deviceName: hostName, saveDir: tmpDir(`host-${Math.random().toString(36).slice(2, 7)}`), autoApprove });
  const guest = new Hub({ deviceName: '访客机', saveDir: tmpDir(`guest-${Math.random().toString(36).slice(2, 7)}`) });
  return { host, guest };
}

test('房间码：生成、规范化与展示格式', () => {
  for (let i = 0; i < 500; i += 1) {
    const code = generateRoomCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    assert.equal(normalizeRoomCode(code), code);
  }
  assert.equal(normalizeRoomCode('abcd-23'), 'ABCD23');
  assert.equal(normalizeRoomCode('  abcd 23 '), 'ABCD23');
  assert.equal(normalizeRoomCode('AB23'), ''); // 长度不足
  assert.equal(normalizeRoomCode('ABIO01'), ''); // 含被剔除的易混字符
  assert.equal(sanitizeRoomInput('ab-cd1!'), 'ABCD'); // 1 不在字符集内，直接丢弃
  assert.equal(formatRoomCode('AB23CD'), 'AB2-3CD');
});

test('协议帧：编解码往返一致', () => {
  const data = crypto.randomBytes(1234);
  const frame = encodeChunk(42, 987654321, data);
  const back = decodeChunk(frame);
  assert.equal(back.fileId, 42);
  assert.equal(back.offset, 987654321);
  assert.deepEqual(back.data, data);
  assert.throws(() => decodeChunk(Buffer.from([1, 2, 3])));
});

test('文件名消毒：拒绝路径越界与控制字符', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('..'), '未命名文件');
  assert.equal(sanitizeName('a\u0000b:c*.txt'), 'a_b_c_.txt');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeRel('../../evil.txt'), null); // 退化掉 .. 后只剩文件名
  assert.equal(sanitizeRel('pkg/子目录/a b.txt'), 'pkg/子目录/a b.txt');
  assert.equal(sanitizeRel('/etc/hosts'), 'etc/hosts'); // 绝对路径转为相对路径
});

test('端到端：建房 → 房间码自动发现 → 双向传文件（含目录）', async (t) => {
  const { host, guest } = makePair();
  t.after(() => {
    host.dispose();
    guest.dispose();
  });

  const room = await host.startRoom();
  assert.equal(room.status, 'listening');

  const guestJoined = nextEvent(guest, 'peer-event', (e) => e.action === 'ready', 20_000);
  await guest.joinRoom(room.code); // 走 UDP 发现
  await guestJoined;
  assert.equal(host.peers.size, 1);
  assert.equal(guest.peers.size, 1);

  // 访客 -> 主机
  const src = tmpDir('src-a');
  const fx = await makeFixtureTree(src);
  const offerIn = nextEvent(host, 'offer-in');
  await guest.send({ paths: fx.files });
  const ev = await offerIn;
  assert.equal(ev.offer.dir, 'in');
  assert.equal(ev.offer.files.length, 4);
  host.respondOffer(ev.offer.id, true);
  const doneIn = await nextEvent(host, 'offer-done', (e) => e.ok);
  assert.equal(doneIn.offer.dir, 'in');
  await assertTree(host.saveDir, fx.expect);

  // 主机 -> 访客（反向，验证对称性）
  const src2 = tmpDir('src-b');
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  await fsp.writeFile(path.join(src2, '回传.dat'), payload);
  const offerIn2 = nextEvent(guest, 'offer-in');
  await host.send({ paths: [path.join(src2, '回传.dat')] });
  const ev2 = await offerIn2;
  guest.respondOffer(ev2.offer.id, true);
  await nextEvent(guest, 'offer-done', (e) => e.ok);
  assert.equal(crypto.createHash('sha256').update(await fsp.readFile(path.join(guest.saveDir, '回传.dat'))).digest('hex'), crypto.createHash('sha256').update(payload).digest('hex'));

  // 同名再传一次应自动加后缀而不是覆盖
  await host.send({ paths: [path.join(src2, '回传.dat')] });
  const ev3 = await nextEvent(guest, 'offer-in');
  guest.respondOffer(ev3.offer.id, true);
  await nextEvent(guest, 'offer-done', (e) => e.ok);
  assert.ok(fs.existsSync(path.join(guest.saveDir, '回传 (1).dat')), '重名文件未生成副本');
});

test('单播探测：广播被拦时逐地址扫所在 /24，有界且跳过虚拟网卡', () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.23', netmask: '255.255.255.0' }],
    utun3: [{ family: 'IPv4', internal: false, address: '10.8.0.2', netmask: '255.255.255.255' }],
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
  });
  try {
    const list = unicastProbeTargets();
    assert.ok(list.includes('192.168.1.1') && list.includes('192.168.1.254'), '应覆盖所在 /24 的全部主机位');
    assert.ok(!list.includes('192.168.1.0') && !list.includes('192.168.1.255'), '网络号与广播地址不参与');
    assert.equal(list.length, 254); // utun 与回环不参与
    assert.ok(!list.includes('10.8.0.2'), 'VPN 虚拟网卡不扫描');
  } finally {
    os.networkInterfaces = real;
  }
});

test('发现兜底：广播目标不可达时单播仍能找到房间', async (t) => {
  // 用独立 UDP 端口：这台机器上真实运行的隔空传实例也绑 47812，
  // macOS 同端口多 socket 时单播只投给其中一个，测试会被真实实例抢走
  const host = new Hub({ deviceName: '主机房', saveDir: tmpDir('host-uni'), autoApprove: true, udpPort: 47815 });
  const guest = new Hub({ deviceName: '访客机', saveDir: tmpDir('guest-uni'), udpPort: 47815 });
  t.after(() => {
    host.dispose();
    guest.dispose();
  });
  const room = await host.startRoom();
  // 坏广播地址（TEST-NET-3，不会被任何网卡接受）+ 本机真实局域网地址：
  // 单播路径必须能找到房间，且坏地址触发的异步发送错误不能中断整场发现
  const lan = lanInterfaces().find((i) => i.metric <= 2);
  const targets = ['203.0.113.255', lan ? lan.address : '127.0.0.1'];
  const list = await guest._discover({ room: room.code, timeout: 1500, targets });
  assert.ok(list.length >= 1, '单播探测没有找到房间');
  assert.equal(list[0].room, room.code);
});

test('加入失败：自动重扫并把附近开着的房间报进错误与列表', async (t) => {
  const host = new Hub({ deviceName: '真房主', saveDir: tmpDir('host-near'), autoApprove: true, udpPort: 47816 });
  const guest = new Hub({ deviceName: '迷路访客', saveDir: tmpDir('guest-near'), udpPort: 47816 });
  t.after(() => {
    host.dispose();
    guest.dispose();
  });
  const room = await host.startRoom();
  const errEvent = nextEvent(guest, 'join-error', null, 15_000);
  await assert.rejects(() => guest.joinRoom('ZZZZZZ'), /没有找到房间/);
  const ev = await errEvent;
  assert.match(ev.msg, /附近现在开着/, '错误里应列出当前实际开着的房间');
  assert.ok(ev.params && ev.params.code === formatRoomCode('ZZZZZZ'), '参数带格式化的请求房间码');
  assert.ok(ev.params.rooms.includes(room.code) && ev.params.rooms.includes('真房主'), '参数里包含房间码与设备名');
  assert.ok(guest.visible.some((r) => r.room === room.code && r.at), '重扫结果已刷新进附近列表并带时间戳');
});

test('附近列表：条目 90 秒过期，不再误导「扫描到了就能加入」', async (t) => {
  const hub = new Hub({ deviceName: '过期机', saveDir: tmpDir('host-exp') });
  t.after(() => hub.dispose());
  hub.visible = [
    { deviceId: 'a', name: '旧房间', room: 'ABC234', ip: '192.0.2.1', port: 47810, at: Date.now() - 120_000 },
    { deviceId: 'b', name: '新房间', room: 'DEF345', ip: '192.0.2.2', port: 47810, at: Date.now() },
  ];
  assert.deepEqual(hub.state().visible.map((r) => r.room), ['DEF345']);
});

test('应答地址：房主选自己同网段的地址应答，不把提问方的 IP 回显回去', () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.23', netmask: '255.255.255.0' }],
  });
  try {
    assert.equal(pickLanAddress('192.168.1.77'), '192.168.1.23', '与提问方同网段优先');
    assert.equal(pickLanAddress('127.0.0.5'), '127.0.0.1', '回环来源（同机实例）回回环地址');
    assert.equal(pickLanAddress('10.9.9.9'), '192.168.1.23', '不同网段退回第一块真实网卡');
  } finally {
    os.networkInterfaces = real;
  }
});

test('房主 IP 解析：加入方采信 UDP 回包来源，不采信旧版房主回显的提问方 IP', () => {
  assert.equal(resolveHostIp('192.168.0.183', '192.168.0.5'), '192.168.0.5', '回包来源地址永远优先');
  assert.equal(resolveHostIp('', '192.168.0.5'), '192.168.0.5', '没有自报地址时用回包来源');
  assert.equal(resolveHostIp('192.168.0.9', '0.0.0.0'), '192.168.0.9', '来源异常时退回房主自报地址');
});

test('加入被拒：报出连到的设备并提示重扫，而不是一句干巴巴的「房间码不正确」', async (t) => {
  const host = new Hub({ deviceName: '真房主', saveDir: tmpDir('host-reject'), autoApprove: true, udpPort: 47818 });
  const guest = new Hub({ deviceName: '访客机', saveDir: tmpDir('guest-reject'), udpPort: 47818 });
  t.after(() => {
    host.dispose();
    guest.dispose();
  });
  await host.startRoom();
  // 模拟「发现时房间还在、连接前被重建」：发现结果指向真房主的端口，但房间码对不上
  guest._discover = async () => [{ deviceId: 'stale', name: '真房主', room: 'ZZZZZZ', ip: '127.0.0.1', port: host.room.port }];
  const errEvent = nextEvent(guest, 'join-error', null, 15_000);
  await assert.rejects(() => guest.joinRoom('ZZZZZZ'), /房间码被 真房主 拒绝/);
  const ev = await errEvent;
  assert.match(ev.msg, /重新扫描/, '被拒错误也应引导用户重新扫描');
});

test('传送文本：即时文本、生成 TXT、越界拒绝', async (t) => {
  const { host, guest } = makePair();
  t.after(() => {
    host.dispose();
    guest.dispose();
  });
  const room = await host.startRoom();
  await guest.joinDirect(`127.0.0.1:${room.port}`, room.code);

  // 仅文本：无需对方确认，直接出现在对方的文本栏
  const textIn = nextEvent(host, 'text-in');
  const sent = await guest.sendText({ text: '你好，隔空传' });
  assert.equal(sent.count, 1);
  assert.equal(sent.size, Buffer.byteLength('你好，隔空传'));
  const ev = await textIn;
  assert.equal(ev.text.text, '你好，隔空传');
  assert.equal(host.texts[0].dir, 'in');
  assert.equal(host.texts[0].peerName, '访客机');
  assert.equal(guest.texts[0].dir, 'out');
  assert.ok(host.state().texts.length >= 1);

  // 反向：主机 → 访客
  const textIn2 = nextEvent(guest, 'text-in');
  await host.sendText({ text: '第二行文本' });
  assert.equal((await textIn2).text.text, '第二行文本');

  // 空白与超长：既不发送也不写记录
  await assert.rejects(() => guest.sendText({ text: '   ' }), /文本内容为空/);
  await assert.rejects(() => guest.sendText({ text: 'a'.repeat(32 * 1024 + 1) }), /文本过长/);
  assert.equal(guest.texts.length, 2);
  assert.equal(host.texts.length, 2);

  // 生成 TXT：走普通文件管线，接收端像收文件一样确认、落盘
  const offerIn = nextEvent(host, 'offer-in');
  const txtResult = await guest.sendText({ text: '落盘的文本内容\n第二行', asFile: true });
  assert.equal(txtResult.count, 1);
  const ev2 = await offerIn;
  assert.equal(ev2.offer.files.length, 1);
  assert.match(ev2.offer.files[0].name, /^文本 \d{4}-\d{2}-\d{2} /);
  assert.match(ev2.offer.files[0].name, /\.txt$/);
  host.respondOffer(ev2.offer.id, true);
  await nextEvent(host, 'offer-done', (e) => e.ok);
  const savedName = ev2.offer.files[0].name;
  assert.equal(await fsp.readFile(path.join(host.saveDir, savedName), 'utf8'), '落盘的文本内容\n第二行');

  // 发送端的临时 .txt 要在任务收尾后删掉
  await new Promise((r) => setTimeout(r, 150));
  const tmpTextDir = path.join(os.tmpdir(), 'skydrop-text');
  const leftovers = (await fsp.readdir(tmpTextDir).catch(() => [])).filter((n) => n === savedName);
  assert.deepEqual(leftovers, [], '临时 txt 文件没有清理');

  // 记录上限：塞满后最早的要被挤出去
  for (let i = 0; i < 65; i += 1) host._pushText({ dir: 'out', peerName: '访客机', text: `第 ${i} 条`, size: 5 });
  assert.equal(host.texts.length, 60);
  assert.equal(host.texts[0].text, '第 64 条');
});

test('房间权限：错误房间码被拒绝，手动批准流程可用', async (t) => {
  const { host, guest } = makePair({ autoApprove: false });
  t.after(() => {
    host.dispose();
    guest.dispose();
  });
  const room = await host.startRoom();

  // 错误房间码
  await assert.rejects(() => guest.joinDirect(`127.0.0.1:${room.port}`, 'ZZZZZZ'), /房间码不正确/);

  // 正确房间码 + 房主手动批准
  const reqPromise = nextEvent(host, 'join-request');
  const joinPromise = guest.joinDirect(`127.0.0.1:${room.port}`, room.code);
  const req = await reqPromise;
  assert.equal(req.name, '访客机');
  assert.ok(host.state().joinRequests.length === 1);
  host.approveJoin(req.deviceId, true);
  const joined = await joinPromise;
  assert.equal(joined.name, '主机房');
  // 这个返回值要经 IPC 结构化克隆，出现函数/socket 会让渲染层收到「could not be cloned」
  assert.equal(JSON.stringify(joined), JSON.stringify(JSON.parse(JSON.stringify(joined))));
  assert.equal(host.state().peers.length, 1);
});

test('完整性：校验和不匹配时丢弃文件并回报失败', async (t) => {
  const host = new Hub({ deviceName: '校验主机', saveDir: tmpDir('host-hash'), autoApprove: true });
  t.after(() => host.dispose());
  const room = await host.startRoom();

  const ws = new WebSocket(`ws://127.0.0.1:${room.port}/`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', proto: PROTO_VERSION, deviceId: 'raw-1', name: '伪造端', room: room.code }));
  const approve = await nextFrame(ws, (f) => f.type === 'approve');
  assert.equal(approve.ok, true);

  const payload = Buffer.from('需要被拒绝的内容');
  const donePromise = nextEvent(host, 'offer-done', (e) => e.offer.dir === 'in');
  ws.send(
    JSON.stringify({
      type: 'offer',
      transferId: 'raw-t1',
      from: { deviceId: 'raw-1', name: '伪造端' },
      files: [{ id: 1, name: '损坏文件.txt', rel: null, size: payload.length, mtime: 0 }],
      totalSize: payload.length,
    })
  );
  const offerEv = await nextEvent(host, 'offer-in');
  host.respondOffer(offerEv.offer.id, true);
  ws.send(JSON.stringify({ type: 'file-start', transferId: 'raw-t1', id: 1, name: '损坏文件.txt', rel: null, size: payload.length }));
  ws.send(encodeChunk(1, 0, payload), { binary: true });
  ws.send(JSON.stringify({ type: 'file-done', transferId: 'raw-t1', id: 1, size: payload.length, sha256: '0'.repeat(64) }));

  const receipt = await nextFrame(ws, (f) => f.type === 'receipt');
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /校验和/);
  const done = await donePromise;
  assert.equal(done.ok, false);
  assert.equal(fs.readdirSync(host.saveDir).filter((n) => n.includes('损坏文件')).length, 0, '损坏文件不应落盘');
  ws.close();
});

test('数据连续性：偏移量错位的帧会被拒绝', async (t) => {
  const host = new Hub({ deviceName: '序号主机', saveDir: tmpDir('host-seq'), autoApprove: true });
  t.after(() => host.dispose());
  const room = await host.startRoom();
  const ws = new WebSocket(`ws://127.0.0.1:${room.port}/`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', proto: PROTO_VERSION, deviceId: 'raw-2', name: '乱序端', room: room.code }));
  await nextFrame(ws, (f) => f.type === 'approve');
  ws.send(
    JSON.stringify({
      type: 'offer',
      transferId: 'raw-t2',
      from: { deviceId: 'raw-2' },
      files: [{ id: 1, name: 'x.bin', size: 10 }],
      totalSize: 10,
    })
  );
  const offerEv = await nextEvent(host, 'offer-in');
  host.respondOffer(offerEv.offer.id, true);
  ws.send(JSON.stringify({ type: 'file-start', transferId: 'raw-t2', id: 1, name: 'x.bin', size: 10 }));
  ws.send(encodeChunk(1, 5, Buffer.alloc(5)), { binary: true }); // 跳过前 5 字节
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.match(err.msg, /不连续/);
  ws.close();
});

test('越界防护：对端伪造 rel 不能写到保存目录之外', async (t) => {
  const jail = tmpDir('host-jail');
  const outside = tmpDir('outside');
  const host = new Hub({ deviceName: '越界主机', saveDir: jail, autoApprove: true });
  t.after(() => host.dispose());
  const room = await host.startRoom();

  const ws = new WebSocket(`ws://127.0.0.1:${room.port}/`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', proto: PROTO_VERSION, deviceId: 'raw-3', name: '越界端', room: room.code }));
  await nextFrame(ws, (f) => f.type === 'approve');
  const evil = Buffer.from('pwned');
  ws.send(
    JSON.stringify({
      type: 'offer',
      transferId: 'raw-t3',
      files: [{ id: 1, name: 'evil.txt', rel: '../../../../../../etc/evil.txt', size: evil.length }],
      totalSize: evil.length,
    })
  );
  const offerEv = await nextEvent(host, 'offer-in');
  host.respondOffer(offerEv.offer.id, true);
  ws.send(JSON.stringify({ type: 'file-start', transferId: 'raw-t3', id: 1, name: 'evil.txt', rel: '../../../../../../etc/evil.txt', size: evil.length }));
  ws.send(encodeChunk(1, 0, evil), { binary: true });
  ws.send(
    JSON.stringify({
      type: 'file-done',
      transferId: 'raw-t3',
      id: 1,
      size: evil.length,
      sha256: crypto.createHash('sha256').update(evil).digest('hex'),
    })
  );
  const receipt = await nextFrame(ws, (f) => f.type === 'receipt');
  assert.equal(receipt.ok, true);
  assert.ok(receipt.path.startsWith(jail), `落盘路径必须留在保存目录内，实际 ${receipt.path}`);
  assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);
  ws.close();
});

test('未批准的连接不能发起传输', async (t) => {
  const host = new Hub({ deviceName: '严格主机', saveDir: tmpDir('host-strict'), autoApprove: false });
  t.after(() => host.dispose());
  const room = await host.startRoom();
  const ws = new WebSocket(`ws://127.0.0.1:${room.port}/`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', proto: PROTO_VERSION, deviceId: 'raw-4', name: '未批准端', room: room.code }));
  const req = await nextEvent(host, 'join-request');
  assert.equal(req.deviceId, 'raw-4');
  // 房主还没点允许，直接发 offer
  ws.send(JSON.stringify({ type: 'offer', transferId: 'raw-t4', files: [{ id: 1, name: 'a.txt', size: 1 }], totalSize: 1 }));
  const errFrame = await nextFrame(ws, (f) => f.type === 'error');
  assert.match(errFrame.msg, /未经批准/);
  ws.close();
});

// ---------------------------------------------------------------- 多语言

test('多语言：每种语言的词典键集合一致，且不会漏项', () => {
  const I18N = require('../src/common/i18n');
  assert.equal(I18N.LANGS.length >= 4, true);
  const codes = I18N.LANGS.map((l) => l.code);
  assert.deepEqual(codes, ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']);
  // zh-CN 以原文为 key，没有独立词典；其它语言必须与 en 键集完全一致
  for (const code of codes) {
    if (code === 'zh-CN') continue;
    for (const key of SAMPLE_KEYS) {
      const out = I18N.t(key, null, code);
      assert.notEqual(out, '', `${code} 把 ${key} 翻成了空字符串`);
      if (code !== 'zh-TW') assert.notEqual(out, key, `${code} 缺少 ${key} 的译文`);
    }
  }
});

test('多语言：占位符替换、未知原文回显中文、非法语言不崩', () => {
  const I18N = require('../src/common/i18n');
  assert.equal(I18N.t('已连接：{name}', { name: 'Mac' }, 'en'), 'Connected: Mac');
  assert.equal(I18N.t('正在向 {n} 台设备申请传送 {m} 个文件（{size}）', { n: 2, m: 7, size: '3 MB' }, 'en'), 'Requesting to send 7 file(s) (3 MB) to 2 device(s)');
  assert.equal(I18N.t('这句没有收录', { x: 1 }, 'en'), '这句没有收录', '未命中必须回显原文');
  assert.equal(I18N.t('已连接：{name}', { name: 'Mac' }, 'zh-CN'), '已连接：Mac');
  assert.equal(I18N.t('已连接：{name}', { name: 'Mac' }, '不存在的语言'), '已连接：Mac');
  assert.equal(I18N.t(undefined, null, 'en'), '', '空原文不应抛异常');
});

test('多语言：locale 探测覆盖中英日韩与其它语言', () => {
  const I18N = require('../src/common/i18n');
  const cases = [
    ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-Hans-SG', 'zh-CN'],
    ['en-US', 'en'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['fr-FR', 'en'], ['', 'en'], [null, 'en'],
  ];
  for (const [locale, want] of cases) assert.equal(I18N.detect(locale), want, `detect(${String(locale)})`);
  assert.equal(I18N.isSupported('ja'), true);
  assert.equal(I18N.isSupported('fr'), false);
});

test('多语言：模块加载不污染全局作用域（经典脚本里会和 app.js 冲突）', () => {
  const before = Object.keys(globalThis);
  require('../src/common/i18n');
  for (const name of ['t', 'api', 'LANGS', 'interpolate', 'DICT', 'EN', 'JA']) {
    assert.equal(before.includes(name), false, `全局多了 ${name}`);
  }
});

test('多语言：Hub 接受合法语言、忽略非法语言，并在状态里回报', () => {
  const { Hub } = require('../src/main/engine/hub');
  const hub = new Hub({ deviceId: 'lang-1', saveDir: tmpDir('lang'), language: 'en' });
  assert.equal(hub.state().settings.language, 'en');
  hub.setSettings({ language: 'ja' });
  assert.equal(hub.state().settings.language, 'ja');
  hub.setSettings({ language: 'klingon' });
  assert.equal(hub.state().settings.language, 'ja', '非法语言不应改变当前语言');
  const events = [];
  hub.on('event', (e) => events.push(e));
  hub.notice('已连接：{name}', { name: 'Mac' });
  assert.deepEqual(events[0].params, { name: 'Mac' }, 'notice 需要把参数一起发给渲染层');
  hub.dispose();
});

/** 从源码里收集所有「会出现在界面上的中文原文」 */
function collectUiStrings() {
  const found = new Map(); // 原文 -> 出处
  const isCjk = (s) => /[\u4e00-\u9fff]/.test(s);
  // 品牌名 / 保存目录名按语言硬编码在 defaultSaveDir()，本来就不走词典
  const NOT_UI = new Set(['隔空传']);
  const scan = (rel, text, patterns) => {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const raw = m[m.length - 1];
        if (!isCjk(raw) || raw.includes('${') || NOT_UI.has(raw)) continue;
        if (!found.has(raw)) found.set(raw, rel);
      }
    }
  };
  const quoted = [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g];
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  scan('src/renderer/index.html', read('src/renderer/index.html'), [/data-i18n(?:-title|-aria)?="([^"]+)"/g]);
  for (const rel of ['src/renderer/app.js', 'src/main/index.js']) scan(rel, read(rel), quoted);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src/main/engine'))) scan(`src/main/engine/${f}`, read(`src/main/engine/${f}`), quoted);
  return found;
}

test('多语言：界面上可能出现的原文都有译文（扫源码，不靠人工清单）', () => {
  const I18N = require('../src/common/i18n');
  const strings = collectUiStrings();
  assert.equal(strings.size > 100, true, '扫描结果为空说明正则失效了');
  const missing = [];
  for (const [text, from] of strings) {
    for (const code of ['zh-TW', 'en', 'ja', 'ko']) {
      const out = I18N.t(text, null, code);
      if (!String(out).trim()) missing.push(`${code} 译成了空串：${text}（${from}）`);
      // zh-TW 允许与原文完全相同（繁简同形的词很多），其余语言必须命中词典
      else if (code !== 'zh-TW' && out === text) missing.push(`${code} 缺译文：${text}（${from}）`);
    }
  }
  assert.deepEqual(missing, [], `${missing.length} 条文案没有译文：\n${missing.join('\n')}`);
});

// ---------------------------------------------------------------- 跨网中继

const { parseRelayBase, relaySocketUrl } = require('../src/main/engine/relay');

async function settled(fn, ms = 15_000, what = '条件未满足') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('跨网中继：各种用户输入都能归一化成可拨号地址', () => {
  assert.deepEqual(parseRelayBase('skydrop.abc.workers.dev', 'cloudflare'), { secure: true, host: 'skydrop.abc.workers.dev', prefix: '' });
  assert.deepEqual(parseRelayBase('https://skydrop-relay.vercel.app/', 'vercel'), { secure: true, host: 'skydrop-relay.vercel.app', prefix: '/api' });
  assert.deepEqual(parseRelayBase('wss://10.0.0.5:8790', 'custom'), { secure: true, host: '10.0.0.5:8790', prefix: '' });
  assert.deepEqual(parseRelayBase('ws://127.0.0.1:8790/relay/', 'custom'), { secure: false, host: '127.0.0.1:8790', prefix: '/relay' });
  assert.deepEqual(parseRelayBase('localhost:8790', 'custom'), { secure: false, host: 'localhost:8790', prefix: '' });
  // 直接粘贴完整拨号串也要能用
  assert.equal(relaySocketUrl('https://x.dev/room/ABC123', 'ABC123', 'guest', 'cloudflare'), 'wss://x.dev/room/ABC123?role=guest&room=ABC123');
  assert.equal(relaySocketUrl('https://x.vercel.app', 'ABC123', 'host', 'vercel'), 'wss://x.vercel.app/api/room/ABC123?role=host&room=ABC123');
  // 服务商选错但地址填对：*.vercel.app 一律走 /api，不必让用户再回去改下拉框
  assert.equal(relaySocketUrl('https://x.vercel.app', 'ABC123', 'host', 'cloudflare'), 'wss://x.vercel.app/api/room/ABC123?role=host&room=ABC123');
  assert.equal(relaySocketUrl('x.vercel.app/api', 'ABC123', 'guest', 'custom'), 'wss://x.vercel.app/api/room/ABC123?role=guest&room=ABC123');
  assert.throws(() => parseRelayBase('', 'cloudflare'), /请填写中继地址/);
  assert.throws(() => parseRelayBase('ftp://x', 'cloudflare'), /只支持/);
  assert.throws(() => parseRelayBase('not a url', 'cloudflare'), /格式不正确/);
});

test('跨网中继：配对状态机排队、配对、双向透传、断开联动', async () => {
  const { Relay, parseRelayPath } = await import('../relay/pairing.js');
  const relay = new Relay({ maxRooms: 4, maxWaitingPerRoom: 2 });
  const log = [];
  const sock = (name) => ({
    name,
    send(data, isBinary) {
      log.push({ to: name, data: String(data), isBinary: Boolean(isBinary) });
    },
    close(code) {
      log.push({ to: name, closed: code });
    },
  });

  assert.equal(relay.join({ room: 'ABCD12', role: 'guest', socket: sock('g0') }), 'no-host', '没人值守时访客要被拒');
  assert.equal(relay.join({ room: 'bad!', role: 'host', socket: sock('h9') }), 'bad-room');
  assert.equal(relay.join({ room: 'ABCD12', role: 'admin', socket: sock('h8') }), 'bad-role');

  const h1 = sock('h1');
  const h2 = sock('h2');
  assert.equal(relay.join({ room: 'abcd-12', role: 'host', socket: h1 }), 'waiting');
  assert.equal(relay.join({ room: 'ABCD12', role: 'host', socket: h2 }), 'waiting');
  assert.ok(log.some((l) => l.to === 'h1' && l.data.includes('"waiting"')), '房主槽要收到 hello-ack');

  const g1 = sock('g1');
  assert.equal(relay.join({ room: 'ABCD12', role: 'guest', socket: g1 }), 'paired');
  assert.deepEqual(relay.stats(), { rooms: 1, waiting: 1, pairs: 1 });

  assert.equal(relay.message(h1, '房主说的话', false), true);
  assert.equal(relay.message(g1, Buffer.from([1, 2, 3]), true), true);
  assert.ok(log.some((l) => l.to === 'g1' && l.data === '房主说的话' && l.isBinary === false), '文本要按文本转发');
  assert.ok(log.some((l) => l.to === 'h1' && l.isBinary === true), '二进制要按二进制转发');
  assert.equal(relay.message(sock('stray'), 'x', false), false, '未配对的连接不能借道转发');

  relay.leave(h1);
  assert.ok(log.some((l) => l.to === 'g1' && l.closed === 1000), '房主断开要连带关掉访客');
  assert.deepEqual(relay.stats(), { rooms: 1, waiting: 1, pairs: 0 }, '配对结束要释放房间');

  assert.deepEqual(parseRelayPath('/api/room/abcd12?role=guest'), { room: 'ABCD12', role: 'guest' });
  assert.deepEqual(parseRelayPath('/room/ABC123'), { room: 'ABC123', role: 'guest' });
  assert.deepEqual(parseRelayPath('/health'), { room: '', role: '' });
  // Vercel 的 rewrite 会把 /api/room/ABC123 改成 /api/room，只剩 query 能带房间码
  assert.deepEqual(parseRelayPath('/api/room?role=host&room=ABC123'), { room: 'ABCD12'.slice(0, 0) + 'ABC123', role: 'host' });
  assert.deepEqual(parseRelayPath('/api/room?role=guest'), { room: '', role: '' }, 'query 里也没有房间码要判无效');
  assert.deepEqual(parseRelayPath('/room/ZZ9?room=ABC123'), { room: 'ABC123', role: 'guest' }, '路径里的码非法时回落到 query');
});

test('跨网中继：配对失败的错误帧与休眠后的状态恢复', async () => {
  const { Relay, relayJoin, errorFrame } = await import('../relay/pairing.js');
  const sock = (name) => ({
    name,
    frames: [],
    send(data) {
      this.frames.push(String(data));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  });

  // relayJoin：失败必须先把错误码用帧发出去再关连接，界面才有可行动的提示
  const relay = new Relay();
  const lost = sock('g0');
  assert.equal(relayJoin(relay, { room: 'ABC123', role: 'guest', socket: lost }), 'no-host');
  assert.deepEqual(JSON.parse(lost.frames[0]), errorFrame('no-host'));
  assert.equal(lost.closed.code, 1008);
  const slot = sock('h1');
  assert.equal(relayJoin(relay, { room: 'ABC123', role: 'host', socket: slot }), null, '正常接入不返回错误');
  assert.equal(relay.peerOf(slot), null, '还在排队的槽没有对端');
  const guest = sock('g1');
  assert.equal(relayJoin(relay, { room: 'ABC123', role: 'guest', socket: guest }), null);
  assert.equal(relay.peerOf(slot), guest, 'peerOf 要能对出配对的另一端');
  assert.equal(relay.peerOf(guest), slot);

  // 模拟 Cloudflare 的休眠唤醒：连接还活着，内存里的登记表全没了
  const woke = new Relay({ maxRooms: 4 });
  const h2 = sock('h2');
  const g2 = sock('g2');
  assert.equal(woke.restorePair('ABC123', h2, g2), true);
  assert.deepEqual(woke.stats(), { rooms: 1, waiting: 0, pairs: 1 });
  assert.equal(woke.message(h2, '唤醒后转发', false), true);
  assert.ok(g2.frames.includes('唤醒后转发'), '恢复出来的配对要能继续透传');
  woke.leave(g2);
  assert.equal(h2.closed.code, 1000, '恢复出来的配对断开也要联动');
  assert.equal(woke.restorePair('bad!', h2, g2), false, '房间码非法不恢复');

  const woke2 = new Relay({ maxRooms: 4 });
  const h3 = sock('h3');
  assert.equal(woke2.restoreWaiting('ABC123', h3), true);
  assert.equal(woke2.restoreWaiting('ABC123', h3), false, '重复恢复要能被识别出来');
  assert.deepEqual(woke2.stats(), { rooms: 1, waiting: 1, pairs: 0 });
  assert.equal(woke2.join({ room: 'ABC123', role: 'guest', socket: sock('g3') }), 'paired', '恢复的等待槽还能接新访客');
  assert.equal(h3.frames.filter((f) => f.includes('"paired"')).length, 1, '恢复时不该重发 hello-ack');
});

test('跨网中继：Cloudflare Worker 版按房间分片、透传与休眠唤醒', async () => {
  // Worker 运行时特有的几个全局对象（DurableObject / WebSocketPair / Response）用最小替身实现，
  // 就能把 cloudflare/worker.js 的分片路由、配对、转发和「唤醒后凭附件重建状态」整条跑一遍。
  const saved = { Response: globalThis.Response, DurableObject: globalThis.DurableObject, WebSocketPair: globalThis.WebSocketPair };

  class FakeResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = init.headers || {};
      this.webSocket = init.webSocket;
    }
    async json() {
      return JSON.parse(this.body);
    }
  }
  const sockets = [];
  class FakeSocket {
    constructor(side) {
      this.side = side; // client 交回给调用方，server 由平台（也就是这段替身）持有
      this.frames = [];
      this.closed = null;
      this.attachment = null;
      this.accepted = false;
      this.onClose = null;
      sockets.push(this);
    }
    send(data) {
      if (this.closed) throw new Error('已关闭的连接不能再发帧');
      this.frames.push(data);
    }
    close(code, reason) {
      if (this.closed) return;
      this.closed = { code, reason };
      this.onClose?.(this); // 平台随后会把断开事件投给 DO
    }
    serializeAttachment(value) {
      this.attachment = JSON.parse(JSON.stringify(value));
    }
    deserializeAttachment() {
      return this.attachment ? JSON.parse(JSON.stringify(this.attachment)) : null;
    }
  }
  globalThis.Response = FakeResponse;
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new FakeSocket('client');
      this[1] = new FakeSocket('server');
    }
  };
  globalThis.DurableObject = class {
    constructor(state, env) {
      this.ctx = state;
      this.env = env;
    }
  };

  try {
    const { SkyDropRelayRoom, default: worker } = await import('../relay/cloudflare/worker.js');
    const shards = new Map(); // 一个房间码 = 一个 DO 实例，真实平台就是这么分片的
    function makeShard() {
      const live = new Set();
      const tail = [];
      let instance = null;
      const shard = {
        live,
        state: {
          acceptWebSocket(ws) {
            ws.accepted = true;
            live.add(ws);
            ws.onClose = () => {
              if (instance) tail.push(instance.webSocketClose(ws));
            };
          },
          // 关掉的连接平台不再投递，等价于从 getWebSockets() 里消失
          getWebSockets: () => [...live].filter((ws) => !ws.closed),
          waitUntil: (p) => tail.push(p),
        },
        // 休眠唤醒：换一个全新实例，连接和它们的附件都还在
        hibernate() {
          instance = null;
        },
        current() {
          if (!instance) instance = new SkyDropRelayRoom(shard.state, env);
          return instance;
        },
        async settle() {
          while (tail.length) await tail.shift();
        },
      };
      return shard;
    }
    const env = {
      SKYDROP_ROOM: {
        idFromName: (code) => `id-${code}`,
        get(id) {
          let shard = shards.get(id);
          if (!shard) {
            shard = makeShard();
            shards.set(id, shard);
          }
          return { fetch: (req) => shard.current().fetch(req) };
        },
      },
    };
    const req = (path, upgrade = 'websocket') => ({
      url: `https://relay.example.com${path}`,
      headers: { get: (k) => (String(k).toLowerCase() === 'upgrade' ? upgrade : null) },
    });
    const shardOf = (code) => shards.get(`id-${code}`);
    const call = (path, upgrade = 'websocket') => worker.fetch(req(path, upgrade), env);
    /** 拨一条连接，拿到两端连接对象 */
    async function conn(code, role) {
      const before = new Set(sockets);
      const res = await call(`/room/${code}?role=${role}&room=${code}`);
      await shardOf(code).settle();
      const server = sockets.find((s) => s.side === 'server' && !before.has(s));
      return { client: res.webSocket, server };
    }
    const frames = (s) => s.frames.map(String);
    const control = (s) =>
      frames(s)
        .filter((f) => f.startsWith('{'))
        .map((f) => JSON.parse(f));

    // ---- 路由层：健康检查、非法房间码、非升级请求
    assert.equal((await call('/health', null)).status, 200);
    assert.equal((await call('/room/bad!?role=host', null)).status, 400, '房间码非法要直接拒绝');
    assert.equal((await call('/', 'other')).status, 200, '浏览器直接访问给一句说明');
    assert.equal(shards.size, 0, '上面这些请求都不该建出房间实例');
    assert.equal((await call('/room/ABC123', 'other')).status, 426, '不是升级请求要提示走 WebSocket');

    // ---- 房主挂槽：先 waiting，访客来了再 paired
    const host = await conn('ABC123', 'host');
    assert.ok(host.server.accepted, '房主连接要交给平台接管');
    assert.deepEqual(control(host.server)[0], { t: 'hello-ack', proto: 1, room: 'ABC123', state: 'waiting' });
    assert.equal(host.server.attachment.role, 'host');
    assert.equal(host.server.attachment.peer, '', '还没配对时附件里不该有对端');

    const guest = await conn('ABC123', 'guest');
    await conn('XYZ789', 'guest'); // 另一间没人值守的房，验证分片互不干扰
    assert.equal(shards.size, 2, '不同房间码各自一个实例');
    assert.deepEqual(control(host.server).slice(1), [{ t: 'paired', proto: 1, room: 'ABC123', peer: 'guest' }]);
    assert.deepEqual(control(guest.server), [{ t: 'paired', proto: 1, room: 'ABC123', peer: 'host' }]);
    assert.equal(host.server.attachment.peer, guest.server.attachment.id, '房主附件要记下对端的连接 id');
    assert.equal(guest.server.attachment.peer, host.server.attachment.id, '访客附件也要记回房主，唤醒时两边都能找回彼此');

    // ---- 透传要保留文本/二进制类型
    const inst = shardOf('ABC123').current();
    await inst.webSocketMessage(host.server, '房主说的话');
    assert.deepEqual(frames(guest.server).slice(-1), ['房主说的话']);
    const blob = new Uint8Array([1, 2, 3]).buffer;
    await inst.webSocketMessage(guest.server, blob);
    assert.equal(host.server.frames.slice(-1)[0], blob, '二进制帧要原样递出去');

    // ---- 休眠唤醒：连接还在，内存登记表全空
    shardOf('ABC123').hibernate();
    const woke = shardOf('ABC123').current();
    assert.notEqual(woke, inst, '唤醒拿到的是全新实例');
    assert.equal(woke.byId.size, 0, '新实例内存里什么都没有');
    await woke.webSocketMessage(host.server, '唤醒后还能透传');
    assert.deepEqual(frames(guest.server).slice(-1), ['唤醒后还能透传'], '要凭附件重建配对关系');
    assert.equal(woke.byId.size, 2, '两条还活着的连接都登记回来了');
    assert.deepEqual(woke.relay.stats(), { rooms: 1, waiting: 0, pairs: 1 });

    // ---- 一端断开：另一端被连带关掉，双方立刻看到对方离线
    await woke.webSocketClose(guest.server);
    assert.deepEqual(host.server.closed, { code: 1000, reason: 'peer-left' });
    await shardOf('ABC123').settle();
    assert.equal(woke.byId.size, 0, '配对两端都要从登记表里摘掉');

    // 房主应用层随后补一个新槽，新访客照样能配对上
    const host2 = await conn('ABC123', 'host');
    assert.deepEqual(control(host2.server)[0].state, 'waiting');
    const guest2 = await conn('ABC123', 'guest');
    assert.ok(control(host2.server).some((f) => f.t === 'paired'));
    await shardOf('ABC123').current().webSocketMessage(host2.server, '换槽之后继续传');
    assert.deepEqual(frames(guest2.server).slice(-1), ['换槽之后继续传']);

    // ---- 没人值守的房间码：错误也要用帧回，界面才翻得出中文提示
    const lost = await conn('DEF456', 'guest');
    assert.deepEqual(control(lost.server), [{ t: 'error', code: 'no-host' }]);
    assert.equal(lost.server.closed.code, 1008);
    assert.deepEqual([...shardOf('DEF456').state.getWebSockets()], [], '失败的连接不留在房里');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value) globalThis[key] = value;
      else delete globalThis[key];
    }
  }
});

test('跨网中继：Vercel 入口在 rewrite 之后仍能配对与透传', async (t) => {
  // Vercel 的 vercel.json 把 /api/room/ABC123 改写成固定函数路径 /api/room，
  // 房间码只剩 query 能带过去；这里直接起 api/room.js 导出的那个 http.Server，
  // 用 rewrite 后的形态拨号，验证 Vercel 部署件真的能配对。
  const mod = await import('../relay/api/room.js');
  const server = mod.default;
  assert.equal(typeof server.on, 'function', 'Vercel 的入口要是一个 http.Server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => {
    server.close();
    server.closeAllConnections?.();
  });

  const dial = (role) => {
    // 路径里没有房间码，和 Vercel rewrite 之后函数看到的一模一样
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/room?role=${role}&room=ABC123`, { maxPayload: 4 * CHUNK_SIZE });
    return ws;
  };
  // 注意顺序：中继在握手完成的那一帧里就把 hello-ack / paired 发出来了，
  // 所以监听器必须紧跟 new WebSocket 同步挂上，不能先 await 'open' 再挂。
  const host = dial('host');
  const hostAck = nextFrame(host, (m) => m.t === 'hello-ack');
  await once(host, 'open');
  assert.deepEqual(await hostAck, { t: 'hello-ack', proto: 1, room: 'ABC123', state: 'waiting' });

  const guest = dial('guest');
  const hostPaired = nextFrame(host, (m) => m.t === 'paired');
  const guestPaired = nextFrame(guest, (m) => m.t === 'paired');
  await once(guest, 'open');
  const [hp, gp] = await Promise.all([hostPaired, guestPaired]);
  assert.equal(hp.peer, 'guest');
  assert.equal(gp.peer, 'host');

  // 应用层的整片大小（256 KB）必须能原样穿过中继
  const payload = crypto.randomBytes(CHUNK_SIZE);
  const guestGot = nextRaw(guest);
  host.send(payload);
  assert.equal(Buffer.compare(await guestGot, payload), 0, '二进制分片要字节一致');
  const hostGot = nextRaw(host);
  guest.send(Buffer.from('访客回的话'));
  assert.equal((await hostGot).toString(), '访客回的话');

  // 路径写法（Cloudflare / 自建那种）在同一个入口上也要认
  const byPath = new WebSocket(`ws://127.0.0.1:${port}/api/room/GHI789?role=host`);
  const byPathAck = nextFrame(byPath);
  await once(byPath, 'open');
  assert.equal((await byPathAck).state, 'waiting');

  const stranger = new WebSocket(`ws://127.0.0.1:${port}/api/room?role=guest`);
  const strangerErr = nextFrame(stranger, (m) => m.t === 'error');
  assert.deepEqual(await strangerErr, { t: 'error', code: 'bad-room' });

  const guestClosed = once(guest, 'close');
  host.close();
  await guestClosed;
  byPath.close();
  stranger.terminate();
});

test('跨网中继：两台设备只经中继完成双向传文件', async (t) => {
  const { createRelayServer } = await import('../relay/node-server.js');
  const relaySrv = await createRelayServer({ port: 0, host: '127.0.0.1' });
  t.after(() => relaySrv.close());
  const relayUrl = relaySrv.origin;

  const host = new Hub({
    deviceName: '中继主机',
    saveDir: tmpDir('relay-host'),
    autoApprove: true,
    relayEnabled: true,
    relayProvider: 'custom',
    relayUrl,
  });
  const guest = new Hub({
    deviceName: '中继访客',
    saveDir: tmpDir('relay-guest'),
    relayEnabled: true,
    relayProvider: 'custom',
    relayUrl,
  });
  t.after(() => {
    host.dispose();
    guest.dispose();
  });

  const room = await host.startRoom();
  await settled(() => host.state().relay.endpoints >= 3, 15_000, '房主槽位没挂上中继');
  assert.equal(host.state().relay.status, 'ready');
  assert.equal(host.state().relay.host, relayUrl.replace(/^ws:\/\//, ''));

  // 房间码不存在时给出可行动的错误提示
  await assert.rejects(() => guest.joinRelay('ZZZZZZ'), /中继上没有这个房间/);

  const joined = await guest.joinRelay(room.code);
  assert.equal(joined.via, 'relay');
  assert.equal(joined.name, '中继主机');
  assert.equal(host.state().peers.length, 1);
  assert.equal(host.state().peers[0].via, 'relay', '房主要能把中继来的设备区分出来');
  assert.equal(host.state().peers[0].ip, '');
  assert.equal(guest.state().joined.via, 'relay');
  // 槽位被占用后应立刻补齐，仍然保持 3 条在听
  await settled(() => host.state().relay.endpoints >= 3, 15_000, '槽位没补齐');

  const fx = await makeFixtureTree(tmpDir('relay-src'));
  const offerIn = nextEvent(host, 'offer-in');
  await guest.send({ paths: fx.files });
  const ev = await offerIn;
  host.respondOffer(ev.offer.id, true);
  await nextEvent(host, 'offer-done', (e) => e.ok);
  await assertTree(host.saveDir, fx.expect);

  const back = tmpDir('relay-back');
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  await fsp.writeFile(path.join(back, '中继回传.dat'), payload);
  const offerIn2 = nextEvent(guest, 'offer-in');
  await host.send({ paths: [path.join(back, '中继回传.dat')] });
  const ev2 = await offerIn2;
  guest.respondOffer(ev2.offer.id, true);
  await nextEvent(guest, 'offer-done', (e) => e.ok);
  assert.equal(
    crypto.createHash('sha256').update(await fsp.readFile(path.join(guest.saveDir, '中继回传.dat'))).digest('hex'),
    crypto.createHash('sha256').update(payload).digest('hex')
  );

  // 关掉开关要立刻摘掉中继上的槽位
  host.setSettings({ relayEnabled: false });
  assert.equal(host.state().relay.status, 'off');
  assert.equal(host.state().relay.endpoints, 0);
  // 槽位是从中继侧异步摘除的，等它把 3 条挂着的连接收干净
  await settled(() => relaySrv.stats().waiting === 0, 8_000, '中继侧残留等待槽');
  // 已经建立的设备连接不受影响，还能继续传
  const offerIn3 = nextEvent(guest, 'offer-in');
  await host.send({ paths: [path.join(back, '中继回传.dat')] });
  guest.respondOffer((await offerIn3).offer.id, true);
  await nextEvent(guest, 'offer-done', (e) => e.ok);
});

// ---------------------------------------------------------------- ngrok 隧道

const tunnel = require('../src/main/engine/tunnel');
const { probeRelay } = require('../src/main/engine/relay');
const { EventEmitter } = require('events');

const tunnelLog = (url, addr) => JSON.stringify({ lvl: 'info', msg: 'started tunnel', obj: 'tunnels', addr: `http://localhost:${addr}`, url });

/** 假的 ngrok 子进程：按参数决定吐什么日志、什么时候退出 */
function fakeNgrok({ stdout = '', stderr = '', exitCode = null } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (sig) => {
    child.killed = sig || 'TERM';
    return true;
  };
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    if (exitCode !== null) child.emit('close', exitCode);
  });
  return child;
}

test('ngrok 检测：装了给出绝对路径与版本，没装回报 installed=false', async () => {
  const hit = await tunnel.findNgrok({
    platform: 'darwin',
    dirs: ['/empty', '/opt/homebrew/bin'],
    exists: (p) => p === '/opt/homebrew/bin/ngrok' || p === '/empty/ngrok',
    stat: (p) => ({ isFile: () => p !== '/empty/ngrok' }), // 同名目录不是文件，要跳过继续找
    runVersion: async () => 'ngrok version 3.37.2\n',
  });
  assert.deepEqual(hit, { installed: true, path: '/opt/homebrew/bin/ngrok', version: '3.37.2' });

  assert.deepEqual(await tunnel.findNgrok({ platform: 'darwin', dirs: ['/nope'], exists: () => false }), {
    installed: false,
    path: '',
    version: '',
  });

  // 二进制在但跑不出版本号：仍然算装了，界面该给入口，具体原因留给启动时报
  const odd = await tunnel.findNgrok({
    platform: 'win32',
    dirs: ['C:\\ngrok'],
    exists: () => true,
    stat: () => ({ isFile: () => true }),
    runVersion: async () => '',
  });
  assert.equal(odd.installed, true);
  assert.equal(odd.path, 'C:\\ngrok\\ngrok.exe');
  assert.equal(odd.version, '');
});

test('ngrok 检测：PATH 之外的常见安装目录按平台覆盖，用户自己的 PATH 优先', () => {
  assert.deepEqual(tunnel.standardDirs('darwin', {}, '/Users/x').slice(0, 3), ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']);
  const win = tunnel.standardDirs('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'C:\\Users\\x');
  assert.ok(win.includes('C:\\Users\\x\\AppData\\Local\\ngrok'), 'winget/手工安装的位置');
  assert.ok(win.includes('C:\\Program Files\\ngrok'));
  assert.ok(win.includes('C:\\ProgramData\\chocolatey\\bin'));
  assert.ok(tunnel.standardDirs('linux', {}, '/home/x').includes('/snap/bin'));
  const dirs = tunnel.dirCandidates({ platform: 'darwin', env: { PATH: '/mine/bin:/usr/bin' }, homedir: '/Users/x' });
  assert.ok(dirs.indexOf('/mine/bin') >= 0 && dirs.indexOf('/mine/bin') < dirs.indexOf('/opt/homebrew/bin'));
});

test('ngrok 输出解析：只采信指向本机端口的 https 隧道', () => {
  const payload = {
    tunnels: [
      { public_url: 'http://a.ngrok-free.app', config: { addr: 'http://localhost:8791' } },
      { public_url: 'https://a.ngrok-free.app', config: { addr: 'http://localhost:9999' } },
      { public_url: 'https://b.ngrok-free.app', config: { addr: 'http://localhost:8791' } },
    ],
  };
  assert.equal(tunnel.pickPublicUrl(payload, 8791), 'https://b.ngrok-free.app', '明文隧道与别的端口的隧道都不能用');
  assert.equal(tunnel.pickPublicUrl(payload, 1234), '');
  assert.equal(tunnel.pickPublicUrl({}, 8791), '');
  assert.equal(tunnel.urlFromLogLine(tunnelLog('https://c.ngrok.app', 8791)), 'https://c.ngrok.app');
  assert.equal(tunnel.urlFromLogLine('lvl=info msg="started tunnel" url=https://d.ngrok.app addr=localhost:8791'), 'https://d.ngrok.app');
  assert.equal(tunnel.urlFromLogLine(JSON.stringify({ lvl: 'info', msg: 'client session established' })), '');
  assert.equal(tunnel.webPortFromLogLine(JSON.stringify({ msg: 'starting web service', addr: '127.0.0.1:4041' })), '4041');
  assert.equal(tunnel.webPortFromLogLine(tunnelLog('https://c.ngrok.app', 8791)), '');
});

test('隧道生命周期：从自家子进程的日志拿到公网地址，停止时杀掉进程', async () => {
  let spawned = null;
  const child = fakeNgrok({ stdout: tunnelLog('https://e11.ngrok-free.app', 8791) + '\n' });
  const handle = await tunnel.startTunnel({
    targetPort: 8791,
    ngrokPath: '/opt/homebrew/bin/ngrok',
    pollMs: 10,
    spawnImpl: (bin, args) => {
      spawned = { bin, args };
      return child;
    },
    getJsonImpl: async () => {
      throw new Error('日志里就有地址，不该去查检查接口');
    },
  });
  assert.equal(handle.url, 'https://e11.ngrok-free.app');
  assert.equal(handle.host, 'e11.ngrok-free.app');
  assert.equal(spawned.bin, '/opt/homebrew/bin/ngrok');
  assert.deepEqual(spawned.args, ['http', '8791', '--log=stdout', '--log-format=json'], 'ngrok 3.x 的 http 子命令只认这几个参数');
  handle.stop();
  assert.equal(child.killed, 'SIGTERM');
});

test('隧道报错：ngrok 的英文报错要翻成能照做的下一步', async () => {
  const noToken = fakeNgrok({ stderr: 'You must sign up for an ngrok account and use your authtoken.\n', exitCode: 1 });
  await assert.rejects(
    () => tunnel.startTunnel({ targetPort: 8791, pollMs: 10, spawnImpl: () => noToken, getJsonImpl: async () => ({}) }),
    /ngrok config add-authtoken/
  );

  const busy = fakeNgrok({ stderr: 'Your account is limited to 1 simultaneous ngrok agent sessions\n', exitCode: 1 });
  await assert.rejects(
    () => tunnel.startTunnel({ targetPort: 8791, pollMs: 10, spawnImpl: () => busy, getJsonImpl: async () => ({}) }),
    /同时只能开一条隧道/
  );

  // 超时：什么都没吐也不能挂着进程不管
  const quiet = fakeNgrok();
  await assert.rejects(
    () => tunnel.startTunnel({ targetPort: 8791, pollMs: 10, waitFor: 60, spawnImpl: () => quiet, getJsonImpl: async () => ({}) }),
    /等待 ngrok 分配公网地址超时/
  );
  assert.equal(quiet.killed, 'SIGTERM', '超时要把半死的 ngrok 收掉');

  // 已经交付给调用方之后再退出：回调报出来，界面不能继续显示「运行中」
  let exitReason = '';
  const later = fakeNgrok({ stdout: tunnelLog('https://e12.ngrok.app', 8791) + '\n' });
  const handle = await tunnel.startTunnel({
    targetPort: 8791,
    pollMs: 10,
    spawnImpl: () => later,
    getJsonImpl: async () => ({}),
    onExit: (r) => {
      exitReason = r;
    },
  });
  assert.equal(handle.url, 'https://e12.ngrok.app');
  later.stderr.emit('data', 'invalid request ERR_NGROK_3104\n');
  later.emit('close', 1);
  assert.match(exitReason, /ERR_NGROK_3104/);
});

test('hub：没装 ngrok 时状态里 installed=false，启动隧道直接报错', async () => {
  const hub = new Hub({ deviceName: '无隧道', saveDir: tmpDir('tunnel-none'), udpPort: 47817 });
  assert.equal(hub.state().tunnel.installed, false);
  assert.equal(hub.state().tunnel.status, 'off');
  await assert.rejects(() => hub.startTunnel(), /没有检测到 ngrok/);
  hub.dispose();
});

test('hub：本机中继真的起得来，并能被当中继地址拨通（隧道要暴露的就是它）', async () => {
  const hub = new Hub({ deviceName: '本机中继', saveDir: tmpDir('local-relay'), udpPort: 47819 });
  const relay = await hub._ensureLocalRelay();
  assert.ok(relay.port > 0, '本机中继要绑到回环的随机端口');
  assert.equal(hub._localRelay, relay, '重复调用要复用同一个本机中继');
  const probe = await probeRelay({ input: `127.0.0.1:${relay.port}`, provider: 'ngrok', code: generateRoomCode() });
  assert.equal(probe.host, `127.0.0.1:${relay.port}`);
  assert.equal(probe.secure, false, '本机这段是明文回环，TLS 由 ngrok 的公网地址负责');
  await hub._stopLocalRelay();
  assert.equal(hub._localRelay, null);
  hub.dispose();
});

test('hub：隧道起来就当中继地址用，停掉或切走服务商都收干净', async () => {
  const hub = new Hub({ deviceName: '隧道房主', saveDir: tmpDir('tunnel-hub'), udpPort: 47818, relayEnabled: true, relayProvider: 'ngrok' });
  hub.setNgrok({ installed: true, path: '/opt/homebrew/bin/ngrok', version: '3.37.2' });
  assert.equal(hub.state().tunnel.installed, true);
  let killed = false;
  let relayClosed = false;
  let opened = 0;
  hub._openRelay = () => {
    opened += 1;
  };
  hub._ensureLocalRelay = async () => ({ port: 8791, close: async () => { relayClosed = true; } });
  hub._spawnTunnel = async ({ targetPort, ngrokPath }) => {
    assert.equal(targetPort, 8791, '隧道要指向本机中继的端口');
    assert.equal(ngrokPath, '/opt/homebrew/bin/ngrok');
    return { url: 'https://t9.ngrok-free.app', host: 't9.ngrok-free.app', pid: 7, stop: () => { killed = true; } };
  };
  // 房间先开着：隧道就绪后要立刻把槽位挂上去，而不是等用户重建房间
  const room = await hub.startRoom();
  assert.ok(room.code);
  const res = await hub.startTunnel();
  assert.equal(res.url, 'https://t9.ngrok-free.app');
  assert.equal(hub.state().tunnel.status, 'running');
  assert.equal(hub.state().relay.url, 'https://t9.ngrok-free.app');
  assert.equal(hub.state().relay.provider, 'ngrok');
  assert.equal(hub.state().relay.enabled, true);
  assert.ok(opened >= 1, '隧道就绪后要把房主侧槽位挂上中继');
  // 重复点「启动隧道」不应该再起一条 ngrok
  const again = await hub.startTunnel();
  assert.equal(again.url, 'https://t9.ngrok-free.app');

  await hub.stopTunnel();
  assert.equal(hub.state().tunnel.status, 'off');
  assert.equal(hub.state().relay.url, '', '隧道地址不能留在设置里当下次的中继地址');
  assert.equal(killed, true);
  assert.equal(relayClosed, true);

  // 切到别的服务商时，隧道进程不能继续在后台空跑
  await hub.startTunnel();
  assert.equal(hub.state().tunnel.status, 'running');
  hub.setSettings({ relayProvider: 'custom', relayUrl: '' });
  await settled(() => hub.state().tunnel.status === 'off', 5_000, '切走服务商后隧道没收掉');
  assert.equal(hub.state().relay.url, '');
  hub.dispose();
});

test('hub：ngrok 自己退了要如实报状态，不能停在「运行中」', async () => {
  const hub = new Hub({ deviceName: '掉线房主', saveDir: tmpDir('tunnel-die'), udpPort: 47820, relayEnabled: true });
  hub.setNgrok({ installed: true, path: '/opt/homebrew/bin/ngrok', version: '3.37.2' });
  hub._openRelay = () => {};
  let relayClosed = false;
  hub._ensureLocalRelay = async () => ({ port: 8792, close: async () => { relayClosed = true; } });
  let exitCb = null;
  hub._spawnTunnel = async ({ onExit }) => {
    exitCb = onExit;
    return { url: 'https://t8.ngrok-free.app', host: 't8.ngrok-free.app', pid: 9, stop: () => {} };
  };
  await hub.startTunnel();
  assert.equal(hub.state().tunnel.status, 'running');
  const events = [];
  hub.on('event', (e) => events.push(e));
  exitCb('ngrok 退出（code=1）');
  assert.equal(hub.state().tunnel.status, 'error');
  assert.match(hub.state().tunnel.error, /ngrok 退出/);
  assert.ok(events.some((e) => e.type === 'notice' && /隧道已断开/.test(e.msg)), '断开要提示给用户');
  assert.equal(hub._tunnel, null);
  hub.dispose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relayClosed, true, '本机中继跟着隧道一起收掉');
});

// 界面层的门禁：没装 ngrok 就不能出现任何 ngrok 入口，这里扫源码守住几个容易改漏的点
test('界面门禁：未检测到 ngrok 时不出现任何 ngrok 入口', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const html = read('src/renderer/index.html');
  const app = read('src/renderer/app.js');

  // 首屏自带 hidden：主进程的状态推过来之前那一瞬间也不能闪出来
  const opt = html.match(/<option[^>]*id="ngrokOption"[^>]*>/);
  const box = html.match(/<div[^>]*id="ngrokBox"[^>]*>/);
  assert.ok(opt && /\shidden(\s|>)/.test(opt[0]), 'ngrok 下拉项要默认 hidden');
  assert.ok(box && /\shidden(\s|>)/.test(box[0]), '隧道配置块要默认 hidden');

  // 可见性只认 installed，换成别的字段就等于把门禁拆了
  assert.match(app, /\$\('ngrokOption'\)\.hidden = !tun\.installed;/);
  assert.match(app, /\$\('ngrokBox'\)\.hidden = !tun\.installed;/);
  // 装过 ngrok、存过 provider=ngrok，之后卸掉了：要退回 cloudflare，不能留个选不中的选项
  assert.match(app, /if \(p === 'ngrok' && !tun\.installed\) return 'cloudflare';/);
  // ngrok 的中继地址由隧道自己写进引擎，输入框隐藏时不能把空串存回去覆盖掉
  assert.match(app, /if \(provider === 'ngrok'\) delete patch\.relayUrl;/);
});

test('IPC 契约：隧道的入口在主进程、preload、界面三处名字对得上', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const main = read('src/main/index.js');
  const preload = read('src/preload/index.js');
  const app = read('src/renderer/app.js');
  for (const [channel, method] of [
    ['skydrop:tunnel-start', 'startTunnel'],
    ['skydrop:tunnel-stop', 'stopTunnel'],
    ['skydrop:tunnel-detect', 'detectNgrok'],
  ]) {
    assert.ok(main.includes(`'${channel}'`), `主进程少了 ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}')`), `preload 少了 ${method}`);
  }
  for (const method of ['startTunnel', 'stopTunnel']) {
    assert.match(app, new RegExp(`api\\.${method}\\(`), `界面没调用 ${method}`);
  }
});
