// Which package the app runs, seen from the outside: the app is started by its own entry (app.js) the way a person starts it, and the
// window it opens says which package it is serving.
//   node test/update-entry-test.js <built desktop package> <scratch folder>
// The package that "came with the app" is the built package itself (KEO_BUNDLED_PACKAGE). A release is a copy of it whose start.html has
// another page title, signed with a key made for the run, and staged by the same code the menu uses (lib/update.js). The app is stopped
// by the process id it was given at launch, and nothing else.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const DESK = path.resolve(__dirname, '..');
const exe = require(path.join(DESK, 'node_modules', 'electron'));
const [PKG, WORK] = process.argv.slice(2).map((a) => a && path.resolve(a));
if (!PKG || !WORK) { console.error('usage: node test/update-entry-test.js <built desktop package> <scratch folder>'); process.exit(2); }
const upd = require('../lib/update.js');
const subtle = crypto.webcrypto.subtle;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 500) : '')); }

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const env = (extra) => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return Object.assign(e, extra || {}); };
const targets = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { return null; } };
const waitFor = async (fn, ms) => { for (let t = 0; t < ms; t += 400) { const v = await fn(); if (v) return v; await sleep(400); } return null; };

// starts the app by its entry; resolves { child, port, err, exit, page() } where page() waits for the window on keo.test to have a title
async function launch(ud, verifyDir, bundled, extraArgs) {
  const port = await freePort();
  const child = spawn(exe, [DESK, '--remote-debugging-port=' + port].concat(extraArgs || []), {
    env: env({ KEO_USER_DATA: ud, KEO_BUNDLED_PACKAGE: bundled, KEO_VERIFIER_DIR: verifyDir, KEO_ERRORS_TO_STDERR: '1' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  const r = { child, port, err: '', exit: new Promise((res) => child.on('exit', (c) => res(c))) };
  child.stderr.on('data', (d) => { r.err += String(d); });
  r.page = async () => waitFor(async () => { const t = await targets(port); return t && t.find((x) => x.type === 'page' && /^https:\/\/keo\.test\//.test(x.url) && x.title); }, 60000);
  return r;
}
async function stop(r) { r.child.kill(); await r.exit; }

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  const verifyDir = path.join(WORK, 'verify'); fs.mkdirSync(verifyDir);
  for (const f of ['keo-release.js', 'keo-did.js']) fs.copyFileSync(path.join(PKG, f), path.join(verifyDir, f));
  const kd = require(path.join(verifyDir, 'keo-did.js')), kr = require(path.join(verifyDir, 'keo-release.js'));
  const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = kd.b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), kid = await kr.keyId(pub);
  fs.writeFileSync(path.join(verifyDir, 'update-key.json'), JSON.stringify({ keys: [{ kid, alg: 'Ed25519', publicKey: pub }] }));
  const verifier = await upd.loadVerifier(verifyDir);

  // a release: the built package with another page title, signed
  const startHtml = fs.readFileSync(path.join(PKG, 'start.html'), 'utf8');
  check('the built package has the page title the test changes', /<title>keo<\/title>/.test(startHtml));
  async function release(dirName, version, title) {
    const dir = path.join(WORK, dirName), pkg = path.join(dir, 'package');
    fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(PKG, pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'start.html'), startHtml.replace('<title>keo</title>', '<title>' + title + '</title>'));
    const manifest = { v: 1, type: 'keo-release', version, name: title, issuedAt: new Date().toISOString(), kernel: { commit: null }, files: upd.listFiles(pkg).sort().reduce((o, p) => { const d = fs.readFileSync(path.join(pkg, p)); o[p] = { sha256: crypto.createHash('sha256').update(d).digest('hex'), size: d.length }; return o; }, {}) };
    const payload = new TextEncoder().encode(JSON.stringify(manifest));
    const signed = new Uint8Array(kr.DOMAIN.length + payload.length); signed.set(new TextEncoder().encode(kr.DOMAIN)); signed.set(payload, kr.DOMAIN.length);
    const sig = new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, signed));
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ v: 1, kid, payload: kd.b64u(payload), sig: kd.b64u(sig) }) + '\n');
    return dir;
  }
  const ud = path.join(WORK, 'userdata'); fs.mkdirSync(ud);

  // 1. nothing applied: the package that came with the app
  let a = await launch(ud, verifyDir, PKG);
  let page = await a.page();
  check('with nothing applied the window serves the package that came with the app', !!page && page.title === 'keo', { page, err: a.err.slice(0, 300) });
  await stop(a);

  // 2. a release applied (by the code the menu uses): the next start serves it
  const r1 = await release('rel1', 1, 'keo release-one');
  await upd.stageRelease(ud, await upd.readRelease(r1, verifier, 0), verifier);
  a = await launch(ud, verifyDir, PKG);
  page = await a.page();
  check('after a release is applied the next start serves the release', !!page && page.title === 'keo release-one', { page, err: a.err.slice(0, 300) });
  await stop(a);

  // 3. a newer release, then going back to the one before
  const r2 = await release('rel2', 2, 'keo release-two');
  await upd.stageRelease(ud, await upd.readRelease(r2, verifier, 1), verifier);
  a = await launch(ud, verifyDir, PKG); page = await a.page();
  check('a newer release replaces it', !!page && page.title === 'keo release-two', page); await stop(a);
  upd.rollBack(ud);
  a = await launch(ud, verifyDir, PKG); page = await a.page();
  check('going back serves the release before', !!page && page.title === 'keo release-one', page); await stop(a);

  // 4. a package named on the command line wins, and nothing is staged or changed by it
  const before = JSON.stringify(upd.readState(ud));
  a = await launch(ud, verifyDir, PKG, ['--package', PKG]); page = await a.page();
  check('a package named on the command line is served instead of the release', !!page && page.title === 'keo', page); await stop(a);
  check('and the staged state is untouched', JSON.stringify(upd.readState(ud)) === before);

  // 5. the active release is damaged: the app starts on the package that came with it and says so
  const active = upd.readState(ud).active;
  fs.rmSync(path.join(ud, 'releases', active.dir, 'start.html'));
  a = await launch(ud, verifyDir, PKG); page = await a.page();
  check('a damaged release is not served: the app starts on the package that came with it', !!page && page.title === 'keo', { page, err: a.err.slice(0, 300) });
  await sleep(1500);
  check('and it says why', /release 1 \(keo release-one\) is missing or damaged/.test(a.err), a.err.slice(0, 400));
  await stop(a);
  check('and the state stops naming the damaged release', upd.readState(ud).active === null);

  // 6. nothing to run: still the plain refusal
  const empty = path.join(WORK, 'userdata-empty'); fs.mkdirSync(empty);
  const n = spawn(exe, [DESK], { env: env({ KEO_USER_DATA: empty, KEO_ERRORS_TO_STDERR: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let nerr = ''; n.stderr.on('data', (d) => { nerr += String(d); });
  const ncode = await Promise.race([new Promise((res) => n.on('exit', res)), sleep(30000).then(() => 'timeout')]);
  if (ncode === 'timeout') n.kill();
  check('with no package anywhere the app refuses with a reason', ncode === 1 && /No package given/.test(nerr), { ncode, nerr: nerr.slice(0, 300) });

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
