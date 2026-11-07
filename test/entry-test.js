// The app started the way a person starts it: the package's own entry (app.js), a built desktop package, a window of its own.
//   node test/entry-test.js <desktop package> <scratch folder>
// scripts/smoke.js and scripts/real.js call start() themselves, so they cannot tell whether the entry runs at all (it once did not:
// see app.js). This one asks the app's debugging port which windows exist, so it needs no automation library, and it stops only the
// processes it started, by the PIDs it was given.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const DESK = path.resolve(__dirname, '..');
const exe = require(path.join(DESK, 'node_modules', 'electron'));
const [PKG, WORK] = process.argv.slice(2).map((a) => a && path.resolve(a));
if (!PKG || !WORK) { console.error('usage: node test/entry-test.js <desktop package> <scratch folder>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 500) : '')); }

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const env = () => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return e; };
// starts the app on the folder; resolves { child, out, err, exit } where exit is a promise of the exit code
function launch(args, extraEnv) {
  const child = spawn(exe, [DESK].concat(args), { env: Object.assign(env(), extraEnv || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { child, err: '', exit: new Promise((res) => child.on('exit', (c) => res(c))) };
  child.stderr.on('data', (d) => { r.err += String(d); });
  return r;
}
const targets = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { return null; } };
const waitFor = async (fn, ms) => { for (let t = 0; t < ms; t += 400) { const v = await fn(); if (v) return v; await sleep(400); } return null; };

(async () => {
  const ud = path.join(WORK, 'userdata-entry');
  fs.rmSync(ud, { recursive: true, force: true }); fs.mkdirSync(ud, { recursive: true });
  const port = await freePort();
  const first = launch(['--package', PKG, '--remote-debugging-port=' + port], { KEO_USER_DATA: ud });
  try {
    const page = await waitFor(async () => { const t = await targets(port); return t && t.find((x) => x.type === 'page' && /^https:\/\/keo\.test\//.test(x.url)); }, 60000);
    check('the entry opens a window on https://keo.test', !!page, { stderr: first.err.slice(0, 300) });

    // a second start on the same profile hands over to the first and ends
    const second = launch(['--package', PKG, '--remote-debugging-port=' + (await freePort())], { KEO_USER_DATA: ud });
    const code = await Promise.race([second.exit, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') second.child.kill();
    check('a second start on the same profile ends without opening another window', code === 0, code);
    const after = await targets(port);
    check('and the first window is still the only one', !!after && after.filter((x) => x.type === 'page').length === 1, after && after.map((x) => x.url));
  } finally { first.child.kill(); await first.exit; }

  // a folder that is not a desktop package: the reason is given and the app ends with a failure
  const bad = path.join(WORK, 'not-a-package'); fs.mkdirSync(bad, { recursive: true });
  const ud2 = path.join(WORK, 'userdata-entry-bad'); fs.rmSync(ud2, { recursive: true, force: true }); fs.mkdirSync(ud2, { recursive: true });
  const b = launch(['--package', bad], { KEO_USER_DATA: ud2, KEO_ERRORS_TO_STDERR: '1' });
  const bcode = await Promise.race([b.exit, sleep(30000).then(() => 'timeout')]);
  if (bcode === 'timeout') b.child.kill();
  check('a folder that is not a desktop package is refused with a reason and a failing exit', bcode === 1 && /not a desktop package of keo/.test(b.err), { bcode, err: b.err.slice(0, 300) });
  const n = launch([], { KEO_USER_DATA: ud2, KEO_ERRORS_TO_STDERR: '1' });
  const ncode = await Promise.race([n.exit, sleep(30000).then(() => 'timeout')]);
  if (ncode === 'timeout') n.child.kill();
  check('no package given: refused with a reason', ncode === 1 && /No package given/.test(n.err), { ncode, err: n.err.slice(0, 300) });

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
