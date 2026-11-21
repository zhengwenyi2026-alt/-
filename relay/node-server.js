// 自建中继：一台有公网地址的机器跑这个脚本，就能让不同网段的两台设备互传。
// 自动化测试里用的也是它（和 Cloudflare / Vercel 适配层共用 pairing.js）。
//
//   node relay/node-server.js --port 8790 --host 0.0.0.0
//
// 客户端填的中继地址形如 ws://your-host:8790 或 wss://relay.example.com。
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Relay } from './pairing.js';
import { attachRelay } from './server-core.js';

export function createRelayServer({ port = 8790, host = '127.0.0.1', relay = new Relay() } = {}) {
  const server = http.createServer();
  const attached = attachRelay(server, { relay });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address();
      resolve({
        port: actual.port,
        origin: `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual.port}`,
        stats: attached.stats,
        close: () =>
          attached.close().then(
            () =>
              new Promise((done) => {
                server.close(done);
              })
          ),
      });
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const host = readFlag('host', '127.0.0.1');
  const port = Number(readFlag('port', 8790));
  createRelayServer({ port, host })
    .then((srv) => console.log(`SkyDrop 中继已监听 ${srv.origin}（health: /health）`))
    .catch((err) => {
      console.error(`启动失败：${err.message}`);
      process.exit(1);
    });
}
