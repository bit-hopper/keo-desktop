// Applying a release the person already has, and choosing which package the app runs. No desktop runtime, no network: plain node over
// files, so every rule here can be tested without a window (test/update-test.js).
//
// A release folder holds two things:  release.json  (the signed envelope the keo repo's sign-release tool writes) and  package/  (the
// built desktop package the envelope describes, every file of it). The app checks the envelope against the key it was built with, checks
// that the package folder holds exactly the files the signed list names with the sizes and hashes it gives, and only then copies it into
// its own folder for releases. Nothing is run from the release folder itself.
//
// The verifier (keo-release.js and keo-did.js) and the pinned key (update-key.json) come from a folder the HOST carries (verify/ in the
// app), never from the package being installed or from the release: a package must not be the only thing vouching for its own verifier,
// and a key in the release folder would let whoever made the folder name its own signer.
//
// Layout under the app's data folder:
//   releases/active.json     { v: 1, active: <entry|null>, previous: <entry|null> }   entry = { version, name, dir }
//   releases/<dir>/          a staged package (dir looks like r<version>-<6 hex digits>)
// A null `active` means the package that came with the app. At most two staged packages are kept: the one in use and the one before.
//
// What this must not be used for: running anything from outside releases/ or the app's own package, or accepting a folder because a
// file in it says it is fine (keo-files.json in a package is a convenience written by the build, never a statement; it is rewritten here
// from the signed list).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPolicy } = require('./serve.js');

const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024;     // the verifier caps the payload at 8 MB; its base64 is a third larger
const DIR_NAME = /^r[0-9]{1,9}-[0-9a-f]{6}$/;
// Left out of what a release lists, exactly as the keo repo's package listing does: the builder's marker and the list the build writes last.
const NOT_LISTED = new Set(['.keo-world-build', 'keo-files.json']);

const releasesDir = (userData) => path.join(userData, 'releases');
const fail = (m) => { throw new Error(m); };

// ---- the verifier --------------------------------------------------------------------------------------------------
// `dir` holds keo-release.js, keo-did.js and update-key.json. Resolves to { kr, keys }, or rejects with a reason (no key pinned: this app
// takes no updates).
async function loadVerifier(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'update-key.json'))) fail('This app was built without an update key, so it takes no updates.');
  const kr = require(path.join(dir, 'keo-release.js'));
  const keys = await kr.loadKeys(JSON.parse(fs.readFileSync(path.join(dir, 'update-key.json'), 'utf8')));
  return { kr, keys };
}

// ---- state ---------------------------------------------------------------------------------------------------------
const emptyState = () => ({ v: 1, active: null, previous: null });
function validEntry(e) {
  return e && typeof e === 'object' && Number.isSafeInteger(e.version) && e.version >= 1 && typeof e.name === 'string' && e.name.length <= 64 && typeof e.dir === 'string' && DIR_NAME.test(e.dir);
}
function readState(userData) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(releasesDir(userData), 'active.json'), 'utf8')); } catch (e) { return emptyState(); }
  if (!doc || doc.v !== 1) return emptyState();
  return { v: 1, active: validEntry(doc.active) ? doc.active : null, previous: validEntry(doc.previous) ? doc.previous : null };
}
function writeState(userData, state) {
  const dir = releasesDir(userData); fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'active.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
  fs.renameSync(tmp, path.join(dir, 'active.json'));
}

// A staged package is usable if it still has what the host needs to serve it. This is not a re-check of its contents (that was done as it
// was staged); it catches a folder that was removed or damaged since.
function usable(userData, entry) {
  const root = path.join(releasesDir(userData), entry.dir);
  try {
    readPolicy(JSON.parse(fs.readFileSync(path.join(root, 'desktop.json'), 'utf8')), 'keo.test');
    return fs.statSync(path.join(root, 'start.html')).isFile();
  } catch (e) { return false; }
}

// Which package to run. `bundledDir` is the package that came with the app (or null). Resolves to
//   { dir, version, name, source: 'release' | 'bundled' | null, fellBack: [reason, ...] }
// An active release that is not usable is dropped from the state (the previous one, or the bundled package, takes its place) and the
// reason is reported once in `fellBack`.
function resolvePackage(userData, bundledDir, bundledVersion) {
  const state = readState(userData), fellBack = [];
  let changed = false;
  while (state.active && !usable(userData, state.active)) {
    fellBack.push('release ' + state.active.version + ' (' + state.active.name + ') is missing or damaged');
    state.active = state.previous; state.previous = null; changed = true;
  }
  if (changed) { writeState(userData, state); prune(userData, state); }
  if (state.active) return { dir: path.join(releasesDir(userData), state.active.dir), version: state.active.version, name: state.active.name, source: 'release', fellBack };
  return { dir: bundledDir || null, version: bundledDir ? (bundledVersion || 0) : 0, name: 'the package that came with the app', source: bundledDir ? 'bundled' : null, fellBack };
}

