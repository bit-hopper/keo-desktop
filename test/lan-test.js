// lib/lan.js on this machine's real network interface, no electron: two instances that find each other by multicast and pass one request, and
// raw sockets that behave badly. Needs a private IPv4 address on a non-loopback interface (a wired or wireless connection); without one it says
// so and checks nothing.
//   node test/lan-test.js
const dgram = require('dgram');
const net = require('net');
const { createLan, privateV4, MAX_REQUEST, GROUP, PORT } = require('../lib/lan.js');

let passed = 0, failed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms) => { for (let t = 0; t < (ms || 8000); t += 100) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

(async () => {
  // ---- which addresses count as the local network
  const yes = ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.20', '169.254.3.4', '::ffff:192.168.1.20'];
  const no = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '127.0.0.1', '0.0.0.0', '256.1.1.1', 'fe80::1', '', 'abc'];
  check('private IPv4 addresses are accepted', yes.every((a) => privateV4(a, false)), yes.filter((a) => !privateV4(a, false)));
  check('public, shared, loopback and odd addresses are not', no.every((a) => !privateV4(a, false)), no.filter((a) => privateV4(a, false)));
  check('loopback is accepted only when the caller allows it (the tests)', privateV4('127.0.0.1', true) === true && privateV4('8.8.8.8', true) === false);

  const os = require('os');
  const mine = [].concat(...Object.values(os.networkInterfaces()).map((l) => l || [])).filter((a) => a.family === 'IPv4' && !a.internal && privateV4(a.address, false)).map((a) => a.address);
  if (!mine.length) { console.log('SKIP the network checks: this machine has no private IPv4 address on a non-loopback interface.'); console.log(passed + ' passed, ' + failed + ' failed (network checks skipped)'); process.exit(failed ? 1 : 0); }
  console.log('  using the interface(s): ' + mine.join(', '));

  const seen = [];
  const A = createLan({ intervalMs: 400, onRequest: async (buf, ip) => { seen.push({ ip, text: buf.toString() }); return Buffer.from('reply:' + buf.toString().split('').reverse().join('')); } });
  const B = createLan({ intervalMs: 400, onRequest: async () => null });
  const C = createLan({ intervalMs: 400, onRequest: async () => Buffer.alloc(9 * 1024, 1) });       // a reply that is too large

  try {
    // ---- finding each other
    const sa = await A.start({ payload: 'tagAAAA' });
    check('a visible instance listens for requests on a port of its own', sa.port > 1024 && A.tcpPort() === sa.port, sa);
    const sb = await B.start({ payload: null });
    check('an instance that only listens opens no request port', sb.port === 0 && B.tcpPort() === 0, sb);
    const found = await poll(() => B.peers().find((p) => p.payload === 'tagAAAA'));
    check('the listener hears the announcement, with the sender\'s address and request port', !!found && mine.indexOf(found.ip) >= 0 && found.port === sa.port, found);
    check('an instance does not list its own announcement', !A.peers().some((p) => p.payload === 'tagAAAA'), A.peers());

    // ---- one request and its reply
    const reply = await B.request(found.ip, found.port, Buffer.from('hello'));
    check('a request reaches the announcing instance and its reply comes back', reply.toString() === 'reply:olleh' && seen.length === 1 && seen[0].text === 'hello', { reply: reply.toString(), seen });
    check('and the receiver sees the sender\'s address, not one the sender claimed', mine.indexOf(seen[0].ip) >= 0, seen);
    const noRoute = await B.request('192.168.254.254', 4242, Buffer.from('x')).then(() => 'sent', (e) => e.message);
    check('a request to an address nobody announced is refused before anything is sent', /no longer announcing/.test(noRoute), noRoute);
    const none = await B.request(found.ip, found.port, Buffer.alloc(MAX_REQUEST + 1)).then(() => 'sent', (e) => e.message);
    check('a request over the size cap is refused locally', /wrong size/.test(none), none);
    const declined = await (async () => { await C.start({ payload: 'tagCCCC' }); const f = await poll(() => B.peers().find((p) => p.payload === 'tagCCCC')); return B.request(f.ip, f.port, Buffer.from('x')).then(() => 'got a reply', (e) => e.message); })();
    check('a reply over the size cap is not delivered', /unusable|closed/.test(declined), declined);
    const refusedNull = await (async () => { await B.start({ payload: 'tagBBBB' }); const f = await poll(() => A.peers().find((p) => p.payload === 'tagBBBB')); return A.request(f.ip, f.port, Buffer.from('x')).then(() => 'got a reply', (e) => e.message); })();
    check('a page that gives no reply ends the request without one', /closed|unusable|could not/.test(refusedNull), refusedNull);

    // ---- bad behaviour on the request port
    const port = sa.port, addr = mine[0];
    const probe = (send, wait) => new Promise((res) => {
      const s = net.connect({ host: addr, port }); let got = 0, closedAt = null; const t0 = Date.now();
      s.on('connect', () => { try { send(s); } catch (e) {} });
      s.on('data', (d) => { got += d.length; });
      s.on('error', () => {});
      s.on('close', () => { closedAt = Date.now() - t0; res({ got, closedAt }); });
      setTimeout(() => { if (closedAt === null) { s.destroy(); } }, wait || 7000);
    });
    const huge = await probe((s) => { const h = Buffer.alloc(4); h.writeUInt32BE(MAX_REQUEST + 1, 0); s.write(h); }, 3000);
    check('a request announcing more than the cap is cut at once', huge.got === 0 && huge.closedAt < 1500, huge);
    const zero = await probe((s) => { s.write(Buffer.alloc(4)); }, 3000);
    check('a request of length zero is cut', zero.got === 0 && zero.closedAt < 1500, zero);
    const extra = await probe((s) => { const h = Buffer.alloc(4); h.writeUInt32BE(3, 0); s.write(Buffer.concat([h, Buffer.from('abcdef')])); }, 3000);
    check('more bytes than the request announced cut it (nothing is answered)', extra.got === 0, extra);
    const before = seen.length;
    const slow = await probe((s) => { const h = Buffer.alloc(4); h.writeUInt32BE(100, 0); s.write(Buffer.concat([h, Buffer.from('ab')])); }, 9000);
    check('a request that stalls is cut after a few seconds and never reaches the page', slow.got === 0 && slow.closedAt > 3500 && slow.closedAt < 8000 && seen.length === before, { slow, delivered: seen.length - before });
    // per-address limit: two slow connections from one address are allowed, the third is cut at once
    const hold = [0, 1].map(() => { const s = net.connect({ host: addr, port }); s.on('error', () => {}); return s; });
    await sleep(300);
    const third = await probe(() => {}, 1500);
    check('a third open connection from one address is cut at once', third.closedAt !== null && third.closedAt < 1000, third);
    hold.forEach((s) => s.destroy());

    // ---- bad datagrams are ignored
    const raw = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    raw.bind(0, '0.0.0.0'); await new Promise((r) => raw.once('listening', r));
    raw.setMulticastInterface(addr);
    const send = (text) => new Promise((r) => raw.send(Buffer.from(text, 'latin1'), PORT, GROUP, () => r()));
    const bad = ['junk', 'KEOLAN1 80 tagLowPort', 'KEOLAN1 99999 tagHighPort', 'KEOLAN1 5000 bad payload!', 'KEOLAN2 5000 tagOtherVersion', 'KEOLAN1 5000 ' + 'x'.repeat(121), 'KEOLAN1 5000 ' + 'y'.repeat(300)];
    for (const t of bad) await send(t);
    await send('KEOLAN1 5000 tagGoodOne');
    const good = await poll(() => B.peers().find((p) => p.payload === 'tagGoodOne'));
    check('a well-formed announcement from another sender is listed', !!good && good.port === 5000, good);
    check('and none of the malformed ones is', !B.peers().some((p) => /Low|High|bad|OtherVersion|^x|^y/.test(p.payload)), B.peers());
    raw.close();

    // ---- each way of announcing works on its own (a network may drop one of them)
    const bc = os.networkInterfaces();
    const sub = [].concat(...Object.values(bc).map((l) => l || [])).filter((x) => x.family === 'IPv4' && !x.internal && privateV4(x.address, false) && x.address === addr)[0];
    const ipp = sub.address.split('.').map(Number), mm = sub.netmask.split('.').map(Number), bcastAddr = ipp.map((n, i) => (n | (~mm[i] & 255))).join('.');
    const onlyB = createLan({ intervalMs: 400, mechanisms: ['broadcast'], onRequest: async () => null }), onlyM = createLan({ intervalMs: 400, mechanisms: ['multicast'], onRequest: async () => null });
    const listener = createLan({ intervalMs: 400, onRequest: async () => null });
    try {
      await listener.start({ payload: null });
      await onlyB.start({ payload: 'tagBroadcastOnly' }); await onlyM.start({ payload: 'tagMulticastOnly' });
      const fb = await poll(() => listener.peers().find((p) => p.payload === 'tagBroadcastOnly'));
      const fm = await poll(() => listener.peers().find((p) => p.payload === 'tagMulticastOnly'));
      check('an announcement sent only by subnet broadcast (' + bcastAddr + ') is heard', !!fb && fb.port === onlyB.tcpPort(), fb);
      check('and one sent only by multicast is heard', !!fm && fm.port === onlyM.tcpPort(), fm);
      const rawb = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      rawb.bind(0, '0.0.0.0'); await new Promise((r) => rawb.once('listening', r)); rawb.setBroadcast(true);
      await new Promise((r) => rawb.send(Buffer.from('KEOLAN1 5003 tagRawBroadcast', 'latin1'), PORT, bcastAddr, () => r()));
      const fr = await poll(() => listener.peers().find((p) => p.payload === 'tagRawBroadcast'));
      check('a well-formed datagram from another sender sent to the broadcast address is listed', !!fr && fr.port === 5003, fr);
      await new Promise((r) => rawb.send(Buffer.from('KEOLAN1 80 tagBroadcastLowPort', 'latin1'), PORT, bcastAddr, () => r()));
      await sleep(600);
      check('and a malformed one by broadcast is not', !listener.peers().some((p) => /LowPort/.test(p.payload)), listener.peers());
      rawb.close();
    } finally { onlyB.close(); onlyM.close(); listener.close(); }

    // ---- stopping
    A.stop();
    const gone = await net.connect({ host: addr, port }).on('error', () => {}) && await new Promise((res) => { const s = net.connect({ host: addr, port }); s.on('connect', () => { s.destroy(); res('connected'); }); s.on('error', () => res('refused')); });
    check('a stopped instance no longer answers on its port', gone === 'refused', gone);
    check('and forgets what it had heard', A.peers().length === 0);
    await sleep(500);
  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  } finally { A.close(); B.close(); C.close(); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
