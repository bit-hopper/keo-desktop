// The desktop app against a built keo package, by its real window, with a VIRTUAL authenticator. A virtual authenticator never shows the
// focus, prompt-timing or OS-dialog problems a real one can, so nothing here says the passkey works on a real one (that is scripts/real.js).
//
//   node scripts/run-electron.js scripts/smoke.js --package <desktop package> --work <scratch folder>
//
// The package is built in the keo repo:  node extension/build.js <folder> --desktop
// Every address except the app's own is made unreachable (a host-resolver rule), and every request that is not for the app's own address is
// counted, so a request that still needed a server or a service fails loudly. <scratch folder> holds the app's storage for this run.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work');
if (!PKG || !WORK) { console.error('usage: scripts/smoke.js --package <desktop package> --work <scratch folder>'); process.exit(2); }
const userData = path.join(path.resolve(WORK), 'userdata');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

const { start, ORIGIN, HOST } = require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }

app.whenReady().then(async () => {
  const outside = [], errors = [];
  require('electron').session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    let host = ''; try { host = new URL(d.url).hostname; } catch (e) {}
    if (!/^(data|blob|devtools|chrome-extension|about):/.test(d.url) && host !== HOST) outside.push(d.url.slice(0, 120));
    cb({});
  });
  const { win } = await start({ packageDir: PKG, devtools: false });
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message).slice(0, 200) + ' @' + String(e.sourceId || '').slice(-40));
  });
  const run = (code) => wc.executeJavaScript(code, true);
  const poll = async (fn, ms) => { for (let t = 0; t < (ms || 30000); t += 300) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
  const worldFrame = () => wc.mainFrame.framesInSubtree.find((f) => /world\.html$/.test(f.url));
  const outDir = path.resolve(WORK); fs.mkdirSync(outDir, { recursive: true });
  const worldUp = () => poll(async () => { const f = worldFrame(); return f && await f.executeJavaScript('!!(window.$world && window.$world.submorphs && window.keo && window.keo.init)'); }, 90000);
  const picture = async (name) => { await sleep(4000); fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG()); };

  try {
    check('the window is on the app\'s own address', (await run('location.origin')) === ORIGIN);
    check('the shell page has its modules', !!(await poll(() => run('!!(window.keoIdentity && window.keoDid && window.keoHello && window.keoEnroll && window.keoStatus)'))));
    check('the popup responder is skipped without an extension runtime and the page still runs', (await run('typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id')) === true);

    // ---- the world: sandboxed, and booted from the package
    const booted = await worldUp();
    check('the world boots from the package', !!booted);
    await picture('smoke-first.png');
    const wf = worldFrame();
    // window.origin is the document's real security origin; location.origin only echoes the address and says https://keo.test even in a sandbox
    const wo = wf ? { url: wf.url, security: await wf.executeJavaScript('window.origin') } : null;
    const reach = await run('(function(){ try { return "READ " + String(document.getElementById("world").contentWindow.document.title); } catch (e) { return e.name; } })()');
    check('the world runs in an opaque origin: it says so, and the shell page cannot reach into its frame', !!wo && wo.security === 'null' && reach === 'SecurityError', { wo, reach });
    const vaultTitle = await run('(function(){ var f = document.getElementById("vault"); try { return f.contentDocument && f.contentDocument.title; } catch (e) { return "ERR " + e.message; } })()');
    check('the vault page loaded in its frame (same origin)', vaultTitle === 'keo identity vault', vaultTitle);

    // ---- headers and refusals, asked the way a page asks
    const h = await run(`(async function(){
      const g = async (u, o) => { const r = await fetch(u, o); return { s: r.status, csp: r.headers.get('content-security-policy'), ct: r.headers.get('content-type'), acao: r.headers.get('access-control-allow-origin') }; };
      return { world: await g('/world.html'), start: await g('/start.html'), js: await g('/keo-did.js'), post: await g('/keo-did.js', { method: 'POST' }),
        up: await g('/..%2fdesktop.json'), marker: await g('/.keo-world-build'), nofile: await g('/nothing-here.js'), desktop: await g('/desktop.json') };
    })()`);
    check('world.html carries the sandbox policy', h.world.s === 200 && /^sandbox /.test(h.world.csp || ''), h.world);
    check('start.html carries the shell policy: package scripts only, no eval, no inline', h.start.s === 200 && /script-src 'self'/.test(h.start.csp || '') && !/'unsafe-(eval|inline)'/.test(h.start.csp || ''), h.start);
    check('a script is served as a script, readable from the sandbox', h.js.s === 200 && /javascript/.test(h.js.ct) && h.js.acao === '*', h.js);
    check('POST is refused', h.post.s === 405, h.post);
    check('a path that climbs out of the package is refused', h.up.s === 404, h.up);
    check('the builder\'s marker file is not served', h.marker.s === 404, h.marker);
    check('a missing file is a 404', h.nofile.s === 404, h.nofile);

    // ---- the window stays where it is
    await run('location.href = "https://example.com/"').catch(() => {});
    await sleep(800);
    check('a navigation away from the app is stopped', (await run('location.origin')) === ORIGIN);
    check('a pop-up is refused', (await run('window.open("https://keo.test/start.html") === null')) === true);

    // ---- identity, with a virtual authenticator attached to the window
    const dbg = wc.debugger; dbg.attach('1.3');
    await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
    await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    const made = await run(`window.keoIdentity.create({ label: 'Desktop smoke' }).then(function (r) { return { r: r }; }, function (e) { return { err: e.name + ': ' + e.message }; })`);
    const m = made.r || {};
    check('an identity is made: the passkey is for keo.test and the DID has its usual shape', !made.err && /^did:keo:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}:[A-Za-z0-9_-]{43}$/.test(m.did) && m.rpId === HOST && m.authorityKeys === 1 && m.notRecoverable === true, made);
    check('and the new identity is signed in', !!(m.session && m.session.did === m.did), m.session);
    if (m.did) {
      await run('window.keoIdentity.signOut()');
      const si = await run(`window.keoIdentity.signIn({ did: ${JSON.stringify(m.did)} }).then(function (r) { return { r: r }; }, function (e) { return { err: e.name + ': ' + e.message }; })`);
      check('it signs in again, the assertion names the app\'s address and the secret cannot be read out', !si.err && si.r.assertionOrigin === ORIGIN && si.r.secretNonExtractable === true, si);

      await wc.loadURL(ORIGIN + '/');
      await poll(() => run('!!(window.keoIdentity && window.keoIdentity.list)'));
      const list = await run('window.keoIdentity.list().then(function (l) { return l.map(function (x) { return x.did; }); })');
      check('after the page is loaded again the identity is still there (storage is kept by the app)', Array.isArray(list) && list.length === 1 && list[0] === m.did, list);
      check('and the world boots again after the reload', !!(await worldUp()));
      await picture('smoke-after-reload.png');
    }

    // ---- nothing left the app, and the page raised nothing
    check('no request went to any address but the app\'s own', outside.length === 0, outside);
    const bad = errors.filter((e) => !/Media\/badges|compute-pressure|geolocation|youtube|iframe_api|beforeunload/i.test(e));
    check('no console errors from the shell or the package', bad.length === 0, bad);
    if (errors.length !== bad.length) console.log('  (ignored ' + (errors.length - bad.length) + ' known console lines: the runtime\'s video script, and the unload panel a reload without a click cannot show)');

  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  }
  console.log(passed + ' passed, ' + failed + ' failed   (electron ' + process.versions.electron + ', chromium ' + process.versions.chrome + ', virtual authenticator)');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
