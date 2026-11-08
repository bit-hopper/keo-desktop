// TWO copies of the desktop app on this machine, each with its own profile and a virtual authenticator, finding each other on the real local
// network and connecting by key (the friend's DID), with no code passed by anyone. Plain node: it starts both apps and drives them over their
// debugging ports (playwright-core is taken from the keo repo's node_modules).
//
//   node scripts/lan.js --package <desktop package> --work <scratch folder> --playwright <keo repo folder> [--shots <folder>]
//
// The apps use the machine's own network interface and multicast (so a machine with no private network address cannot run this), and every
// address except the apps' own is made unreachable. Friends are added with the contact book's own function, NOT through the dialog where
// two people compare eight words: the dialog is tested elsewhere (keo's friend test), and what is tested here is the dial. One machine, one
// network interface set, virtual authenticators: nothing here says anything about a second computer, a router that isolates its clients or a
// firewall that blocks the app (scripts/lan.js is where those are NOT covered).
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work'), PW = arg('--playwright');
const SHOTS = arg('--shots');            // a folder: pictures of the Friends window in four states, for a person to look at
if (!PKG || !WORK || !PW) { console.error('usage: scripts/lan.js --package <desktop package> --work <scratch folder> --playwright <keo repo folder>'); process.exit(2); }
const { chromium } = require(path.join(path.resolve(PW), 'node_modules', 'playwright-core'));
const exe = require('electron');
const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 600) : '')); }
const poll = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const children = [];
const shot = async (P, name) => { if (!SHOTS) return; fs.mkdirSync(path.resolve(SHOTS), { recursive: true }); await sleep(600); fs.writeFileSync(path.join(path.resolve(SHOTS), name + '.png'), await P.page.screenshot()); };

