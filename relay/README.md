# SkyDrop 跨网中继部署说明

局域网内两台设备互传不需要这里任何东西——只有当两台设备**不在同一个 Wi-Fi / 蜂窝网络**下（公司网络隔离了组播与局域网端口、或者根本不在同一个城市）时，才需要一台能被两边访问到的**中继**。

中继只做一件事：**按房间码把两条 WebSocket 连接缝在一起，然后原样搬字节**。它不需要理解传输协议，也不需要存文件。

```
 设备 A（房主）                     中继                      设备 B（访客）
 ws 连接 ×3，role=host   ─────►   /room/<房间码>   ◄─────   ws 连接 ×1，role=guest
                                   配对后双向透传
```

- 房主建房后**预先挂 3 条** `role=host` 连接（`src/main/engine/relay.js` 的 `RELAY_SLOTS`），一条被配对掉就立刻补一条，所以房主不需要知道什么时候有人来。
- 访客拨 `role=guest`，命中一条空闲的 host 槽就算配对成功；没有则立刻拿到 `no-host` 错误。
- 配对之后中继只转发字节，上层协议（`src/main/engine/protocol.js`）完全感觉不到中间隔了一层。

三种运行时共用同一份配对状态机 [`pairing.js`](./pairing.js)，行为完全一致：

| 文件 | 运行时 | 说明 |
| --- | --- | --- |
| [`pairing.js`](./pairing.js) | 通用 | 房间/槽位/配对状态机 + 控制帧格式 + URL 解析 |
| [`server-core.js`](./server-core.js) | Node | 把状态机挂到一个 `http.Server` 上（自建与 Vercel 共用） |
| [`node-server.js`](./node-server.js) | Node | 自建中继入口，也是自动化测试用的实现 |
| [`api/room.js`](./api/room.js) + [`vercel.json`](./vercel.json) | Vercel | 导出一个 `http.Server`，由 Vercel 直接接管 WebSocket 升级 |
| [`cloudflare/worker.js`](./cloudflare/worker.js) + [`wrangler.toml`](./wrangler.toml) | Cloudflare | 每个房间码一个 Durable Object |

---

## 该选哪一种

| | Cloudflare Workers | Vercel | 自建 Node |
| --- | --- | --- | --- |
| 免费可用性 | 好（无需服务器、无需信用卡） | 一般，见下面的限制 | 取决于你自己的机器 |
| 配对可靠性 | **可靠**：Durable Object 按房间码分片，同一房间必然落到同一实例 | **不保证**：两条连接可能被投到不同函数实例，实例之间不共享内存，命中不到就报 `no-host` | 可靠（单进程共享内存） |
|  HTTPS/WSS | 自带 `*.workers.dev` 域名与证书 | 自带 `*.vercel.app` 域名与证书 | 要自己配证书，或只用 `ws://` |
| 单次传输时长 | 只要连接上有流量就可以一直续 | 受函数 `maxDuration` 限制（配置里给了 300 秒） | 不限 |
| 建议 | **首选** | 临时救急、已经熟悉 Vercel 时用 | 想要完全自己掌控、或在公网自己有机房时用 |

一句话：**要长期用就选 Cloudflare 或自建。** Vercel 那份是可用但不可靠的，原因在它的平台模型里，不在代码里。

---

## 方案一：Cloudflare Workers（推荐）

一条连接都不落地自己的机器，免费额度对「偶尔传个文件」完全够用。

