// The desktop app's identity against a REAL authenticator, on https://keo.test. A person must be at the keyboard and approve the OS prompts
// (about a minute). Nothing is attached to the window to stand in for an authenticator, so whatever the OS offers answers: the platform
// authenticator, a security key, a phone.
//
//   node scripts/run-electron.js scripts/real.js --package <desktop package> --work <scratch folder>
//
// Prompts, in order (four; each is announced BEFORE it starts, with a timestamp):
//   1 + 2  create: make the passkey, then sign the new identity with it (the second follows the first at once)
//   3      sign in
//   4      sign in again after the page is loaded again
// The window is brought to the front before every prompt. Each ceremony reports whether the page had focus when it started: an OS prompt
// that appears behind the window, or a ceremony that waits for focus, shows up there. A failure is reported with the error's name and
// message and the later steps are skipped. NotAllowedError means the prompt was dismissed, timed out, or the OS refused: an environment
// problem can look the same, so check it before suspecting the code.
//
// What this covers: this machine, this authenticator, this app's address. What it does not: another operating system, another kind of
// authenticator, linking an identity to this address (tests/keo-enroll-real.js in the keo repo covers linking between two extension ids).
// The passkey stays in the authenticator (a page cannot delete one): remove "Real desktop test" for keo.test in the OS passkey settings
// if it is not wanted. The app's storage for this run is in <scratch folder>/userdata-real.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work');
if (!PKG || !WORK) { console.error('usage: scripts/real.js --package <desktop package> --work <scratch folder>'); process.exit(2); }
const userData = path.join(path.resolve(WORK), 'userdata-real');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const { start, ORIGIN, HOST } = require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString();
const say = (m) => console.log('[' + now() + '] ' + m);
const results = {};
function check(name, ok, detail) { results[name] = { ok: !!ok, detail }; say((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 700) : '')); }
const WAIT_MS = 3 * 60 * 1000;

