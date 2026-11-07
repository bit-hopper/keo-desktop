// The app's entry (package.json "main"): opens the window on the package named by --package (or KEO_PACKAGE).
//
// This is a file of its own, and main.js only exports, because a test cannot tell the two apart if the entry is "main.js unless it is
// required": in this runtime `require.main === module` is false even for the entry module, so a check of that kind never starts the
// app, and the scripts that call start() themselves (scripts/smoke.js, scripts/real.js) would not notice. test/entry-test.js starts
// this file the way a person does.
//
//   node scripts/run-electron.js . --package <folder> [--devtools]
const { app, dialog } = require('electron');
const path = require('path');
const { start, parseArgs } = require('./main.js');

// The profile folder is set first: the lock below is per profile, so it must be taken on the folder this run will use.
app.setPath('userData', process.env.KEO_USER_DATA || path.join(app.getPath('appData'), 'keo'));
// Two instances on one profile would write to the same storage; the second one hands over to the first and quits.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => start(parseArgs(process.argv.slice(1)))).then(({ win }) => {
    app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  }).catch((e) => {
    // A window cannot be answered by a test, so with KEO_ERRORS_TO_STDERR the reason goes to the error output instead of a dialog.
    if (process.env.KEO_ERRORS_TO_STDERR) console.error('keo could not start: ' + String(e && e.message || e));
    else dialog.showErrorBox('keo could not start', String(e && e.message || e));
    app.exit(1);
  });
}
