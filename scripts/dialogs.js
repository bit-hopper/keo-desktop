// The parts of the app that open something native or hand the page's data to the system: saving a file, copying to the clipboard, and the
// question put when a window with unsaved changes is closed. Driven through the page's own buttons (the dialog that links a webputer to an
// identity has Copy and Save as file), with a virtual authenticator for the one passkey it makes.
//
//   node scripts/run-electron.js scripts/dialogs.js --package <desktop package> --work <scratch folder>
//
// What this does NOT show: the native Save dialog and the native "Leave keo?" box themselves. A save path is set from the test, which
// the app's default would otherwise ask a person for, and the leave question's answer is stubbed. So these checks cover that the page's
// data reaches a file with the right name and content, that the clipboard holds the copied code, and that the answer Leave or Stay is
// obeyed; how the two native boxes look and read is for a person to see.
const { app, session, clipboard, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work');
if (!PKG || !WORK) { console.error('usage: scripts/dialogs.js --package <desktop package> --work <scratch folder>'); process.exit(2); }
const userData = path.join(path.resolve(WORK), 'userdata-dialogs');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

const { start } = require('../main.js');
app.on('window-all-closed', () => {});   // the default quits the app, and the report after the last step would be lost
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 500) : '')); }

app.whenReady().then(async () => {
  const { win } = await start({ packageDir: PKG, devtools: false });
  const wc = win.webContents;
  const shell = (code) => wc.executeJavaScript(code, true);
  const poll = async (fn, ms) => { for (let t = 0; t < (ms || 30000); t += 300) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
  const worldFrame = () => wc.mainFrame.framesInSubtree.find((f) => /world\.html$/.test(f.url));
  const dlDir = path.join(path.resolve(WORK), 'downloads'); fs.rmSync(dlDir, { recursive: true, force: true }); fs.mkdirSync(dlDir, { recursive: true });
  // The dialog answers only trusted clicks (ev.isTrusted), as it should, so the buttons are pressed with real mouse input at their position.
  const realClick = async (label) => {
    const at = await shell(`(function () { var b = Array.prototype.filter.call(document.querySelectorAll('button'), function (x) { return x.textContent === ${JSON.stringify(label)} && !x.hidden && x.offsetParent !== null; })[0];
      if (!b) return null; b.scrollIntoView({ block: 'center' }); var r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!at) throw new Error('no visible button named ' + label);
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const wf = worldFrame;
  const downloads = [];
  session.defaultSession.on('will-download', (e, item) => {
    const file = path.join(dlDir, item.getFilename());
    item.setSavePath(file);
    item.once('done', (ev, state) => downloads.push({ name: item.getFilename(), state, file, size: item.getTotalBytes() }));
  });

  try {
    await poll(() => shell('!!(window.keoEnroll && window.keoIdentity)'));
    await poll(async () => { const f = worldFrame(); return f && await f.executeJavaScript('!!(window.$world && window.keo && window.keo.init)'); }, 90000);

    // ---- the link dialog on the new side makes a code (one virtual passkey), then the code is copied and saved through its own buttons
    const dbg = wc.debugger; dbg.attach('1.3');
    await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
    await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    const opened = await shell(`window.keoEnroll.start({ mode: 'new' }).then(function (r) { return { r: r }; }, function (e) { return { err: e.message }; })`);
    check('the link dialog opens', !opened.err && opened.r === true, opened);
    await shell(`document.querySelector('input[aria-label^="Name for this identity"]').focus()`);
    wc.insertText('Dialog test');
    await sleep(200);
    await realClick('Make a code');
    const code = await poll(() => shell(`(function () { var t = Array.prototype.filter.call(document.querySelectorAll('textarea'), function (x) { return /^keo-enroll-request\\./.test(x.value); })[0]; return t ? t.value : null; })()`));
    check('the dialog shows a code', !!code && /^keo-enroll-request\./.test(code), code && code.slice(0, 40));
    if (!code) console.log('  dialog state: ' + JSON.stringify(await shell(`(function () { var r = document.querySelector('[role=dialog], .keo-enroll, #keo-enroll'); var bs = Array.prototype.map.call(document.querySelectorAll('button'), function (b) { return b.textContent + (b.disabled ? ' (disabled)' : '') + (b.hidden ? ' (hidden)' : ''); }); var ts = Array.prototype.map.call(document.querySelectorAll('textarea'), function (t) { return t.value.slice(0, 40); }); return { buttons: bs, textareas: ts, hint: (document.querySelector('.hint') || {}).textContent }; })()`)));

    if (code) {
      await clipboard.writeText('before');
      console.log('  clipboard.readText() returns: ' + typeof clipboard.readText());
      await realClick('Copy');
      await sleep(600);
      const onClip = String(await clipboard.readText());
      check('Copy puts exactly the code on the system clipboard', onClip === code, { got: onClip.slice(0, 40) });
      const said = await shell(`(function () { var all = document.body.innerText; return /Copied\\./.test(all); })()`);
      check('and the dialog says it copied', said === true, said);

      await realClick('Save as file');
      const got = await poll(async () => downloads.length ? downloads[0] : null, 15000);
      check('Save as file makes a download named keo-enroll-request.txt that completed', !!got && got.name === 'keo-enroll-request.txt' && got.state === 'completed', got || downloads);
      const text = got ? fs.readFileSync(got.file, 'utf8') : '';
      check('and the file holds the code and a final newline', text === code + '\n', { len: text.length, expected: code.length + 1 });
    }
    // cancelling drops the waiting request, as the dialog does for a code nobody answered
    await realClick('Cancel');
    await sleep(800);

    // ---- leaving: a real click in the page (the browser asks only after one), then a close with the answer stubbed
    const answers = []; let next = 1;
    dialog.showMessageBoxSync = (w, o) => { answers.push({ message: o && o.message, buttons: o && o.buttons }); return next; };
    // The click goes through the debugging protocol: input sent with sendInputEvent reaches the shell page but gives the world frame, which
    // holds the runtime's unload warning, no user activation (measured), so the browser would never ask.
    const [cw, ch] = win.getContentSize(), px = Math.round(cw / 2), py = Math.round(ch / 2);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    const act = await wf().executeJavaScript('navigator.userActivation.hasBeenActive');
    check('the world frame has had a user click (the unload question needs one)', act === true, act);
    next = 1;                                       // Stay
    win.close(); await sleep(2500);
    check('closing the window asks "Leave keo?" with Leave and Stay', answers.length === 1 && answers[0].message === 'Leave keo?' && answers[0].buttons.join() === 'Leave,Stay', answers);
    check('answering Stay keeps the window open', !win.isDestroyed(), null);
    next = 0;                                       // Leave
    const closed = new Promise((res) => win.once('closed', () => res(true)));
    win.close();
    const did = await Promise.race([closed, sleep(8000).then(() => false)]);
    check('answering Leave closes the window', did === true, { answers: answers.length });
  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
