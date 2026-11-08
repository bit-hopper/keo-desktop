// What the app lets a page ask the OS for: the camera and microphone for the shell page (calls), and nothing else; and whether the sandboxed world
// page can reach them (it must not: calls are drawn and run by the shell). Fake media devices stand in for a camera and a microphone, so no real
// device is touched and nothing needs a person.
//
//   node scripts/run-electron.js scripts/permissions.js --package <desktop package> --work <scratch folder>
//   add  --real-devices  to use the machine's own camera and microphone instead (the camera light comes on for a moment): a person should
//                        be present; it reports the devices it found and whether a stream opened, and checks nothing about permissions.
//   add  --hold <seconds>  (with --real-devices) to keep the camera and microphone open that long, show the picture in the window, and report
//                        the tracks, the picture size, how many frames arrived and the loudest sample the microphone gave.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PKG = arg('--package'), WORK = arg('--work'), REAL = process.argv.includes('--real-devices'), HOLD = Number(arg('--hold')) || 0;
if (!PKG || !WORK) { console.error('usage: scripts/permissions.js --package <desktop package> --work <scratch folder> [--real-devices]'); process.exit(2); }
const userData = path.join(path.resolve(WORK), 'userdata-permissions');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
if (!REAL) app.commandLine.appendSwitch('use-fake-device-for-media-stream');   // no 'use-fake-ui...': the app's own permission handler must decide

const { start, ORIGIN } = require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 500) : '')); }

// a page-side helper: runs an async body and answers { r } or { err: name }
const wrap = (body) => `(async function(){ try { return { r: await (async function(){ ${body} })() }; } catch (e) { return { err: (e && e.name) + ': ' + (e && e.message) }; } })()`;
const GUM = (c) => wrap(`var s = await navigator.mediaDevices.getUserMedia(${c}); var k = s.getTracks().map(function (t) { return t.kind; }); s.getTracks().forEach(function (t) { t.stop(); }); return k;`);