// Removes staged packages nobody refers to, and half-finished ones. Only names this file makes are touched.
function prune(userData, state) {
  const dir = releasesDir(userData);
  let names; try { names = fs.readdirSync(dir); } catch (e) { return; }
  const keep = new Set([state.active && state.active.dir, state.previous && state.previous.dir].filter(Boolean));
  for (const n of names) {
    if (n === 'active.json' || n === 'active.json.tmp') continue;
    if (keep.has(n)) continue;
    if (DIR_NAME.test(n) || /^\.partial-[0-9a-f]{12}$/.test(n)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
}

// ---- reading a release folder --------------------------------------------------------------------------------------
// Checks the signature and the version only (cheap). Resolves to { manifest, packageDir }; the file contents are checked as they are staged.
async function readRelease(releaseDir, verifier, runningVersion) {
  const envFile = path.join(releaseDir, 'release.json'), packageDir = path.join(releaseDir, 'package');
  let st;
  try { st = fs.lstatSync(envFile); } catch (e) { fail('That folder has no release.json. A release folder holds release.json and a package folder.'); }
  if (!st.isFile() || st.size > MAX_ENVELOPE_BYTES) fail('release.json is not a release file.');
  try { if (!fs.lstatSync(packageDir).isDirectory()) throw 0; } catch (e) { fail('That folder has no package folder next to release.json.'); }
  let env;
  try { env = JSON.parse(fs.readFileSync(envFile, 'utf8')); } catch (e) { fail('release.json is not valid.'); }
  let manifest;
  try { manifest = await verifier.kr.verifyEnvelope(env, verifier.keys); }
  catch (e) { fail('This release is not signed by the key this app trusts (' + String(e.message || e).replace(/^keoRelease: /, '') + ').'); }
  if (!(manifest.version > (runningVersion || 0))) fail('This is release ' + manifest.version + ', and release ' + (runningVersion || 0) + ' is running. Only a newer release can be applied.');
  for (const need of ['start.html', 'desktop.json']) if (!manifest.files[need]) fail('The release does not list ' + need + ', so it is not a desktop package.');
  return { manifest, packageDir };
}

// Every file under `dir` as a relative path with forward slashes. A link, a socket or anything else that is not a plain file or folder
// stops the walk: a release has no such thing, and following one could read outside the folder.
function listFiles(dir) {
  const out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) { if (!NOT_LISTED.has(r)) out.push(r); }
      else fail('The package folder holds something that is not a plain file or folder: ' + r);
    }
  })('');
  return out;
}

// ---- staging --------------------------------------------------------------------------------------------------------
// Copies the package into the app's releases folder, checking each file's bytes against the signed list as they are copied (the bytes
// that were checked are the bytes written), then switches to it. Resolves to the new entry. Leaves nothing behind on a failure.
// The running package stays in use until the app restarts.
async function stageRelease(userData, read, verifier) {
  const { manifest, packageDir } = read;
  const have = listFiles(packageDir).sort(), want = Object.keys(manifest.files).sort();
  const extra = have.filter((p) => !manifest.files[p]), missing = want.filter((p) => have.indexOf(p) < 0);
  if (missing.length) fail('The package folder is missing ' + missing.length + ' file(s) the release lists, such as ' + missing[0] + '.');
  if (extra.length) fail('The package folder holds ' + extra.length + ' file(s) the release does not list, such as ' + extra[0] + '.');

  const dir = releasesDir(userData); fs.mkdirSync(dir, { recursive: true });
  const partial = path.join(dir, '.partial-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(partial);
  try {
    for (const p of want) {
      const bytes = fs.readFileSync(path.join(packageDir, p));
      if (!(await verifier.kr.checkFile(manifest.files[p], bytes))) fail('A file does not match the signed list: ' + p + '.');
      const to = path.join(partial, p);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, bytes);
    }
    // The list the build writes last, regenerated from the signed one (the one in the folder was never checked and is not used).
    fs.writeFileSync(path.join(partial, 'keo-files.json'), JSON.stringify({ v: 1, files: manifest.files }) + '\n');
    try { readPolicy(JSON.parse(fs.readFileSync(path.join(partial, 'desktop.json'), 'utf8')), 'keo.test'); }
    catch (e) { fail('The release is not a package this app can run (' + String(e.message || e) + ').'); }
    const name = 'r' + manifest.version + '-' + crypto.randomBytes(3).toString('hex');
    fs.renameSync(partial, path.join(dir, name));
    const state = readState(userData);
    const entry = { version: manifest.version, name: manifest.name, dir: name };
    const next = { v: 1, active: entry, previous: state.active };
    writeState(userData, next);
    prune(userData, next);
    return entry;
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw e;
  }
}

// Goes back to the package before the active one (or to the package that came with the app, when there was none). Returns
// { from: <entry>, to: <entry|null> }. The release that is left is removed; applying it again needs its folder.
function rollBack(userData) {
  const state = readState(userData);
  if (!state.active) fail('There is nothing to go back to: the package that came with the app is running.');
  const from = state.active, next = { v: 1, active: state.previous, previous: null };
  writeState(userData, next);
  prune(userData, next);
  return { from, to: state.previous };
}

module.exports = { loadVerifier, readState, resolvePackage, readRelease, stageRelease, rollBack, prune, listFiles, releasesDir, DIR_NAME };
