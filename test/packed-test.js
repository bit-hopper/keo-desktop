// The packed app, as a person gets it: scripts/pack.js makes the folder, then keo's own executable in it is started with no arguments.
//   node test/packed-test.js <built desktop package> <scratch folder>
// Checks that the app finds the package that came inside it, that a release signed by the key it was packed with is served after it is
// applied and a release signed by another key is not, that going back works, and that the verifier read from inside the app's archive
// is the one packed with it. The key is made for the run. The executable is stopped by the process id it was started with, and nothing else.
// What this does not show: how the system treats an unsigned executable on first run, and the menu itself (native, not driven here).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const DESK = path.resolve(__dirname, '..');
const [PKG, WORK] = process.argv.slice(2).map((a) => a && path.resolve(a));
if (!PKG || !WORK) { console.error('usage: node test/packed-test.js <built desktop package> <scratch folder>'); process.exit(2); }
const upd = require('../lib/update.js');
const subtle = crypto.webcrypto.subtle;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 500) : '')); }
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const env = (extra) => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return Object.assign(e, extra || {}); };
const targets = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { return null; } };
const waitFor = async (fn, ms) => { for (let t = 0; t < ms; t += 400) { const v = await fn(); if (v) return v; await sleep(400); } return null; };

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
  const kd = require(path.join(PKG, 'keo-did.js')), kr = require(path.join(PKG, 'keo-release.js'));
  async function makeKey() { const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']); const pub = kd.b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))); return { pair, pub, kid: await kr.keyId(pub) }; }
  const key = await makeKey(), other = await makeKey();
  const keyFile = path.join(WORK, 'update-key.json');
  fs.writeFileSync(keyFile, JSON.stringify({ keys: [{ kid: key.kid, alg: 'Ed25519', publicKey: key.pub }] }));

  // ---- pack it
  const out = path.join(WORK, 'out');
  const p = spawnSync(process.execPath, [path.join(DESK, 'scripts', 'pack.js'), '--package', PKG, '--out', out, '--update-key', keyFile, '--bundled-version', '3'], { encoding: 'utf8' });
  check('packing succeeds', p.status === 0, { status: p.status, out: (p.stdout || '').slice(-300), err: (p.stderr || '').slice(-300) });
  const app = path.join(out, 'app', 'keo-' + process.platform + '-' + process.arch);
  const exe = path.join(app, process.platform === 'win32' ? 'keo.exe' : 'keo'), res = path.join(app, 'resources');
  check('the executable and the package that came with it are there', fs.existsSync(exe) && fs.existsSync(path.join(res, 'keo-package', 'start.html')) && fs.existsSync(path.join(res, 'app.asar')));
  check('the package inside is the one given, file for file', JSON.stringify(upd.listFiles(path.join(res, 'keo-package')).sort()) === JSON.stringify(upd.listFiles(PKG).sort()));
  check('what is shipped is the host and nothing of the tests or notes', !fs.existsSync(path.join(res, 'app')) && !fs.existsSync(path.join(res, 'keo-package', 'node_modules')));
  check('the scratch folder of the packer is gone', !fs.existsSync(path.join(out, '.stage')));
  check('it counts as release 3', JSON.parse(fs.readFileSync(path.join(res, 'bundled.json'), 'utf8')).version === 3);

  // ---- the verifier inside the archive is read and holds the packed key (the executable run as plain node reads the archive too)
  const probe = "const u=require(process.argv[1]+'/lib/update.js');u.loadVerifier(process.argv[1]+'/verify').then(v=>{console.log(JSON.stringify(v.keys.map(k=>k.kid)))},e=>{console.log('ERR '+e.message)})";
  const q = spawnSync(exe, ['-e', probe, path.join(res, 'app.asar')], { env: env({ ELECTRON_RUN_AS_NODE: '1' }), encoding: 'utf8', timeout: 60000 });
  check('the verifier read from inside the archive holds the key it was packed with', (q.stdout || '').trim() === JSON.stringify([key.kid]), { out: q.stdout, err: q.stderr });
  const verifyDir = path.join(WORK, 'v'); fs.mkdirSync(verifyDir);
  for (const f of ['keo-release.js', 'keo-did.js']) fs.copyFileSync(path.join(PKG, f), path.join(verifyDir, f));
  fs.copyFileSync(keyFile, path.join(verifyDir, 'update-key.json'));
  const vf = await upd.loadVerifier(verifyDir);

  // ---- run it
  const ud = path.join(WORK, 'userdata'); fs.mkdirSync(ud);
  async function run(extraArgs) {
    const port = await freePort();
    const child = spawn(exe, ['--remote-debugging-port=' + port].concat(extraArgs || []), { env: env({ KEO_USER_DATA: ud, KEO_ERRORS_TO_STDERR: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    const r = { child, err: '', exit: new Promise((res2) => child.on('exit', (c) => res2(c))) };
    child.stderr.on('data', (d) => { r.err += String(d); });
    r.page = await waitFor(async () => { const t = await targets(port); return t && t.find((x) => x.type === 'page' && /^https:\/\/keo\.test\//.test(x.url) && x.title); }, 90000);
    return r;
  }
  const stop = async (r) => { r.child.kill(); await r.exit; };
  let r = await run();
  check('started with no arguments, the packed app serves the package inside it', !!r.page && r.page.title === 'keo', { page: r.page, err: r.err.slice(0, 300) });
  await stop(r);

  // ---- releases: the bundled one counts as 3
  const startHtml = fs.readFileSync(path.join(PKG, 'start.html'), 'utf8');
  async function release(dirName, version, title, k) {
    const dir = path.join(WORK, dirName), pkg = path.join(dir, 'package');
    fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(PKG, pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'start.html'), startHtml.replace('<title>keo</title>', '<title>' + title + '</title>'));
    const files = {}; for (const f of upd.listFiles(pkg).sort()) { const d = fs.readFileSync(path.join(pkg, f)); files[f] = { sha256: crypto.createHash('sha256').update(d).digest('hex'), size: d.length }; }
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, type: 'keo-release', version, name: title, issuedAt: new Date().toISOString(), kernel: { commit: null }, files }));
    const signed = new Uint8Array(kr.DOMAIN.length + payload.length); signed.set(new TextEncoder().encode(kr.DOMAIN)); signed.set(payload, kr.DOMAIN.length);
    const sig = new Uint8Array(await subtle.sign('Ed25519', k.pair.privateKey, signed));
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ v: 1, kid: k.kid, payload: kd.b64u(payload), sig: kd.b64u(sig) }) + '\n');
    return dir;
  }
  const old = await release('rel-old', 3, 'keo old', key);
  const why = await upd.readRelease(old, vf, 3).then(() => null, (e) => e.message);
  check('a release numbered like the one that came with the app is refused', /Only a newer release/.test(why || ''), why);
  const forged = await release('rel-forged', 4, 'keo forged', other);
  const why2 = await upd.readRelease(forged, vf, 3).then(() => null, (e) => e.message);
  check('a release signed by another key is refused', /not signed by the key this app trusts/.test(why2 || ''), why2);
  const good = await release('rel-good', 4, 'keo release-four', key);
  await upd.stageRelease(ud, await upd.readRelease(good, vf, 3), vf);
  r = await run();
  check('after a release is applied the packed app serves it', !!r.page && r.page.title === 'keo release-four', { page: r.page, err: r.err.slice(0, 300) });
  await stop(r);
  upd.rollBack(ud);
  r = await run();
  check('after going back it serves the package inside it again', !!r.page && r.page.title === 'keo', { page: r.page, err: r.err.slice(0, 300) });
  await stop(r);

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