async function launch(tag) {
  const ud = path.join(path.resolve(WORK), 'ud-' + tag);
  fs.rmSync(ud, { recursive: true, force: true }); fs.mkdirSync(ud, { recursive: true });
  const port = await freePort();
  const env = Object.assign({}, process.env, { KEO_USER_DATA: ud, KEO_ERRORS_TO_STDERR: '1' }); delete env.ELECTRON_RUN_AS_NODE;
  // 'MAP * ~NOTFOUND' keeps every name but the app's own from resolving; the network under test is addresses, not names
  const child = spawn(exe, [REPO, '--package', PKG, '--remote-debugging-port=' + port, '--host-resolver-rules=MAP * ~NOTFOUND'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  children.push({ child, exited });
  console.log('  app ' + tag + ' started, pid ' + child.pid);
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); } catch (e) { await sleep(500); } }
  if (!browser) throw new Error('could not attach to app ' + tag);
  let page = null;
  for (let i = 0; i < 100 && !page; i++) { page = browser.contexts()[0].pages().find((p) => /^https:\/\/keo\.test\//.test(p.url())) || null; if (!page) await sleep(500); }
  if (!page) throw new Error('app ' + tag + ' opened no window');
  page.on('pageerror', (e) => console.log('  PAGEERROR (' + tag + ') ' + e.message.slice(0, 200)));
  const cdp = await browser.contexts()[0].newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  await poll(() => page.evaluate('!!(window.keoIdentity && window.keoLan && window.keoP2p && window.keoContacts)'), 60000);
  const made = await page.evaluate((l) => window.keoIdentity.create({ label: l }).then((r) => ({ did: r.did }), (e) => ({ err: e.name + ': ' + e.message })), tag);
  if (made.err) throw new Error('could not make an identity on ' + tag + ': ' + made.err);
  return { tag, page, browser, did: made.did, ud };
}
const ev = (P, fn, arg) => P.page.evaluate(fn, arg);
const status = (P) => ev(P, () => window.keoLan.status());
const conns = (P) => ev(P, () => window.keoP2p.list().map((c) => ({ id: c.id, state: c.state, friend: c.friend, peer: c.peer && c.peer.did })));
const dial = (P, did) => ev(P, (d) => window.keoLan.dial({ did: d }).then((r) => ({ r }), (e) => ({ err: e.message })), did);
const befriend = (P, did, name) => ev(P, ([d, n]) => window.keoContacts.add(d, n), [did, name]);
const foundHas = (P, did) => poll(async () => (await status(P)).found.some((f) => f.did === did), 40000);
const readyBoth = (A, B) => poll(async () => { const a = (await conns(A))[0], b = (await conns(B))[0]; return a && b && a.state === 'ready' && b.state === 'ready' && a.friend && b.friend ? { a, b } : null; }, 40000);
const closeAll = async (A, B) => { for (const P of [A, B]) await ev(P, () => window.keoP2p.list().forEach((c) => window.keoP2p.close({ id: c.id }))); await poll(async () => (await conns(A)).length === 0 && (await conns(B)).length === 0, 10000); };

(async () => {
  let A = null, B = null;
  try {
    fs.mkdirSync(path.resolve(WORK), { recursive: true });
    A = await launch('Alice'); B = await launch('Bob');
    check('two apps are up, each with its own identity', !!A.did && !!B.did && A.did !== B.did, { a: A.did, b: B.did });
    const sa = await status(A), sb = await status(B);
    check('both say the network is available, are signed in and visible (the default)', sa.available && sb.available && sa.signedIn && sb.signedIn && sa.visible && sb.visible, { sa, sb });
    check('with no friends yet, neither finds anyone (a tag is only recognised for a friend)', sa.found.length === 0 && sb.found.length === 0, { sa, sb });

    // ---- a friend is found, a stranger is not
    check('a dial to someone who is not a friend is refused with a sentence', /not a friend/.test((await dial(A, B.did)).err || ''), await dial(A, B.did));
    await befriend(A, B.did, 'Bob');
    check('once Alice has added Bob, Alice finds Bob on the network by his key (under his name)', !!(await foundHas(A, B.did)) && (await status(A)).found[0].name === 'Bob', await status(A));
    check('Bob, who has not added Alice, finds nobody', (await status(B)).found.length === 0, await status(B));

    // ---- a friend who has not added us does not answer
    const refused = await dial(A, B.did);
    check('Bob has not added Alice, so the dial is declined with a sentence', /did not accept/.test(refused.err || ''), refused);
    await sleep(1500);
    check('and no connection was left behind on either side', (await conns(A)).length === 0 && (await conns(B)).length === 0, { a: await conns(A), b: await conns(B) });

    // ---- the dial
    await befriend(B, A.did, 'Alice');
    const t0 = Date.now();
    const d1 = await dial(A, B.did);
    check('after Bob adds Alice, Alice dials Bob by key: no code passed by anyone', !d1.err && !!d1.r && !!d1.r.id, d1);
    const up = await readyBoth(A, B);
    console.log('  connected ' + (Date.now() - t0) + ' ms after the dial started');
    check('both ends are connected and friends, each seeing the other\'s key', !!up && up.a.peer === B.did && up.b.peer === A.did, up);
    const again = await dial(A, B.did);
    check('dialing a friend who is already connected is refused', /already connected/.test(again.err || ''), again);
    await closeAll(A, B);
    const d2 = await dial(B, A.did);
    check('and the other way round: Bob dials Alice', !d2.err, d2);
    const up2 = await readyBoth(A, B);
    check('both ends are connected again', !!up2 && up2.a.peer === B.did && up2.b.peer === A.did, up2);
    await closeAll(A, B);

    // ---- the Friends window (the kernel's screen), by real mouse clicks on the shell page
    const worldFrame = (P) => poll(async () => { const el = await P.page.$('#world'); const f = el && await el.contentFrame(); return f && (await f.evaluate('window.origin')) === 'null' && (await f.evaluate('!!(window.$world && window.keo && window.keo.init)')) ? f : null; }, 90000);
    const wfA = await worldFrame(A);
    check('Alice\'s world is up and sandboxed, so the screen below is the real one', !!wfA);
    await wfA.evaluate(() => new Promise((res) => lively.require('lively.identity.FriendsDialog').toRun(() => { lively.BuildSpec('lively.identity.FriendsDialog').createMorph().openInWorldCenter(); res(true); })));
    await wfA.evaluate(() => { const w = $world.get('IdentityFriendsDialog'); window.__fd = []; const oc = w.onLanConnect; w.onLanConnect = function (did) { window.__fd.push({ t: Date.now(), what: 'onLanConnect', stack: String(new Error().stack).split(String.fromCharCode(10)).slice(1, 7).join(' | ').slice(0, 500) }); return oc.apply(this, arguments); }; const os = w.setStatus; w.setStatus = function (m, e) { window.__fd.push({ t: Date.now(), what: 'setStatus', m: String(m).slice(0, 70), e: !!e }); return os.apply(this, arguments); }; });   // records what the window was asked to do, for the check that it dialed only once
    const uiRect = (name) => wfA.evaluate((n) => { const w = $world.get('IdentityFriendsDialog'); const m = w && w.get(n); if (!m) return null; const r = m.renderContext().shapeNode.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, name);
    const uiText = (name) => wfA.evaluate((n) => { const w = $world.get('IdentityFriendsDialog'); const m = w && w.get(n); return m ? String(typeof m.getTextString === 'function' ? m.getTextString() : m.textString) : null; }, name);
    const uiClick = async (name) => { const r = await uiRect(name); const box = await (await A.page.$('#world')).boundingBox(); await A.page.mouse.click(box.x + r.x + r.w / 2, box.y + r.y + r.h / 2); };
    const connectBtn = await poll(() => uiRect('lanConnectBtn'), 30000);
    const rowText = await uiText('friendDid');
    check('the Friends window shows Bob as on this network, with a Connect button', !!connectBtn && /on this network/.test(rowText || '') && !/not connected/.test(rowText || ''), { connectBtn, rowText });
    check('and says this webputer is visible to friends on the network', /is visible/.test((await uiText('lanVisibleText')) || ''), await uiText('lanVisibleText'));
    await shot(A, '1-friend-found');
    await uiClick('lanConnectBtn');
    const upUi = await readyBoth(A, B);
    check('a real click on Connect connects the two, with no code passed', !!upUi && upUi.a.peer === B.did && upUi.b.peer === A.did, upUi);
    const settled = await poll(async () => /connected now, friends/.test((await uiText('friendDid')) || '') && !(await uiRect('lanConnectBtn')), 20000);
    check('the row then says connected now, friends, and the Connect button is gone', !!settled, { row: await uiText('friendDid'), button: await uiRect('lanConnectBtn') });
    await shot(A, '2-connected');
    check('and the sentence that said the connection was being made is gone', (await uiText('statusText')) === '', await uiText('statusText'));
    await uiClick('lanVisibleBtn');
    check('a real click on Hide turns visibility off: the shell says so and so does the line', !!(await poll(async () => (await status(A)).visible === false && /hidden/.test((await uiText('lanVisibleText')) || ''), 15000)), { shell: (await status(A)).visible, line: await uiText('lanVisibleText') });
    await shot(A, '3-this-webputer-hidden');
    await uiClick('lanVisibleBtn');
    check('and a click on Show turns it on again', !!(await poll(async () => (await status(A)).visible === true && /is visible/.test((await uiText('lanVisibleText')) || ''), 15000)), { shell: (await status(A)).visible, line: await uiText('lanVisibleText') });
    await closeAll(A, B);

    // ---- a request that is sent twice is answered once
    await sleep(1800);       // the receiver pauses 1.5 s between requests from one address; the dial just made counts
    const raw = await ev(A, async () => {
      const call = (op, args) => window.keoLan.hostCall(op, args);
      const kd = window.keoDid, hello = window.keoHello, enc = new TextEncoder();
      const peers = (await call('peers')).peers;
      const out = { peers: peers.length };
      if (peers.length !== 1) return out;
      const target = window.keoContacts && (await window.keoContacts.list())[0].did;
      const off = await window.keoP2p.offer({ expect: target });
      const proof = await window.keoIdentity.deviceProof();
      const h = hello.dialBuild(proof, { to: target, nonce: kd.b64u(crypto.getRandomValues(new Uint8Array(16))), c: kd.b64u(await kd.sha256(enc.encode(off.code))) });
      const sig = await window.keoIdentity.signWithDevice(hello.signedBytes(h), proof.did);
      const body = kd.b64u(enc.encode(JSON.stringify({ t: 'dial', hello: h, sig, code: off.code })));
      const send = () => call('request', { ip: peers[0].ip, port: peers[0].port, body }).then((r) => r.error ? { error: r.error } : { reply: JSON.parse(new TextDecoder().decode(kd.unb64u(r.reply))).t }, (e) => ({ error: String(e) }));
      out.first = await send();
      await new Promise((r) => setTimeout(r, 2200));
      out.second = await send();
      return out;
    });
    check('a signed request is answered the first time', raw.first && raw.first.reply === 'ok', raw);
    check('and the same request again, sent after the other side\'s pause, is declined: a nonce is used once', raw.second && (raw.second.reply === 'no' || !!raw.second.error), raw);
    await closeAll(A, B);

    // ---- junk that arrives at the page
    const junk = await ev(B, async () => ({ a: await window.keoLan.inbound('garbage', '10.0.0.9'), b: await window.keoLan.inbound('x'.repeat(70000), '10.0.0.10'), c: await window.keoLan.inbound(btoa('{"t":"dial"}').replace(/=/g, ''), '10.0.0.11') }));
    check('junk handed to the page gets no answer, or a plain refusal that tells nothing', junk.a === null && junk.b === null && (junk.c === null || typeof junk.c === 'string'), junk);
    check('and opens no connection', (await conns(B)).length === 0, await conns(B));

    // ---- the page of the world cannot use the network pipe, and neither can a request without the header
    const shellNoHeader = await ev(A, () => fetch('/.keo-host/lan', { method: 'POST', body: '{"op":"hello"}' }).then((r) => r.status));
    const shellWrong = await ev(A, () => fetch('/.keo-host/lan', { method: 'POST', headers: { 'x-keo-host': 'lan1' }, body: '{"op":"hello"}' }).then((r) => r.status));
    const shellGet = await ev(A, () => fetch('/.keo-host/lan').then((r) => r.status));
    check('a request to the pipe with no secret or a wrong one is refused (403), and a GET is not allowed (405)', shellNoHeader === 403 && shellWrong === 403 && shellGet === 405, { shellNoHeader, shellWrong, shellGet });
    check('the shell page keeps the secret out of reach: it is no longer on window once read', (await ev(B, () => typeof window.__keoHostToken)) === 'undefined');
    // the sandboxed world: a frame taken from its element (the page lists it as about:blank), which must really be the sandboxed one (an opaque origin)
    const wf = await poll(async () => { const el = await B.page.$('#world'); const f = el && await el.contentFrame(); return f && (await f.evaluate('window.origin')) === 'null' && (await f.evaluate('!!(window.$world && window.keo && window.keo.init)')) ? f : null; }, 90000);
    check('the world frame is up and is sandboxed (an opaque origin), so the checks below are about the right frame', !!wf);
    const fromWorld = wf ? await wf.evaluate(async () => {
      const out = {};
      for (const name of ['guess', 'empty']) {
        const headers = name === 'empty' ? {} : { 'x-keo-host': 'lan1' };
        try { const r = await fetch('https://keo.test/.keo-host/lan', { method: 'POST', mode: 'no-cors', headers: Object.assign({ 'content-type': 'text/plain' }, name === 'empty' ? {} : {}), body: '{"op":"start","payload":"evilworld"}' }); out[name + 'NoCors'] = 'sent (' + r.type + ')'; } catch (e) { out[name + 'NoCors'] = 'blocked (' + e.name + ')'; }
        try { const r = await fetch('https://keo.test/.keo-host/lan', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: '{"op":"start","payload":"evilworld"}' }); out[name + 'Cors'] = 'status ' + r.status; } catch (e) { out[name + 'Cors'] = 'blocked (' + e.name + ')'; }
      }
      try { out.parent = String(window.parent.__keoHostToken); } catch (e) { out.parent = 'blocked (' + e.name + ')'; }
      return out;
    }) : { error: 'no world frame' };
    await sleep(6000);
    const evil = await ev(A, () => window.keoLan.hostCall('peers').then((j) => j.peers.filter((p) => p.payload === 'evilworld').length));
    console.log('  from the world: ' + JSON.stringify(fromWorld));
    check('the world cannot read the secret from the shell page (the frames are in different origins)', !!wf && /blocked/.test(fromWorld.parent || ''), fromWorld);
    check('and what the world sends to the pipe changed nothing: no announcement carries its payload', !!wf && evil === 0, { fromWorld, evil });

    // ---- not visible: the device stops announcing and is not found
    const off = await ev(B, () => window.keoLan.setVisible({ on: false }));
    check('Bob turns visibility off', off.visible === false && (await status(B)).visible === false, off);
    check('Alice stops finding Bob (his announcement runs out)', !!(await poll(async () => !(await status(A)).found.some((f) => f.did === B.did), 50000)), await status(A));
    const nf = await dial(A, B.did);
    check('and a dial to Bob says he was not found on this network', /not found on this network/.test(nf.err || ''), nf);
    check('the Friends window then says none of the friends was found, with no Connect button', !!(await poll(async () => /None of your friends was found/.test((await uiText('lanHint')) || '') && !(await uiRect('lanConnectBtn')), 20000)), { hint: await uiText('lanHint'), button: await uiRect('lanConnectBtn') });
    await shot(A, '4-friend-hidden-hint');
    const fd = await wfA.evaluate(() => window.__fd);
    check('the Friends window dialed exactly once, for the one real click, and never showed an error', fd.filter((x) => x.what === 'onLanConnect').length === 1 && !fd.some((x) => x.what === 'setStatus' && x.e), fd);
    await ev(B, () => window.keoLan.setVisible({ on: true }));
    check('Bob turns it on again and Alice finds him', !!(await foundHas(A, B.did)), await status(A));
    check('and the Friends window offers Connect again, with the hint gone', !!(await poll(async () => !!(await uiRect('lanConnectBtn')) && !(await uiRect('lanHint')), 20000)), { button: await uiRect('lanConnectBtn'), hint: await uiRect('lanHint') });
    check('the setting is kept with the identity (a setting the world may read)', (await ev(B, () => window.keoWorlds.prefsGet())).lanVisible === true);

    // ---- signing out stops announcing
    await ev(B, () => window.keoIdentity.signOut());
    check('after Bob signs out, Alice stops finding him', !!(await poll(async () => !(await status(A)).found.some((f) => f.did === B.did), 50000)), await status(A));
  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  } finally {
    for (const P of [A, B]) { try { if (P && P.browser) await P.browser.close(); } catch (e) {} }
    for (const c of children) { try { c.child.kill(); } catch (e) {} }          // only the processes started here
    await Promise.all(children.map((c) => Promise.race([c.exited, sleep(8000)])));
  }
  console.log(passed + ' passed, ' + failed + ' failed   (two apps, one machine, the real local network, virtual authenticators)');
  process.exit(failed ? 1 : 0);
})();
