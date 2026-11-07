// The rules for applying a release and choosing the package to run, in plain node (no desktop runtime, no window, no network):
//   node test/update-test.js <built desktop package> <scratch folder>
// The built package is used only for the verifier code it carries (keo-release.js, keo-did.js): the app ships a copy of those next to
// its pinned key. Everything signed here is signed with a key made for the run, never a real one, and the packages are small made-up
// folders, so what is checked is the host's rules and not the size of a real package.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [PKG, WORK] = process.argv.slice(2).map((a) => a && path.resolve(a));
if (!PKG || !WORK) { console.error('usage: node test/update-test.js <built desktop package> <scratch folder>'); process.exit(2); }
const upd = require('../lib/update.js');
const subtle = crypto.webcrypto.subtle;
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 400) : '')); }
const refuses = async (fn) => { try { await fn(); return null; } catch (e) { return String(e && e.message || e); } };

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const put = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

// ---- keys, a verifier folder like the one the app carries, and releases
let kd, kr;
async function makeKey() {
  const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = kd.b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  return { pair, pub, kid: await kr.keyId(pub) };
}
const DESKTOP_JSON = (over) => JSON.stringify(Object.assign({
  v: 1, origin: 'https://keo.test', host: 'keo.test', version: 'v-test',
  csp: { shell: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'", world: 'sandbox allow-scripts; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\';' },
  sandboxedPages: ['world.html'], catalogHosts: []
}, over || {}));
// a made-up package whose files say which release it is
function makePackage(root, tag, over) {
  rm(root);
  put(root, 'start.html', '<!doctype html><title>keo ' + tag + '</title>');
  put(root, 'world.html', '<!doctype html>');
  put(root, 'desktop.json', DESKTOP_JSON(over));
  put(root, 'marker.txt', tag);
  put(root, 'core/lively/a.js', 'var a = "' + tag + '";');
  put(root, 'core/media/b.bin', Buffer.from([0, 1, 2, 3, 250, 251]));
  // written by the builder and not part of what a release lists
  put(root, '.keo-world-build', 'x');
  put(root, 'keo-files.json', '{"v":1,"files":{"lie.js":{"sha256":"00","size":0}}}');
}
function listOf(root) {
  const out = {};
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && r !== '.keo-world-build' && r !== 'keo-files.json') { const d = fs.readFileSync(path.join(root, r)); out[r] = { sha256: crypto.createHash('sha256').update(d).digest('hex'), size: d.length }; }
    }
  })('');
  return out;
}
// signs a manifest over `files` (default: what the package folder holds) with `key`; makes <relDir>/release.json and <relDir>/package
async function makeRelease(relDir, tag, version, key, opts) {
  opts = opts || {};
  rm(relDir); fs.mkdirSync(relDir, { recursive: true });
  const pkg = path.join(relDir, 'package');
  makePackage(pkg, tag, opts.desktopOver);
  const manifest = { v: 1, type: 'keo-release', version, name: opts.name || ('rel-' + tag), issuedAt: new Date().toISOString(), kernel: { commit: null }, files: listOf(pkg) };
  if (opts.edit) opts.edit(manifest, pkg);
  const payload = new TextEncoder().encode(JSON.stringify(manifest));
  const signed = new Uint8Array(kr.DOMAIN.length + payload.length);
  signed.set(new TextEncoder().encode(kr.DOMAIN)); signed.set(payload, kr.DOMAIN.length);
  const sig = new Uint8Array(await subtle.sign('Ed25519', key.pair.privateKey, signed));
  const env = { v: 1, kid: key.kid, payload: kd.b64u(payload), sig: kd.b64u(sig) };
  put(relDir, 'release.json', JSON.stringify(env) + '\n');
  return { dir: relDir, pkg, manifest, env };
}

