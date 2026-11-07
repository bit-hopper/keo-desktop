// The app's entry (package.json "main"): opens the window on the package to run.
//
// This is a file of its own, and main.js only exports, because a test cannot tell the two apart if the entry is "main.js unless it is
// required": in this runtime `require.main === module` is false even for the entry module, so a check of that kind never starts the
// app, and the scripts that call start() themselves (scripts/smoke.js, scripts/real.js) would not notice. test/entry-test.js starts
// this file the way a person does.
//
// Which package runs, in this order:
//   1. --package <folder> (or KEO_PACKAGE): the folder named. Used by tests and while developing; updating is off, because a release
//      applied now would not be the one that starts next time.
//   2. the release the person applied last, staged under the app's data folder (lib/update.js);
//   3. the package that came with the app: resources/keo-package in a packaged app, or KEO_BUNDLED_PACKAGE while developing.
//
//   node scripts/run-electron.js . --package <folder> [--devtools]
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { start, parseArgs } = require('./main.js');
const upd = require('./lib/update.js');
const { makeFlows, menuTemplate } = require('./lib/update-ui.js');

// The profile folder is set first: the lock below is per profile, so it must be taken on the folder this run will use.
app.setPath('userData', process.env.KEO_USER_DATA || path.join(app.getPath('appData'), 'keo'));

// A window cannot be answered by a test, so with KEO_ERRORS_TO_STDERR the reasons go to the error output instead of a dialog.
const toStderr = !!process.env.KEO_ERRORS_TO_STDERR;

function choosePackage(opts) {
  const userData = app.getPath('userData');
  if (opts.packageDir) return { explicit: true, current: { version: 0, name: 'a package named on the command line', source: 'explicit' }, fellBack: [] };
  // The package that came with the app sits beside the code in a packaged app; the release number it counts as is in bundled.json next to it.
  const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'keo-package') : (process.env.KEO_BUNDLED_PACKAGE || null);
  let bundledVersion = 0;
  try { bundledVersion = Number(app.isPackaged ? JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'bundled.json'), 'utf8')).version : process.env.KEO_BUNDLED_VERSION) || 0; } catch (e) { bundledVersion = 0; }
  const r = upd.resolvePackage(userData, bundledDir && fs.existsSync(bundledDir) ? bundledDir : null, bundledVersion);
  opts.packageDir = r.dir;
  return { explicit: false, current: { version: r.version, name: r.name, source: r.source }, fellBack: r.fellBack };
}

// Two instances on one profile would write to the same storage; the second one hands over to the first and quits.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    const opts = parseArgs(process.argv.slice(1));
    const chosen = choosePackage(opts);
    // The verifier and the key an update is checked with are the app's own (verify/, written when the app is packaged). They are read from
    // the app's folder and never from a package or a release; while developing, KEO_VERIFIER_DIR may name another folder, a packaged app
    // ignores it.
    const verifierDir = app.isPackaged ? path.join(__dirname, 'verify') : (process.env.KEO_VERIFIER_DIR || path.join(__dirname, 'verify'));
    const flows = makeFlows({
      dialog, userData: app.getPath('userData'), verifierDir, current: chosen.current, explicit: chosen.explicit, packageDir: opts.packageDir,
      restart: () => { app.relaunch(); app.exit(0); }, log: (l) => { if (toStderr) console.error('keo: ' + l); }
    });
    opts.menuTemplate = (getWin) => menuTemplate({ explicit: chosen.explicit }, flows, getWin);
    const { win } = await start(opts);
    app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
    if (chosen.fellBack.length) {
      const msg = 'The release you applied could not be used (' + chosen.fellBack.join('; ') + '), so keo started on ' + chosen.current.name + '.';
      if (toStderr) console.error('keo: ' + msg); else dialog.showMessageBox(win, { type: 'warning', buttons: ['OK'], title: 'keo', message: 'keo started on an earlier version', detail: msg, noLink: true });
    }
  }).catch((e) => {
    if (toStderr) console.error('keo could not start: ' + String(e && e.message || e));
    else dialog.showErrorBox('keo could not start', String(e && e.message || e));
    app.exit(1);
  });
}
