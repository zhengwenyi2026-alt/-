// Vercel 版中继入口：Vercel 的 Node Functions 直接接受一个 http.Server，
// WebSocket 升级由平台透传给它（需要项目开启 Fluid 计算）。
//
// 部署时把 Vercel 的 Root Directory 设成 relay/，本文件就挂在 /api/room；
// 房间码走 ?room=（vercel.json 的 rewrite 会把 /api/room/ABC123 改写成 /api/room）。
import http from 'node:http';
import { attachRelay } from '../server-core.js';

const server = http.createServer();
attachRelay(server);

export default server;