app.whenReady().then(async () => {
  const { win } = await start({ packageDir: PKG, devtools: false });
  const wc = win.webContents;
  const shell = (code) => wc.executeJavaScript(code, true);
  const poll = async (fn, ms) => { for (let t = 0; t < (ms || 30000); t += 300) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(300); } return null; };
  const worldFrame = () => wc.mainFrame.framesInSubtree.find((f) => /world\.html$/.test(f.url));
  try {
    await poll(() => shell('!!(window.keoIdentity && window.keoCall)'));
    check('the shell has its call module', !!(await shell('!!window.keoCall')));
    await poll(async () => { const f = worldFrame(); return f && await f.executeJavaScript('!!(window.$world && window.keo && window.keo.init)'); }, 90000);

    if (REAL) {
      const devs = await shell(wrap(`var d = await navigator.mediaDevices.enumerateDevices(); return d.map(function (x) { return x.kind + ': ' + (x.label || '(no label)'); });`));
      console.log('devices the shell page sees: ' + JSON.stringify(devs));
      const v = await shell(GUM('{ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 } } }'));
      console.log('camera and microphone stream: ' + JSON.stringify(v));
      if (HOLD) {
        // keep the camera on and show it in the app window, so a person can see the light and the picture; count the frames that really arrive
        const h = await shell(wrap(`
          var s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 } } });
          var el = document.createElement('video'); el.muted = true; el.autoplay = true; el.playsInline = true; el.srcObject = s;
          el.style.cssText = 'position:fixed;right:16px;bottom:16px;width:320px;z-index:2147483647;border:3px solid #2f9e5b;background:#000';
          document.body.appendChild(el); await el.play();
          var frames = 0; var cb = function () { frames++; el.requestVideoFrameCallback(cb); }; el.requestVideoFrameCallback(cb);
          var ac = new AudioContext(); var an = ac.createAnalyser(); ac.createMediaStreamSource(s).connect(an); var buf = new Uint8Array(an.fftSize); var peak = 0;
          var t0 = Date.now(); while (Date.now() - t0 < ${HOLD * 1000}) { await new Promise(function (r) { setTimeout(r, 100); }); an.getByteTimeDomainData(buf); for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128)); }
          var out = { tracks: s.getTracks().map(function (t) { return { kind: t.kind, label: t.label, state: t.readyState, muted: t.muted }; }), size: el.videoWidth + 'x' + el.videoHeight, frames: frames, secs: ${HOLD}, micPeak: peak };
          s.getTracks().forEach(function (t) { t.stop(); }); el.remove(); ac.close(); return out;`));
        console.log('held ' + HOLD + ' s: ' + JSON.stringify(h));
      }
      const a = await shell(GUM('{ audio: true, video: false }'));
      console.log('microphone only: ' + JSON.stringify(a));
      app.exit(0); return;
    }

    // ---- the shell page: the call's own constraints
    const both = await shell(GUM('{ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } }'));
    check('the shell page gets a camera and a microphone', !both.err && both.r.indexOf('audio') !== -1 && both.r.indexOf('video') !== -1, both);
    const audio = await shell(GUM('{ audio: true, video: false }'));
    check('and a microphone alone (the audio call)', !audio.err && audio.r.length === 1 && audio.r[0] === 'audio', audio);
    const devs = await shell(wrap(`var d = await navigator.mediaDevices.enumerateDevices(); return d.map(function (x) { return x.kind; });`));
    check('and sees the devices', !devs.err && devs.r.indexOf('videoinput') !== -1 && devs.r.indexOf('audioinput') !== -1, devs);

    // ---- the sandboxed world page: the calls are the shell's, so the world must not reach the devices
    const wf = worldFrame();
    const w = wf ? await wf.executeJavaScript(GUM('{ audio: true, video: true }')) : { err: 'no world frame' };
    check('the sandboxed world page does NOT get a camera or microphone', !!w.err && !w.r, w);
    console.log('  world page getUserMedia answer: ' + JSON.stringify(w));

    // ---- everything else the page could ask the OS for is refused
    const geo = await shell(wrap(`return await new Promise(function (res) { navigator.geolocation.getCurrentPosition(function () { res('granted'); }, function (e) { res('denied code ' + e.code); }, { timeout: 5000 }); });`));
    check('location is refused', !geo.err && /^denied code 1$/.test(geo.r), geo);
    const note = await shell(wrap(`return typeof Notification === 'undefined' ? 'none' : await Notification.requestPermission();`));
    check('notifications are not granted', !note.err && note.r !== 'granted', note);
    const read = await shell(wrap(`return await navigator.clipboard.readText();`));
    check('reading the clipboard is refused', !!read.err, read);
    const midi = await shell(wrap(`return await navigator.requestMIDIAccess ? (await navigator.requestMIDIAccess()).inputs.size : 'none';`));
    check('midi is refused', !!midi.err || midi.r === 'none', midi);

    // ---- copying a code: the enroll dialog writes with navigator.clipboard and falls back to a copy command; at least one must work from a click
    const wr = await shell(wrap(`await navigator.clipboard.writeText('keo-test-copy'); return 'written';`));
    const cmd = await shell(wrap(`var t = document.createElement('textarea'); t.value = 'keo-test-copy-2'; document.body.appendChild(t); t.select(); var ok = document.execCommand('copy'); t.remove(); return ok;`));
    console.log('  clipboard.writeText from a click: ' + JSON.stringify(wr) + '   execCommand copy: ' + JSON.stringify(cmd));
    check('a code can be copied from a click with the clipboard call itself', !wr.err && wr.r === 'written', wr);
    check('and with the copy command the dialog falls back to', !cmd.err && cmd.r === true, cmd);
  } catch (e) {
    failed++; console.log('FAIL the run crashed: ' + (e && e.stack || e));
  }
  console.log(passed + ' passed, ' + failed + ' failed   (fake media devices)');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