1. 注册 [Cloudflare](https://dash.cloudflare.com/)（免费版即可），装好 Node 20+。
2. 在本目录登录并部署：

   ```bash
   cd relay
   npx --yes wrangler@latest login     # 会弹浏览器授权
   npm run deploy:cloudflare           # 等价于 npx wrangler deploy
   ```

   部署成功后会打印一行 `https://skydrop-relay.<你的子域>.workers.dev`，**这串域名就是客户端要填的中继地址**。
3. 验证：浏览器打开这个域名会看到 `SkyDrop 中继已就绪。客户端「跨网传输」里填 …`；打开 `/health` 会返回 `{"ok":true,"runtime":"cloudflare-durable-object","proto":1}`。
4. 客户端填法：跨网传输 → 服务商选 **Cloudflare** → 中继地址填 `skydrop-relay.<你的子域>.workers.dev`（带不带 `https://` 都行）→ 点「测试连接」。

改过代码之后重新执行第 2 步即可；`wrangler dev`（`npm run dev:cloudflare`）能在本机 `http://localhost:8787` 起一个带 Durable Object 的本地实例，方便调试。

### 这份实现里几个和 Cloudflare 特性相关的点

- **为什么必须用 Durable Object**：普通 Worker 每条请求都是全新隔离环境，两条连接之间没法保存「谁和谁配了对」。DO 用 `idFromName(房间码)` 分片，同一房间的所有连接必然落到同一个实例。
- **休眠与唤醒**：DO 空闲时会被回收内存，但连接由平台继续持有。所以每条连接的 `{id, 房间码, 角色, 对端 id}` 都序列化在 WebSocket 附件里（上限 16 KB，我们这几个字段远够用），实例重新唤醒时按附件重建配对表——正在传的文件不受影响，房主预开的槽也感觉不到这次回收。
- **消息大小**：应用层分片 256 KB；Workers 的 WebSocket 单条消息上限从 2025-10-31 起是 32 MiB，所以不需要为它单独降片。
- **空闲超时**：客户端每 25 秒发一次 WebSocket ping 帧（`RELAY_PING`），平台会自动回 pong 并重置空闲计时，这样「等对方点接收」等上半分钟也不会被掐断。

---

## 方案二：Vercel

Vercel 的 Node 函数可以直接导出一个 `http.Server`，平台把 WebSocket 升级请求交给它，[`api/room.js`](./api/room.js) 就是这个形态。

1. 把这个仓库（或只把 `relay/` 目录）推到 GitHub。
2. Vercel 控制台 New Project → 导入仓库 → **Root Directory 必须设成 `relay`**（否则找不到 `/api/room`）。
3. Framework Preset 选 **Other**，Build Command 留空，Output Directory 留空。
4. **必须开启 Fluid 计算**：Project Settings → Function Concurrency / Fluid → 打开。没有 Fluid 时 WebSocket 升级不支持。
5. 部署，得到 `https://<项目名>.vercel.app`。
6. 客户端填法：服务商选 **Vercel**，中继地址填 `<项目名>.vercel.app`（也可以直接填 `https://<项目名>.vercel.app`）。程序会自动拼成 `wss://<项目名>.vercel.app/api/room/<房间码>?role=…&room=<房间码>`。

### 两个必须知道的限制

- **实例之间不共享内存**：房主的连接落在实例 A、访客落在实例 B 时，B 上根本没有那个房间，访客会拿到 `no-host`（界面提示「中继上没有这个房间…」）。低流量时平台通常会复用同一个热实例，但这是**运气不是保证**。遇到这种情况让双方各自关掉再打开一次「跨网传输」，重新建房/加入即可。要彻底避免请用 Cloudflare 或自建。
- **时长受 `maxDuration` 限制**：[`vercel.json`](./vercel.json) 里给了 300 秒，连接活到点就被平台断开，正在传的文件会失败。要更长得在 Vercel 控制台把函数最长时间调大（付费计划才允许更长的值），或者改这里的配置。

### 为什么房间码写了两遍

`vercel.json` 的 rewrite 会把 `/api/room/ABC123` 改写成固定的函数路径 `/api/room`，路径里的房间码会被抹掉，只有 query 能原样带过去。所以拨号串同时带上：

```
wss://xxx.vercel.app/api/room/ABC123?role=guest&room=ABC123
                     └─ Cloudflare / 自建读这里      └─ Vercel 读这里
```

`pairing.js` 的 `parseRelayPath()` 两条路都认：路径合法用路径，路径被改写或非法时回落到 `?room=`。

---

## 方案三：自建 Node

有一台带公网地址的机器（VPS、家里带公网 IP 的 NAS、公司跳板机）时用这个。

```bash
cd relay
npm install            # 只有一个依赖：ws
node node-server.js --host 0.0.0.0 --port 8790
```

看到 `SkyDrop 中继已监听 ws://127.0.0.1:8790（health: /health）`（`--host 0.0.0.0` 时打印的是回环地址，实际已在所有网卡上监听）就成了。浏览器访问 `http://<公网地址>:8790/health` 应返回 `{"ok":true,"rooms":0,"waiting":0,"pairs":0}`。

客户端填法：服务商选 **自建 / 其它**，中继地址填 `ws://<公网地址>:8790` 或 `wss://relay.example.com`。

### 让它常驻（systemd）

```ini
# /etc/systemd/system/skydrop-relay.service
[Unit]
Description=SkyDrop relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/skydrop/relay/node-server.js --host 0.0.0.0 --port 8790
Restart=always
User=nobody
# 单条应用层分片 256 KB，默认文件描述符限制够用
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

### 套一层 HTTPS（强烈建议）

明文 `ws://` 会在公网上把内容裸奔，而且部分网络会拦非标准端口。用 nginx 反代成 `wss://` 最省事——**必须把 Upgrade 头透传上来，并且把读超时调到大于客户端 25 秒的 ping 间隔**：

```nginx
location /room/ {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

配好后客户端填 `wss://relay.example.com` 即可（路径由程序自己拼，不需要写 `/room/`）。

---

## 界面上的「跨网传输」怎么用

1. 打开设置里的**跨网传输**卡片，勾上「允许通过互联网连接（需要下面填一个中继地址）」。
2. 选服务商（Cloudflare / Vercel / 自建 / 其它），填中继地址。
3. 点**测试连接**：程序会拿一个随机房间码挂一条连接上去，收到中继的 `hello-ack` 就报「中继可用 · <地址>」。这一步不需要对方在线。
4. 房主点**创建房间**：局域网发现照常工作，同时把 3 条槽位挂到中继上，房间面板会出现一行「房间已通过中继开放，对方在任意网络输入房间码即可加入」。
5. 访客**不必在同一个网络**：直接点房间码输入框下面的**「对方不在同一网络？经中继加入」**，输入对方告诉你的 6 位房间码。（就算走普通的「加入房间」按钮也行——局域网找不到这个房间时应用会自动改走中继，并提示一声。）
6. 连接建立后设备名旁边会出现「互联网中继」标记；之后的接收确认、进度、历史记录和局域网完全一样。

安全默认值：**跨网传输默认关闭**。只有你自己填了中继地址并打开开关，应用才会向外拨连接；房间码猜错的人在你没开开关时根本摸不到端口。

---

## 错误码对照

| 中继回的 `code` | 界面提示 | 常见原因 |
| --- | --- | --- |
| `no-host` | 中继上没有这个房间，请确认对方已开启「跨网传输」并创建房间 | 对方没建房 / 房间码错了 / 对方关了跨网开关；Vercel 上还可能是两条连接落在了不同实例 |
| `bad-room` | 房间码格式不正确 | 地址后面拼错了路径，或房间码不是 6 位字母数字 |
| `bad-role` | 中继角色参数不正确 | 手工拼的 URL 少了 `role=` |
| `room-limit` | 中继上的房间数量已达上限 | 单实例超过 256 个房间（默认上限），一般只会在公开共享的中继上遇到 |
| `slot-limit` | 中继上该房间的等待槽已满 | 同一房间码挤了超过 16 条待配对连接 |

连接层面的提示：`中继连接失败：…`（域名解析/证书/端口不通）、`中继连接超时`、`中继配对超时，请确认地址可用`（20 秒内没配上）、`中继断开了连接`、`中继连接中断，正在重试`（房主侧按 1/2/4/8/15 秒退避重连）。

---

## 隐私警告：中继看得到内容

配对后的帧是**原样转发**的，所以中继运营方（Cloudflare、Vercel，或者那台机器的 root）**理论上能读到传输的文件内容和文件名**——目前这一层没有端到端加密。

因此：

- 传敏感文件请优先选**自建中继**（自己那台机器），或者只在信任的双方之间用；
- 中继代码里不写盘、不记日志，房间与配对只存在内存里，两端任一连接断开就立刻从登记表里摘掉；
- 想要真正的端到端加密是一个后续项（需要在配对之后做一次密钥协商，让中继只能看到密文），当前版本尚未实现。

---

## 本地开发与自动化测试

不需要任何云账号就能验证中继逻辑：

```bash
cd ..          # 回到项目根目录
npm test       # 含 6 个跨网中继用例
npm run e2e    # 起本地中继 + 两个真实应用实例，走一遍跨网传输界面流程
```

`npm test` 里和跨网有关的部分：

| 用例 | 覆盖内容 |
| --- | --- |
| 跨网中继：各种用户输入都能归一化成可拨号地址 | 域名 / `https://` / `wss://` / `localhost:8790` / 直接粘完整拨号串，以及服务商选错但地址填对时的自动纠正 |
| 跨网中继：配对状态机排队、配对、双向透传、断开联动 | `pairing.js` 的核心语义 |
| 跨网中继：配对失败的错误帧与休眠后的状态恢复 | `relayJoin` 的错误帧 + `restoreWaiting` / `restorePair`（对应 Cloudflare 唤醒路径） |
| 跨网中继：Cloudflare Worker 版按房间分片、透传与休眠唤醒 | 用最小替身跑 `cloudflare/worker.js`：分片路由、控制帧、256 KB 透传、**内存清空后凭附件重建配对**、一端断开连带关闭 |
| 跨网中继：Vercel 入口在 rewrite 之后仍能配对与透传 | 真起 `api/room.js` 导出的 `http.Server`，用 rewrite 之后的 `/api/room?role=…&room=…` 形态拨号 |
| 跨网中继：两台设备只经中继完成双向传文件 | 关掉局域网发现，两个 Hub 只靠 `node-server.js` 完成目录树传输与回传 |

改 `pairing.js` 之后至少要跑过 `npm test`；它同时是三份运行时的公共底座。
