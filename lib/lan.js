// Finding friends on the same network, and carrying ONE request and its reply to them: the part of "dial by key" that a page cannot do
// (a page cannot listen on the network). Plain node, no electron, no keys, no identities: it moves bytes the page gives it and hands the
// page what arrives, and the page (keo's shell/keo-lan.js) decides what any of it means. Nothing here can be trusted to say who sent
// something: an announcement names an address, and a request names nobody. Who it is for and who sent it is settled by the signature
// inside the request and by the connection's own proof afterwards.
//
// Two things on the network:
//  - ANNOUNCEMENTS: a short datagram sent to a multicast group every few seconds while the person is visible: "KEOLAN1 <tcp port> <payload>".
//    The payload is whatever the page gave (a rotating tag, not a name). Everyone on the network can read it; only a device that knows
//    the DID the tag was made from can tell whose it is.
//  - ONE REQUEST: a TCP connection to the port an announcement named, carrying a length-prefixed request, answered by a length-prefixed reply
//    from the page. Plain text on the wire: anyone on the network can read it.
//
// Limits (the network is assumed hostile): addresses outside the private ranges are never accepted or contacted; datagrams and requests
// are small and capped; a flood of datagrams is dropped; a connection that is slow is cut; a request can be sent only to an address and
// port that an announcement named a short while ago; the page decides nothing about where a connection goes beyond that.
// Not done: IPv6, a way through a network that blocks multicast or isolates its clients (the person is told nothing was found).
'use strict';
const dgram = require('dgram');
const net = require('net');
const os = require('os');

const GROUP = '239.255.77.43', PORT = 47430, MAGIC = 'KEOLAN1';
const MAX_DATAGRAM = 200, MAX_PAYLOAD = 120, MAX_REQUEST = 48 * 1024, MAX_REPLY = 8 * 1024;
const SEEN_MS = 20000, MAX_PEERS = 256, READ_MS = 5000, ANSWER_MS = 25000, MAX_INBOUND = 8, PER_IP = 2;

// IPv4 only: 10/8, 172.16/12, 192.168/16, link-local 169.254/16, and loopback (only when the caller allows it, for tests).
function privateV4(ip, allowLoopback) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip));
  if (!m) return false;
  const a = m.slice(1).map(Number);
  if (a.some((n) => n > 255)) return false;
  if (a[0] === 10) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  return !!allowLoopback && a[0] === 127;
}
const plain = (ip) => String(ip).replace(/^::ffff:/, '');