app.whenReady().then(async () => {
  const { win } = await start({ packageDir: PKG, devtools: false });
  const wc = win.webContents;
  const run = (code) => wc.executeJavaScript(code, true);
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error' && !/youtube|iframe_api|beforeunload|Media\/badges|compute-pressure|geolocation/i.test(e.message)) errors.push(String(e.message).slice(0, 200)); });
  const poll = async (fn, ms) => { for (let t = 0; t < (ms || 30000); t += 300) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
  // a page call that gives { r } or { err }, and does not wait for a prompt nobody answers for more than three minutes
  const ask = (code) => Promise.race([
    run(`(${code}).then(function (r) { return { r: r }; }, function (e) { return { err: e.name + ': ' + e.message }; })`),
    sleep(WAIT_MS).then(() => ({ err: 'TimedOut: nobody answered the prompt within 3 minutes' }))]);
  const front = () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

  try {
    check('the window is on the app\'s own address', (await run('location.origin')) === ORIGIN);
    check('the shell page has its modules', !!(await poll(() => run('!!(window.keoIdentity && window.keoDid)'))));
    const env = await run(`(async function(){ return { ua: navigator.userAgent, uvpaa: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      caps: PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : null }; })()`);
    say('engine: ' + env.ua); say('platform authenticator available: ' + env.uvpaa);
    say('client capabilities (relevant): ' + JSON.stringify(env.caps && { prf: env.caps['extension:prf'], hybrid: env.caps.hybridTransport, uvpaa: env.caps.userVerifyingPlatformAuthenticator }));
    results.environment = { ok: true, detail: env };
    say('Have the OS passkey prompt ready. Four approvals are coming; each is announced first. Do not touch the window.');

    // ---- prompts 1 + 2
    front();
    say('>>> PROMPTS 1 and 2 of 4 coming: creating the passkey, then signing the new identity with it. Approve both.');
    const t0 = Date.now();
    const made = await ask(`window.keoIdentity.create({ label: 'Real desktop test' })`);
    say('create finished after ' + Math.round((Date.now() - t0) / 1000) + ' s');
    const A = made.r || {};
    check('create: succeeded on the real authenticator, for keo.test', !made.err && /^did:keo:/.test(A.did) && A.rpId === HOST && A.authorityKeys === 1 && A.notRecoverable === true, made);
    if (!A.did) { say('create failed, so the later steps are skipped.'); throw new Error('create failed'); }
    say('DID: ' + A.did + '   attachment: ' + A.authenticatorAttachment + '   transports: ' + JSON.stringify(A.transports) + '   PRF at create: ' + A.prfAtCreate);
    say('focus diagnostics for the create ceremonies: ' + JSON.stringify(A.diag));
    results.authenticator = { ok: true, detail: { attachment: A.authenticatorAttachment, transports: A.transports, prfAtCreate: A.prfAtCreate } };
    results.createDiag = { ok: true, detail: A.diag };

    const stored = await run(`(async function (did) {
      var kd = window.keoDid;
      var rec = await new Promise(function (res, rej) { var q = indexedDB.open('keo-identities'); q.onsuccess = function () { var r = q.result.transaction('identities').objectStore('identities').get(did); r.onsuccess = function () { q.result.close(); res(r.result); }; r.onerror = function () { rej(r.error); }; }; q.onerror = function () { rej(q.error); }; });
      if (!rec) return { missing: true };
      var v = await kd.verifyInception({ inception: rec.inception, sigs: rec.sigs });
      var a = rec.sigs.authority[0], cd = JSON.parse(new TextDecoder().decode(kd.unb64u(a.clientDataJSON))), ad = kd.unb64u(a.authenticatorData);
      return { verify: v, origin: cd.origin, type: cd.type, flags: ad[32], rpIdHashMatches: kd.b64u(ad.slice(0, 32)) === kd.b64u(await kd.sha256(new TextEncoder().encode(rec.rpId))),
        wrappedLen: kd.unb64u(rec.wrappedAccountSecret).length, deviceExtractable: rec.deviceKey.privateKey.extractable, discExtractable: rec.discoveryKey.extractable };
    })(${JSON.stringify(A.did)})`);
    check('stored: the inception, signed by the REAL passkey, verifies on its own and defines this DID', !!(stored.verify && stored.verify.ok && stored.verify.did === A.did), stored);
    check('stored: the assertion names https://keo.test, is a webauthn.get, and its rpIdHash matches keo.test', stored.origin === ORIGIN && stored.type === 'webauthn.get' && stored.rpIdHashMatches === true, stored);
    check('stored: user-present and user-verified flags set', (stored.flags & 0x01) === 1 && (stored.flags & 0x04) === 4, stored.flags);
    check('stored: wrapped secret 40 bytes, device and discovery keys non-extractable', stored.wrappedLen === 40 && stored.deviceExtractable === false && stored.discExtractable === false, stored);

    // ---- prompt 3
    await run('window.keoIdentity.signOut()'); front();
    say('>>> PROMPT 3 of 4 coming: signing in. Approve it.');
    const si = await ask(`window.keoIdentity.signIn({ did: ${JSON.stringify(A.did)} })`);
    say('focus diagnostics: ' + JSON.stringify(si.r && si.r.diag));
    check('signIn: works with the real authenticator (PRF unwrap, secret non-extractable, assertion names keo.test)', !si.err && si.r.secretNonExtractable === true && si.r.assertionOrigin === ORIGIN, si);

    // ---- prompt 4, after loading the page again (the identity must come back from the app's own storage)
    await wc.loadURL(ORIGIN + '/');
    await poll(() => run('!!(window.keoIdentity && window.keoIdentity.list)'));
    const list = await run('window.keoIdentity.list().then(function (l) { return l.map(function (x) { return x.did; }); })');
    check('reload: the identity is still listed', Array.isArray(list) && list.length === 1 && list[0] === A.did, list);
    front();
    say('>>> PROMPT 4 of 4 coming: signing in again after the page was loaded again. Approve it.');
    const si2 = await ask(`window.keoIdentity.signIn({ did: ${JSON.stringify(A.did)} })`);
    say('focus diagnostics: ' + JSON.stringify(si2.r && si2.r.diag));
    check('signIn after reload: works, and the PRF output unwraps the same secret', !si2.err && si2.r.secretNonExtractable === true, si2);
    check('no console errors from the shell or the package', errors.length === 0, errors);
  } catch (e) {
    check('the run completed', false, String(e && e.message || e));
  }
  fs.writeFileSync(path.join(path.resolve(WORK), 'real-desktop.json'), JSON.stringify(results, null, 2));
  const failed = Object.keys(results).filter((k) => !results[k].ok);
  say(failed.length ? 'FAILED: ' + failed.length + ' (' + failed.join('; ') + ')' : 'ALL PASSED (' + Object.keys(results).length + ')');
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
