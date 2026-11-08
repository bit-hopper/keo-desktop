// Makes the app a person can unzip and run: the fixed host (app.js, main.js, lib/) plus the built keo package it serves, in a folder for the
// system this runs on (or another one named with --platform), and optionally a zip of that folder.
//
//   node scripts/pack.js --package <built desktop package> --out <folder> [--update-key <file>] [--bundled-version <n>] [--platform win32|linux] [--arch x64|arm64] [--zip]
//
//   --package         the folder `node extension/build.js <folder> --desktop` made in the keo repo; it becomes resources/keo-package
//   --out             where the result goes (a new or empty folder; nothing in it is overwritten silently)
//   --update-key      the public key (update-key.json) a release must be signed with; the app carries it in verify/ with the verifier code
//                     taken from the package, and checks every release against it. Without a key (this or one inside the package) the
//                     app is made without one and takes no updates; it says so
//   --bundled-version the release number the package counts as (default 0): a release must be higher to be applied
//   --platform        the system the app is for (default: this one). A build for another system cannot be run here: its first run is on that system. A zip
//                     made on win32 does not keep the executable bit, so on linux run `chmod +x keo` (and, if the system's sandbox helper is not set up and
//                     the app stops saying so, start it with --no-sandbox, which weakens the runtime's own protection)
//   --arch            the processor (default: this one)
//   --zip             also makes <out>/keo-<platform>-<arch>.zip
//
// What the result is NOT: signed (no code-signing certificate exists yet, so the system warns on first run), an installer (planned before
// anything is deployed), or able to fetch updates (a release folder is applied by hand from the menu). The desktop runtime comes from the
// download cache of the packager (checked against the checksums its publisher gives), at the version pinned in package.json.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPolicy } = require('../lib/serve.js');

const DESK = path.resolve(__dirname, '..');
const die = (m) => { console.error(m); process.exit(1); };
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const flag = (n) => process.argv.indexOf(n) > 0;

(async () => {
  const pkg = arg('--package') && path.resolve(arg('--package')), out = arg('--out') && path.resolve(arg('--out'));
  if (!pkg || !out) die('usage: node scripts/pack.js --package <built desktop package> --out <folder> [--update-key <file>] [--bundled-version <n>] [--platform win32|linux] [--arch x64|arm64] [--zip]');
  // the package must be one this host can run, before anything is copied
  try { readPolicy(JSON.parse(fs.readFileSync(path.join(pkg, 'desktop.json'), 'utf8')), 'keo.test'); } catch (e) { die('That folder is not a desktop package of keo (' + (e && e.message) + '): ' + pkg); }
  if (!fs.existsSync(path.join(pkg, 'start.html'))) die('The package has no start.html: ' + pkg);
  for (const f of ['keo-release.js', 'keo-did.js']) if (!fs.existsSync(path.join(pkg, f))) die('The package lacks ' + f + ', which the app needs to check releases.');
  const bundledVersion = arg('--bundled-version') === null ? 0 : Number(arg('--bundled-version'));
  if (!Number.isSafeInteger(bundledVersion) || bundledVersion < 0) die('--bundled-version must be a whole number, 0 or more');
  if (fs.existsSync(out) && fs.readdirSync(out).length) die('Refusing to use a folder that is not empty: ' + out);
  const platform = arg('--platform') || process.platform, arch = arg('--arch') || process.arch;
  if (['win32', 'linux'].indexOf(platform) < 0) die('--platform must be win32 or linux (it says ' + platform + ')');
  if (['x64', 'arm64'].indexOf(arch) < 0) die('--arch must be x64 or arm64 (it says ' + arch + ')');
  const own = JSON.parse(fs.readFileSync(path.join(DESK, 'package.json'), 'utf8'));
  const electronVersion = (own.devDependencies || {}).electron;
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion || '')) die('package.json must pin electron to an exact version (it says ' + electronVersion + ')');

  // the app's own folder, assembled apart from this repo so that tests, probes and notes are not shipped
  const stage = path.join(out, '.stage'), app = path.join(stage, 'app'), extra = path.join(stage, 'extra');
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(extra, { recursive: true });
  for (const f of ['app.js', 'main.js']) fs.copyFileSync(path.join(DESK, f), path.join(app, f));
  fs.cpSync(path.join(DESK, 'lib'), path.join(app, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'keo', productName: 'keo', version: own.version, description: own.description, main: 'app.js', license: own.license }, null, 2) + '\n');
  // the verifier and key the app checks releases with: its own copy, never read from a package or a release
  const verify = path.join(app, 'verify'); fs.mkdirSync(verify);
  for (const f of ['keo-release.js', 'keo-did.js']) fs.copyFileSync(path.join(pkg, f), path.join(verify, f));
  const keyFile = arg('--update-key') ? path.resolve(arg('--update-key')) : (fs.existsSync(path.join(pkg, 'update-key.json')) ? path.join(pkg, 'update-key.json') : null);
  if (keyFile) {
    try { const kr = require(path.join(verify, 'keo-release.js')); await kr.loadKeys(JSON.parse(fs.readFileSync(keyFile, 'utf8'))); } catch (e) { die('That is not a usable update key file (' + (e && e.message) + '): ' + keyFile); }
    fs.copyFileSync(keyFile, path.join(verify, 'update-key.json'));
  } else console.warn('No update key given or found in the package: this app will not take updates.');
  fs.cpSync(pkg, path.join(extra, 'keo-package'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'bundled.json'), JSON.stringify({ version: bundledVersion }) + '\n');

  const { packager } = await import('@electron/packager');
  const built = await packager({
    dir: app, out: path.join(out, 'app'), name: 'keo', executableName: 'keo', platform: platform, arch: arch,
    electronVersion, overwrite: true, asar: true, prune: false, junk: false, quiet: true,
    extraResource: [path.join(extra, 'keo-package'), path.join(extra, 'bundled.json')]
  });
  fs.rmSync(stage, { recursive: true, force: true });
  const dir = built[0];
  console.log('app folder: ' + dir);
  console.log('package: ' + (fs.existsSync(path.join(pkg, 'keo-build.json')) ? JSON.parse(fs.readFileSync(path.join(pkg, 'keo-build.json'), 'utf8')).version : '?') + ', counts as release ' + bundledVersion + ', ' + (keyFile ? 'takes updates signed by the key in ' + path.basename(keyFile) : 'takes no updates'));

  if (flag('--zip')) {
    const zip = path.join(out, 'keo-' + platform + '-' + arch + '.zip');
    // bsdtar reads and writes zip files (the main desktop systems ship it); GNU tar does not
    // On win32 the system's own tar.exe is named in full: a GNU tar earlier on the path (a Unix toolkit's) reads "C:" as a remote host.
    const sysTar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(sysTar, ['-a', '-c', '-f', zip, '-C', path.dirname(dir), path.basename(dir)], { stdio: 'inherit' });
    if (r.status !== 0) die('Could not make the zip (tar -a needs bsdtar): zip the folder ' + dir + ' by hand.');
    console.log('zip: ' + zip + ' (' + Math.round(fs.statSync(zip).size / 1048576) + ' MB)');
  }
})().catch((e) => die('pack failed: ' + (e && e.stack || e)));
