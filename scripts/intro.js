// The introduction screens (keo's shell/keo-intro.js: our QR code to show, someone else's to read and add) inside the desktop app, by its
// real window, with a VIRTUAL authenticator for the one identity it makes. The point is what the app adds to the page: the page's own policy
// (scripts from the package only, no eval, no inline script), the files the package carries, real mouse and key input, and the system
// clipboard. Driven the way a person does it: real clicks (the screens answer only trusted ones), real Escape, typed text.
//
//   node scripts/run-electron.js scripts/intro.js --package <desktop package> --work <scratch folder>
//
// The package is built in the keo repo:  node extension/build.js <folder> --desktop
// What this does NOT show: a phone scanning the code (nothing here reads the QR; the keo repo's tests read it back from the canvas with a
// decoder), a real authenticator, another operating system, how the screens look (take a picture and look).
const { app, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work');
if (!PKG || !WORK) { console.error('usage: scripts/intro.js --package <desktop package> --work <scratch folder>'); process.exit(2); }
const userData = path.join(path.resolve(WORK), 'userdata-intro');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

const { start, ORIGIN } = require('../main.js');
app.on('window-all-closed', () => {});   // the default quits the app, and the report after the last step would be lost
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 600) : '')); }

app.whenReady().then(async () => {
  const errors = [];
  const { win } = await start({ packageDir: PKG, devtools: false });
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(String(e.message).slice(0, 220)); });
  const shell = (code) => wc.executeJavaScript(code, true);
  const poll = async (fn, ms) => { for (let t = 0; t < (ms || 30000); t += 300) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
  const outDir = path.resolve(WORK); fs.mkdirSync(outDir, { recursive: true });
  // A real click at a visible button with exactly this text.
  const realClick = async (label) => {
    const at = await shell(`(function () { var b = Array.prototype.filter.call(document.querySelectorAll('#keo-intro button'), function (x) { return x.textContent === ${JSON.stringify(label)} && !x.hidden && x.offsetParent !== null; })[0];
      if (!b) return null; var r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!at) throw new Error('no visible button named ' + label);
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(300);
  };
  const key = async (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(300); };
  const screen = () => shell(`(function () { var r = document.getElementById('keo-intro'); if (!r) return null; var c = r.querySelector('canvas'), dark = 0, w = c.width;
    if (w) { var d = c.getContext('2d').getImageData(0, 0, w, w).data; for (var i = 0; i < d.length; i += 4) if (d[i] === 0) dark++; }
    var t = r.querySelector('.tab.on'); return { hidden: r.hidden, tab: t && t.textContent, raw: r.querySelector('textarea.raw').value, canvasW: w, dark: dark, words: r.querySelector('.show .words').textContent,
      hint: r.querySelector('.show .hint').textContent, yesDisabled: r.querySelector('button.yes').disabled, active: document.activeElement && (document.activeElement.className || document.activeElement.tagName) }; })()`);

  try {
    // ---- the package carries the new files and the page runs them under its own policy
    const modules = await poll(() => shell('!!(window.keoIntro && window.keoQr && window.keoQrcodegen && window.keoCards && window.keoIdentity)'));
    check('the shell page has the introduction, QR and card modules', !!modules);
    const files = await shell(`Promise.all(['keo-qrcodegen.js', 'keo-qr.js', 'keo-intro.js', 'keo-cards.js'].map(function (f) { return fetch('/' + f).then(function (r) { return f + ' ' + r.status + ' ' + (r.headers.get('content-type') || ''); }); }))`);
    check('the package serves all four files as scripts', files.every((s) => / 200 .*javascript/.test(s)), files);
    const csp = await shell(`fetch('/start.html').then(function (r) { return r.headers.get('content-security-policy'); })`);
    check('the page policy allows no inline script and no eval (so the QR and screens run without either)', /script-src 'self'/.test(csp || '') && !/'unsafe-(eval|inline)'/.test((csp || '').split(';').filter((p) => /script-src/.test(p)).join(';')), csp);

    const dbg = wc.debugger; dbg.attach('1.3');
    await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
    await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    const made = await shell(`window.keoIdentity.create({ label: 'Desktop intro' }).then(function (r) { return { r: r }; }, function (e) { return { err: e.name + ': ' + e.message }; })`);
    check('an identity is made and signed in', !made.err && !!made.r && !!made.r.did && !!made.r.session, made);
    await shell(`window.keoCards.setHelpers([{ kind: 'ws', host: '203.0.113.9', port: 47431 }])`);

    // ---- show: the screen opens, the code is drawn on the canvas, Copy reaches the system clipboard, Escape closes it
    const opened = await shell(`window.keoIntro.show().then(function (r) { return { r: r }; }, function (e) { return { err: e.message }; })`);
    check('the screen opens on "Show mine"', !opened.err && opened.r === true, opened);
    const s1 = await poll(async () => { const s = await screen(); return s && s.raw ? s : null; });
    check('it shows our introduction as text, with a code drawn on the canvas', !!s1 && /^keointro1\./.test(s1.raw) && s1.canvasW >= 200 && s1.canvasW <= 400, s1);
    check('the drawn code has dark and light modules (not blank, not solid)', !!s1 && s1.dark > s1.canvasW * s1.canvasW * 0.15 && s1.dark < s1.canvasW * s1.canvasW * 0.6, s1 && { dark: s1.dark, w: s1.canvasW });
    check('the keyboard is in the screen from the start (focus is inside it)', (await shell(`document.getElementById('keo-intro').contains(document.activeElement)`)) === true, s1 && s1.active);
    fs.writeFileSync(path.join(outDir, 'intro-desktop-show.png'), (await wc.capturePage()).toPNG());

    await clipboard.writeText('before');
    await realClick('Copy text');
    await sleep(500);
    const onClip = String(await clipboard.readText());   // a promise in this version of the app
    check('Copy puts exactly the introduction on the system clipboard', onClip === s1.raw, { got: onClip.slice(0, 40) });
    check('and the screen says it copied', (await screen()).hint === 'Copied.', (await screen()).hint);

    await key('Escape');
    const s2 = await screen();
    check('Escape closes the screen (a real key press), and clears the code', s2.hidden === true && s2.canvasW === 0 && s2.raw === '', s2);

    // ---- read: paste, type the other person's words, a real click adds them
    await sleep(10300);
    const standIn = 'did:keo:' + 'y'.repeat(52) + ':' + 'C'.repeat(43);
    const text = await shell(`window.keoHello.introToText({ did: ${JSON.stringify(standIn)}, name: 'Jun' })`);
    const words = await shell(`window.keoFingerprint.words(${JSON.stringify(standIn)})`);
    const o2 = await shell(`window.keoIntro.read().then(function (r) { return { r: r }; }, function (e) { return { err: e.message }; })`);
    check('the reading screen opens', !o2.err && o2.r === true, o2);
    await shell(`document.querySelector('#keo-intro textarea.paste').focus()`);
    wc.insertText(text);
    await poll(() => shell(`!document.querySelector('#keo-intro .result').hidden`), 8000);
    await shell(`document.querySelector('#keo-intro input.theirs').focus()`);
    wc.insertText(words.join(' '));
    await poll(() => shell(`!document.querySelector('#keo-intro button.yes').disabled`), 8000);
    check('typed text reaches the screen, and the right words wake Add', (await screen()).yesDisabled === false);
    check('nobody is added before the click', (await shell(`window.keoContacts.ensure().then(function () { return window.keoContacts.isAdded(${JSON.stringify(standIn)}); })`)) === false);
    await realClick('Add as friend');
    const added = await poll(() => shell(`window.keoContacts.isAdded(${JSON.stringify(standIn)})`), 8000);
    check('a real click adds the friend', added === true);
    fs.writeFileSync(path.join(outDir, 'intro-desktop-after.png'), (await wc.capturePage()).toPNG());

    // ---- nothing was refused by the page's policy
    check('the app is still on its own address', (await shell('location.origin')) === ORIGIN);
    const bad = errors.filter((e) => !/Media\/badges|compute-pressure|geolocation|youtube|iframe_api|beforeunload/i.test(e));
    check('no console errors (a refused script or style would show here)', bad.length === 0, bad);
  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  }
  console.log(passed + ' passed, ' + failed + ' failed   (electron ' + process.versions.electron + ', chromium ' + process.versions.chrome + ', virtual authenticator)');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
