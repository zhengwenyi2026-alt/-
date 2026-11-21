'use strict';

const os = require('os');

function ipToLong(ip) {
  const parts = String(ip).split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

/**
 * 列出可用的局域网 IPv4 网卡地址，附带子网广播地址。
 * Wi-Fi / 有线优先，虚拟网卡（utun、vmnet、bridge 等）排在后面。
 */
function lanInterfaces() {
  const table = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(table)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      const ipLong = ipToLong(addr.address);
      const maskLong = ipToLong(addr.netmask);
      if (ipLong === null || maskLong === null) continue;
      const broadcast = longToIp(((ipLong & maskLong) + (~maskLong >>> 0)) >>> 0);
      list.push({ name, address: addr.address, mask: addr.netmask, broadcast, metric: ifacePriority(name) });
    }
  }
  return list.sort((a, b) => a.metric - b.metric || a.name.localeCompare(b.name));
}

function ifacePriority(name) {
  if (/^en[0-9]+$/.test(name)) return 0; // macOS 的 en0 通常是 Wi-Fi
  if (/^(wl|wlan|eth)/i.test(name)) return 0; // Windows/Linux 无线与有线
  if (/^(utun|ipsec|tap|tun|ppp)/i.test(name)) return 3; // VPN 隧道，仅兜底
  if (/^(vmnet|vbridge|br-|virbr|docker|zerotier|awdl|llw|stf|anpi)/i.test(name)) return 4;
  return 2;
}

/** 是否为私网/回环地址（默认只在可信网络内监听） */
function isPrivateAddress(ip) {
  const long = ipToLong(String(ip).replace(/^::ffff:/, ''));
  if (long === null) return false;
  return (
    (long >>> 24) === 127 || // 127.0.0.0/8
    (long >>> 20) === (10 << 4) || // 10.0.0.0/8
    ((long >>> 22) === (172 * 4 + 1)) || // 172.16.0.0/12
    ((long >>> 16) === (192 * 256 + 168)) || // 192.168.0.0/16
    ((long >>> 22) === (169 * 4 + 16)) // 169.254.0.0/16 链路本地
  );
}

/** UDP 发现需要轮询的广播目标 */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const iface of lanInterfaces()) {
    if (iface.broadcast) targets.add(iface.broadcast);
  }
  return [...targets];
}

/**
 * 广播被路由器/AP 隔离拦掉时的兜底：把每块真实网卡所在 /24 网段逐个地址单播一遍。
 * 单播通常不受组播/广播过滤影响，每块网卡最多 254 个目标；VPN 与虚拟网卡不参与。
 */
function unicastProbeTargets() {
  const targets = new Set();
  for (const iface of lanInterfaces()) {
    if (iface.metric >= 3) continue;
    const ipLong = ipToLong(iface.address);
    if (ipLong === null) continue;
    const base = ipLong & 0xffffff00; // 收敛到所在 /24，网段再大也只扫这一段
    for (let n = 1; n <= 254; n += 1) targets.add(longToIp(base + n));
  }
  targets.delete('127.0.0.1');
  return [...targets];
}

/** 给界面展示的本机地址列表 */
function localAddresses() {
  return lanInterfaces().map((i) => ({ name: i.name, address: i.address }));
}

module.exports = { lanInterfaces, broadcastTargets, unicastProbeTargets, isPrivateAddress, localAddresses, ipToLong, longToIp };