// opts: { onRequest(buffer, ip) -> Promise<Buffer|null>, group, port, intervalMs, allowLoopback, interfaces() -> [ipv4 addresses to use] }
function createLan(opts) {
  const group = opts.group || GROUP, port = opts.port || PORT, intervalMs = opts.intervalMs || 4000, allowLoopback = !!opts.allowLoopback;
  const ifaces = opts.interfaces || (() => {
    const out = [];
    const all = os.networkInterfaces();
    for (const name of Object.keys(all)) for (const a of all[name] || []) if (a.family === 'IPv4' && !a.internal && privateV4(a.address, false)) out.push(a.address);
    return out;
  });
  let udp = null, server = null, timer = null, payload = null, tcpPort = 0, joined = new Set(), closed = false;
  const table = new Map();                       // "ip:port" -> { ip, port, payload, at }
  const inbound = new Map();                     // ip -> open connections from it
  let open = 0;
  // A token bucket for datagrams: a burst, then a steady rate. What arrives faster is dropped without being looked at.
  let tokens = 200, refilled = Date.now();
  function allow() {
    const t = Date.now();
    tokens = Math.min(200, tokens + ((t - refilled) / 1000) * 100);
    refilled = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function onDatagram(msg, rinfo) {
    if (msg.length > MAX_DATAGRAM || !allow()) return;
    if (!privateV4(rinfo.address, allowLoopback)) return;
    const m = /^KEOLAN1 (\d{1,5}) ([A-Za-z0-9_-]{1,120})$/.exec(msg.toString('latin1'));
    if (!m) return;
    const p = Number(m[1]);
    if (p < 1024 || p > 65535) return;
    const ip = plain(rinfo.address);
    if (server && p === tcpPort && ownAddresses().has(ip)) return;            // our own announcement coming back
    const key = ip + ':' + p;
    if (!table.has(key) && table.size >= MAX_PEERS) {
      let oldest = null;
      table.forEach((v, k) => { if (!oldest || v.at < table.get(oldest).at) oldest = k; });
      table.delete(oldest);
    }
    table.set(key, { ip: ip, port: p, payload: m[2], at: Date.now() });
  }
  function ownAddresses() {
    const s = new Set(ifaces());
    if (allowLoopback) s.add('127.0.0.1');
    return s;
  }
  function peers() {
    const t = Date.now(), out = [];
    table.forEach((v, k) => { if (t - v.at > SEEN_MS) table.delete(k); else out.push({ ip: v.ip, port: v.port, payload: v.payload, age: t - v.at }); });
    return out;
  }

  function join() {
    // Every private interface the machine has, not just the first: a machine with a virtual adapter or a VPN would otherwise listen on the wrong one.
    for (const a of ifaces()) {
      if (joined.has(a)) continue;
      try { udp.addMembership(group, a); joined.add(a); } catch (e) {}
    }
  }
  function announce() {
    if (!udp || payload === null || !tcpPort) return;
    join();
    const buf = Buffer.from(MAGIC + ' ' + tcpPort + ' ' + payload, 'latin1');
    for (const a of ifaces()) {
      try { udp.setMulticastInterface(a); udp.send(buf, port, group); } catch (e) {}
    }
  }

  // ---- the request server ---------------------------------------------------------------------------------------------
  function serve(sock) {
    const ip = plain(sock.remoteAddress || '');
    const n = inbound.get(ip) || 0;
    if (!privateV4(ip, allowLoopback) || open >= MAX_INBOUND || n >= PER_IP) return sock.destroy();
    open++; inbound.set(ip, n + 1);
    sock.once('close', () => { open--; const k = (inbound.get(ip) || 1) - 1; if (k) inbound.set(ip, k); else inbound.delete(ip); });
    sock.on('error', () => sock.destroy());
    sock.setTimeout(READ_MS, () => sock.destroy());
    const parts = []; let got = 0, want = -1, answered = false;
    sock.on('data', (d) => {
      if (answered) return;
      parts.push(d); got += d.length;
      const all = Buffer.concat(parts);
      if (want < 0 && all.length >= 4) {
        want = all.readUInt32BE(0);
        if (want < 1 || want > MAX_REQUEST) return sock.destroy();
      }
      if (want < 0 || all.length < 4 + want) return;
      if (all.length > 4 + want) return sock.destroy();                         // more than it said it would send
      answered = true;
      sock.setTimeout(0);
      const request = all.slice(4);
      let done = false;
      const timeout = setTimeout(() => { if (!done) { done = true; sock.destroy(); } }, ANSWER_MS);
      Promise.resolve().then(() => opts.onRequest(request, ip)).then((reply) => {
        if (done) return; done = true; clearTimeout(timeout);
        if (!reply || !reply.length || reply.length > MAX_REPLY) return sock.destroy();
        const head = Buffer.alloc(4); head.writeUInt32BE(reply.length, 0);
        sock.end(Buffer.concat([head, reply]));
      }, () => { if (!done) { done = true; clearTimeout(timeout); sock.destroy(); } });
    });
  }

  // payload: a string to announce (and to serve requests while it is announced), or null to listen only.
  async function start(args) {
    if (closed) throw new Error('closed');
    const p = args && args.payload != null ? String(args.payload) : null;
    if (p !== null && !/^[A-Za-z0-9_-]{1,120}$/.test(p)) throw new Error('bad payload');
    if (!udp) {
      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udp.on('error', () => {});
      udp.on('message', onDatagram);
      await new Promise((res, rej) => { udp.once('error', rej); udp.bind(port, '0.0.0.0', () => { udp.removeListener('error', rej); res(); }); });
      try { udp.setMulticastTTL(1); udp.setMulticastLoopback(true); } catch (e) {}
      join();
    }
    if (p !== null && !server) {
      server = net.createServer(serve);
      server.maxConnections = MAX_INBOUND;
      await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '0.0.0.0', () => { server.removeListener('error', rej); res(); }); });
      server.on('error', () => {});
      tcpPort = server.address().port;
    }
    if (p === null && server) { const s = server; server = null; tcpPort = 0; s.close(); }
    payload = p;
    if (timer) { clearInterval(timer); timer = null; }
    if (p !== null) { announce(); timer = setInterval(announce, intervalMs); }
    return { port: tcpPort };
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    payload = null; tcpPort = 0;
    if (server) { const s = server; server = null; try { s.close(); } catch (e) {} }
    if (udp) { const u = udp; udp = null; joined = new Set(); try { u.close(); } catch (e) {} }
    table.clear();
  }

  // Sends one request to an address and port an announcement named a short while ago, and resolves the reply (a Buffer). Rejects with a
  // sentence otherwise.
  function request(ip, p, body) {
    return new Promise((resolve, reject) => {
      const key = plain(ip) + ':' + p, hit = table.get(key);
      if (!hit || Date.now() - hit.at > SEEN_MS) return reject(new Error('That device is no longer announcing itself on this network.'));
      if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_REQUEST) return reject(new Error('That request is the wrong size.'));
      const sock = net.connect({ host: hit.ip, port: hit.port });
      const parts = []; let want = -1, finished = false;
      const fail = (m) => { if (finished) return; finished = true; sock.destroy(); reject(new Error(m)); };
      sock.setTimeout(ANSWER_MS + 5000, () => fail('The other device did not answer in time.'));
      sock.on('error', () => fail('The other device could not be reached on this network.'));
      sock.on('connect', () => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0); sock.write(Buffer.concat([head, body])); });
      sock.on('data', (d) => {
        parts.push(d);
        const all = Buffer.concat(parts);
        if (want < 0 && all.length >= 4) { want = all.readUInt32BE(0); if (want < 1 || want > MAX_REPLY) return fail('The other device sent something unusable.'); }
        if (want >= 0 && all.length >= 4 + want) { if (all.length > 4 + want) return fail('The other device sent something unusable.'); finished = true; sock.destroy(); resolve(all.slice(4)); }
      });
      sock.on('close', () => fail('The other device closed the connection without answering.'));
    });
  }
  function close() { closed = true; stop(); }

  return { start, stop, peers, request, close, tcpPort: () => tcpPort, _table: table };
}

module.exports = { createLan, privateV4, GROUP, PORT, MAX_REQUEST, MAX_REPLY };