(async () => {
  rm(WORK); fs.mkdirSync(WORK, { recursive: true });
  const verifyDir = path.join(WORK, 'verify'); fs.mkdirSync(verifyDir);
  for (const f of ['keo-release.js', 'keo-did.js']) fs.copyFileSync(path.join(PKG, f), path.join(verifyDir, f));
  kd = require(path.join(verifyDir, 'keo-did.js')); kr = require(path.join(verifyDir, 'keo-release.js'));
  const key = await makeKey(), other = await makeKey();

  // ---- the verifier
  const noKey = await refuses(() => upd.loadVerifier(verifyDir));
  check('a host built without a pinned key takes no updates', /without an update key/.test(noKey || ''), noKey);
  fs.writeFileSync(path.join(verifyDir, 'update-key.json'), JSON.stringify({ keys: [{ kid: key.kid, alg: 'Ed25519', publicKey: key.pub }] }));
  const verifier = await upd.loadVerifier(verifyDir);
  check('the pinned key loads', verifier.keys.length === 1 && verifier.keys[0].kid === key.kid);

  const ud = path.join(WORK, 'userdata'); fs.mkdirSync(ud);
  const bundled = path.join(WORK, 'bundled'); makePackage(bundled, 'bundled');
  const state0 = upd.resolvePackage(ud, bundled, 0);
  check('with nothing applied the package that came with the app runs', state0.source === 'bundled' && state0.dir === bundled && state0.version === 0 && state0.fellBack.length === 0, state0);
  check('and with no bundled package and nothing applied there is no package', upd.resolvePackage(ud, null, 0).source === null);

  // ---- reading a release
  const r1 = await makeRelease(path.join(WORK, 'rel1'), 'one', 1, key);
  check('the manifest does not list the builder files', !r1.manifest.files['keo-files.json'] && !r1.manifest.files['.keo-world-build'] && !!r1.manifest.files['marker.txt']);
  const read1 = await upd.readRelease(r1.dir, verifier, 0);
  check('a release signed by the pinned key is read', read1.manifest.version === 1 && read1.manifest.name === 'rel-one', read1.manifest);

  const forged = await makeRelease(path.join(WORK, 'rel-forged'), 'forged', 5, other);
  check('a release signed by another key is refused', /not signed by the key this app trusts/.test(await refuses(() => upd.readRelease(forged.dir, verifier, 0)) || ''));
  const tamperedEnv = JSON.parse(fs.readFileSync(path.join(r1.dir, 'release.json'), 'utf8'));
  const payload = JSON.parse(Buffer.from(tamperedEnv.payload, 'base64url').toString('utf8')); payload.version = 9;
  tamperedEnv.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tdir = path.join(WORK, 'rel-tampered'); rm(tdir); fs.cpSync(r1.dir, tdir, { recursive: true }); fs.writeFileSync(path.join(tdir, 'release.json'), JSON.stringify(tamperedEnv));
  check('a release whose signed text was changed is refused', /not signed by the key this app trusts/.test(await refuses(() => upd.readRelease(tdir, verifier, 0)) || ''));
  check('a release that is not newer than the running one is refused', /Only a newer release/.test(await refuses(() => upd.readRelease(r1.dir, verifier, 1)) || ''));
  check('and neither is an older one', /Only a newer release/.test(await refuses(() => upd.readRelease(r1.dir, verifier, 4)) || ''));
  const noEnv = path.join(WORK, 'rel-noenv'); rm(noEnv); fs.mkdirSync(path.join(noEnv, 'package'), { recursive: true });
  check('a folder without release.json is refused with a reason', /no release\.json/.test(await refuses(() => upd.readRelease(noEnv, verifier, 0)) || ''));
  const noPkg = path.join(WORK, 'rel-nopkg'); rm(noPkg); fs.mkdirSync(noPkg); fs.copyFileSync(path.join(r1.dir, 'release.json'), path.join(noPkg, 'release.json'));
  check('a folder without package/ is refused with a reason', /no package folder/.test(await refuses(() => upd.readRelease(noPkg, verifier, 0)) || ''));
  const rGarbage = path.join(WORK, 'rel-garbage'); rm(rGarbage); fs.mkdirSync(path.join(rGarbage, 'package'), { recursive: true }); fs.writeFileSync(path.join(rGarbage, 'release.json'), 'not json');
  check('a release.json that is not JSON is refused', /not valid/.test(await refuses(() => upd.readRelease(rGarbage, verifier, 0)) || ''));
  const noStart = await makeRelease(path.join(WORK, 'rel-nostart'), 'nostart', 2, key, { edit: (m) => { delete m.files['start.html']; } });
  check('a release that does not list start.html is refused', /does not list start\.html/.test(await refuses(() => upd.readRelease(noStart.dir, verifier, 0)) || ''));

  // ---- staging refusals leave nothing behind
  const releasesOf = () => { try { return fs.readdirSync(path.join(ud, 'releases')); } catch (e) { return []; } };
  const bad = [];
  const edited = await makeRelease(path.join(WORK, 'rel-edited'), 'edited', 2, key);
  fs.writeFileSync(path.join(edited.pkg, 'core/lively/a.js'), 'var a = "changed after signing";');
  bad.push(['a file changed after signing', edited, /does not match the signed list: core\/lively\/a\.js/]);
  const extra = await makeRelease(path.join(WORK, 'rel-extra'), 'extra', 2, key);
  put(extra.pkg, 'core/sneaky.js', 'evil()');
  bad.push(['a file the release does not list', extra, /does not list, such as core\/sneaky\.js/]);
  const missing = await makeRelease(path.join(WORK, 'rel-missing'), 'missing', 2, key);
  fs.rmSync(path.join(missing.pkg, 'marker.txt'));
  bad.push(['a file the release lists but the folder lacks', missing, /missing 1 file\(s\)/]);
  const sameSize = await makeRelease(path.join(WORK, 'rel-samesize'), 'samesize', 2, key);
  fs.writeFileSync(path.join(sameSize.pkg, 'marker.txt'), 'samesize'.replace('s', 'Z'));   // same length, other bytes
  bad.push(['a file with the right size and other bytes', sameSize, /does not match the signed list: marker\.txt/]);
  const weak = await makeRelease(path.join(WORK, 'rel-weak'), 'weak', 2, key, { desktopOver: { csp: { shell: "script-src 'self' 'unsafe-eval'; object-src 'self'", world: 'sandbox' } } });
  bad.push(['a package whose shell policy allows eval', weak, /not a package this app can run/]);
  const foreign = await makeRelease(path.join(WORK, 'rel-foreign'), 'foreign', 2, key, { desktopOver: { origin: 'https://elsewhere.test', host: 'elsewhere.test' } });
  bad.push(['a package made for another address', foreign, /not a package this app can run/]);
  for (const [name, rel, re] of bad) {
    const rd = await upd.readRelease(rel.dir, verifier, 0);
    const why = await refuses(() => upd.stageRelease(ud, rd, verifier));
    check('refused: ' + name, re.test(why || ''), why);
    check('  and nothing was left behind, the state is unchanged', releasesOf().filter((n) => n !== 'active.json').length === 0 && upd.readState(ud).active === null, releasesOf());
  }
  // a link inside the package folder (needs the right to make one; skipped where the system does not allow it)
  const linked = await makeRelease(path.join(WORK, 'rel-link'), 'link', 2, key);
  let linkMade = false;
  try { fs.symlinkSync(path.join(WORK, 'bundled', 'marker.txt'), path.join(linked.pkg, 'core', 'link.js')); linkMade = true; } catch (e) { /* no right to make a link here */ }
  if (linkMade) {
    const why = await refuses(async () => upd.stageRelease(ud, await upd.readRelease(linked.dir, verifier, 0), verifier));
    check('a link inside the package folder is refused', /not a plain file or folder/.test(why || ''), why);
  } else console.log('SKIP a link inside the package folder (this account cannot make links here)');

  // ---- a good release is staged, and chosen from then on
  const e1 = await upd.stageRelease(ud, read1, verifier);
  check('a good release is staged', e1.version === 1 && /^r1-[0-9a-f]{6}$/.test(e1.dir), e1);
  const stagedDir = path.join(ud, 'releases', e1.dir);
  const staged = listOf(stagedDir);
  check('every listed file is there with the signed hash', JSON.stringify(staged) === JSON.stringify(r1.manifest.files));
  check('keo-files.json is rewritten from the signed list, not copied', JSON.stringify(JSON.parse(fs.readFileSync(path.join(stagedDir, 'keo-files.json'), 'utf8'))) === JSON.stringify({ v: 1, files: r1.manifest.files }));
  check('the builder marker is not carried over', !fs.existsSync(path.join(stagedDir, '.keo-world-build')));
  check('nothing half-finished is left', releasesOf().every((n) => n === 'active.json' || upd.DIR_NAME.test(n)), releasesOf());
  const c1 = upd.resolvePackage(ud, bundled, 0);
  check('the staged release is the one that runs next', c1.source === 'release' && c1.version === 1 && c1.dir === stagedDir && c1.fellBack.length === 0, c1);
  check('the same release is not newer than itself', /Only a newer release/.test(await refuses(() => upd.readRelease(r1.dir, verifier, c1.version)) || ''));

  // ---- a second and a third release: two staged packages are kept
  const r2 = await makeRelease(path.join(WORK, 'rel2'), 'two', 2, key);
  const e2 = await upd.stageRelease(ud, await upd.readRelease(r2.dir, verifier, c1.version), verifier);
  let st = upd.readState(ud);
  check('the second release is active and the first is kept as the one before', st.active.dir === e2.dir && st.previous && st.previous.dir === e1.dir, st);
  const r3 = await makeRelease(path.join(WORK, 'rel3'), 'three', 3, key);
  const e3 = await upd.stageRelease(ud, await upd.readRelease(r3.dir, verifier, 2), verifier);
  st = upd.readState(ud);
  check('the third replaces the first: only two staged packages are kept', st.active.dir === e3.dir && st.previous.dir === e2.dir && releasesOf().filter((n) => upd.DIR_NAME.test(n)).length === 2 && !fs.existsSync(stagedDir), { st, left: releasesOf() });

  // ---- going back
  const back = upd.rollBack(ud);
  check('going back makes the one before the active one', back.from.version === 3 && back.to.version === 2 && upd.resolvePackage(ud, bundled, 0).version === 2);
  check('the release that was left is removed', releasesOf().filter((n) => upd.DIR_NAME.test(n)).length === 1);
  const back2 = upd.rollBack(ud);
  check('going back again lands on the package that came with the app', back2.from.version === 2 && back2.to === null && upd.resolvePackage(ud, bundled, 0).source === 'bundled');
  check('with nothing applied there is nothing to go back to', /nothing to go back to/.test(await refuses(async () => upd.rollBack(ud)) || ''));
  check('after going back, a release can be applied again', (await upd.stageRelease(ud, await upd.readRelease(r3.dir, verifier, 0), verifier)).version === 3);

  // ---- damage and a state file that cannot be trusted
  const active = upd.readState(ud).active;
  fs.rmSync(path.join(ud, 'releases', active.dir, 'start.html'));
  const fb = upd.resolvePackage(ud, bundled, 0);
  check('an active release that lost a file is dropped, with the reason', fb.source === 'bundled' && fb.fellBack.length === 1 && /release 3/.test(fb.fellBack[0]), fb);
  check('and the state no longer names it, nor does the folder remain', upd.readState(ud).active === null && releasesOf().filter((n) => upd.DIR_NAME.test(n)).length === 0, releasesOf());
  fs.writeFileSync(path.join(ud, 'releases', 'active.json'), JSON.stringify({ v: 1, active: { version: 4, name: 'x', dir: '../../../etc' }, previous: null }));
  check('a state that names a folder outside releases/ is ignored', upd.readState(ud).active === null && upd.resolvePackage(ud, bundled, 0).source === 'bundled');
  fs.writeFileSync(path.join(ud, 'releases', 'active.json'), 'garbage');
  check('a state file that is not JSON means nothing applied', upd.readState(ud).active === null);

  // ---- half-finished work from a crash is cleaned up
  fs.mkdirSync(path.join(ud, 'releases', '.partial-0123456789ab'), { recursive: true }); put(path.join(ud, 'releases'), 'keepme.txt', 'x');
  upd.prune(ud, upd.readState(ud));
  check('a half-finished staging folder is removed, and a file this code did not make is left alone', !fs.existsSync(path.join(ud, 'releases', '.partial-0123456789ab')) && fs.existsSync(path.join(ud, 'releases', 'keepme.txt')));

  // ---- what a person is asked (the questions are answered from here; the boxes themselves are native and not seen)
  const { makeFlows, menuTemplate } = require('../lib/update-ui.js');
  const ud2 = path.join(WORK, 'userdata-flows'); fs.mkdirSync(ud2);
  let restarts = 0, pickPath = null; const answers = [], boxes = [];
  const dialog = {
    showMessageBox: async (w, o) => { boxes.push(o); return { response: answers.length ? answers.shift() : 1 }; },
    showOpenDialog: async () => (pickPath ? { canceled: false, filePaths: [pickPath] } : { canceled: true, filePaths: [] })
  };
  const mk = (over) => makeFlows(Object.assign({ dialog, userData: ud2, verifierDir: verifyDir, current: { version: 0, name: 'the package that came with the app', source: 'bundled' }, explicit: false, packageDir: bundled, restart: () => { restarts++; }, log: () => {} }, over || {}));
  const flows = mk();
  const f1 = await makeRelease(path.join(WORK, 'frel1'), 'f-one', 1, key, { name: 'first' });
  const lastBox = () => boxes[boxes.length - 1];

  pickPath = null; let r = await flows.applyRelease(null);
  check('choosing nothing in the folder box does nothing', r.status === 'cancelled' && restarts === 0 && upd.readState(ud2).active === null);
  pickPath = path.join(WORK, 'rel-noenv'); r = await flows.applyRelease(null);
  check('a folder that is not a release is refused with a sentence, and nothing restarts', r.status === 'refused' && /no release\.json/.test(r.reason) && lastBox().type === 'error' && restarts === 0, r);
  pickPath = forged.dir; r = await flows.applyRelease(null);
  check('a release signed by another key is refused, and nothing restarts', r.status === 'refused' && /not signed by the key this app trusts/.test(r.reason) && restarts === 0, r);
  pickPath = f1.dir; answers.push(1); r = await flows.applyRelease(null);
  check('declining the question applies nothing', r.status === 'cancelled' && upd.readState(ud2).active === null && restarts === 0 && /Apply release 1 \(first\)/.test(lastBox().message), lastBox());
  check('the question says what runs now and that going back is possible', /the package that came with the app, release 0/.test(lastBox().detail) && /Go back to the previous version/.test(lastBox().detail), lastBox().detail);
  answers.push(0); r = await flows.applyRelease(null);
  check('accepting applies it and restarts once', r.status === 'applied' && r.entry.version === 1 && restarts === 1 && upd.readState(ud2).active.version === 1, { r, restarts });
  const flows2 = mk({ current: { version: 1, name: 'first', source: 'release' } });
  pickPath = f1.dir; r = await flows2.applyRelease(null);
  check('the same release again is refused as not newer', r.status === 'refused' && /Only a newer release/.test(r.reason) && restarts === 1, r);
  r = await mk({ explicit: true }).applyRelease(null);
  check('with a package named on the command line, applying is off and says why', r.status === 'refused' && /command line/.test(r.reason), r);
  r = await mk({ verifierDir: path.join(WORK, 'no-such-verifier') }).applyRelease(null);
  check('an app built without a key says it cannot take updates', r.status === 'refused' && /cannot take updates|without an update key/.test(lastBox().message + r.reason), r);

  answers.push(1); r = await flows2.goBack(null);
  check('declining to go back changes nothing', r.status === 'cancelled' && upd.readState(ud2).active.version === 1 && /the package that came with the app/.test(lastBox().message), lastBox());
  answers.push(0); r = await flows2.goBack(null);
  check('going back removes the release, restarts once more, and says data stays', r.status === 'rolled-back' && restarts === 2 && upd.readState(ud2).active === null && /identities and data stay/.test(lastBox().detail), { r, restarts });
  r = await flows2.goBack(null);
  check('going back with nothing applied is refused with a sentence', r.status === 'refused' && /came with the app/.test(r.reason) && restarts === 2, r);
  r = await mk({ explicit: true }).goBack(null);
  check('and it is off when a package was named on the command line', r.status === 'refused' && /command line/.test(r.reason), r);
  check('the about box names what runs', (await flows2.about(null)).lines.some((l) => /Running: first, release 1/.test(l)));

  const items = menuTemplate({ explicit: false }, flows, () => null)[0].submenu, offItems = menuTemplate({ explicit: true }, flows, () => null)[0].submenu;
  const lab = (arr, re) => arr.filter((i) => re.test(i.label || ''))[0];
  check('the menu has the three entries and quit', !!lab(items, /^About keo/) && !!lab(items, /^Apply a release/) && !!lab(items, /^Go back/) && items.some((i) => i.role === 'quit'));
  check('the update entries are greyed out, with the reason, when a package was named on the command line', lab(offItems, /^Apply a release/).enabled === false && lab(offItems, /^Go back/).enabled === false && /command line/.test(lab(offItems, /^Apply a release/).label) && lab(items, /^Apply a release/).enabled === true);

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
