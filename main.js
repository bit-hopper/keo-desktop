// keo for the desktop: a window that runs a built keo package on its own address, https://keo.test, answered inside the app (no socket,
// no certificate, no DNS: the name is reserved and never resolves). That kind of origin is one a passkey can be made on without a
// server, which file:// and a custom scheme are not (probes/passkey-electron.js found that out).
//
// The app is a small fixed host and a package folder it serves. The package is the folder `node extension/build.js <dir> --desktop`
// makes in the keo repo, so shell, world and runtime come from there and nothing of keo is kept in this repo. Replacing the package
// folder is how the app is updated without a reinstall (lib/update.js stages a signed release; app.js chooses which package to run).
//
// This file only exports start(); app.js is the entry that runs it (see there for why they are two files).
//   node scripts/run-electron.js . --package <folder>      run it (the script clears ELECTRON_RUN_AS_NODE, which some terminals export)
//   --devtools    open the developer tools in a window of their own
//
// The page has no access to node or to this process: the window is sandboxed, with context isolation, and there is no preload script.
const { BrowserWindow, protocol, session, net, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInside, readPolicy, headersFor } = require('./lib/serve.js');
const { createLan } = require('./lib/lan.js');

const HOST = 'keo.test';          // the address identities are made on: fixed here, never read from a package
const ORIGIN = 'https://' + HOST;

function parseArgs(argv) {
  const o = { packageDir: process.env.KEO_PACKAGE || null, devtools: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') o.packageDir = argv[++i];
    else if (argv[i] === '--devtools') o.devtools = true;
  }
  return o;
}

// Opens the window on the package. `opts`: { packageDir, devtools, menuTemplate }. Resolves to { win, root, policy }.
// `menuTemplate(getWin)` returns the app menu (the update entries, see lib/update-ui.js); without it there is no menu.
async function start(opts) {
  if (!opts.packageDir) throw new Error('No package given. Build one with `node extension/build.js <folder> --desktop` in the keo repo, then pass --package <folder>.');
  const root = path.resolve(opts.packageDir);
  let policy;
  try { policy = readPolicy(JSON.parse(fs.readFileSync(path.join(root, 'desktop.json'), 'utf8')), HOST); }
  catch (e) { throw new Error('That folder is not a desktop package of keo (' + (e && e.message) + '): ' + root); }
  if (!fs.existsSync(path.join(root, 'start.html'))) throw new Error('The package has no start.html: ' + root);

  // The local network (lib/lan.js), for the app's own page and for nothing else. There is no preload and no channel from a page to this
  // process, so the page asks by an ordinary request to one reserved path, and this process hands what arrives from the network to the
  // page by running one call in the page's main frame. The sandboxed world page can send a request to the same address, and nothing in
  // the request says which frame it came from (the origin and fetch-site headers are not visible here, and the browser does not make a
  // cross-origin page ask first), so a request is taken only with a secret that this process pushes into the shell page's MAIN frame and
  // that the page reads once and removes (shell/keo-lan.js). The world is a different, sandboxed frame: it cannot read the shell page's
  // variables, and no bridge op returns the secret. The page decides what any of it means.
  const lanToken = crypto.randomBytes(24).toString('base64url');
  let lan = null;
  const getLan = () => lan || (lan = createLan({
    onRequest: async (buf, ip) => {
      try {
        const frame = win && !win.isDestroyed() ? win.webContents.mainFrame : null;
        if (!frame) return null;
        const r = await frame.executeJavaScript('(window.keoLan && window.keoLan.inbound) ? window.keoLan.inbound(' + JSON.stringify(buf.toString('base64url')) + ', ' + JSON.stringify(ip) + ') : null', true);
        return typeof r === 'string' && r ? Buffer.from(r, 'base64url') : null;
      } catch (e) { return null; }
    }
  }));
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  async function lanRoute(req) {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
    const given = Buffer.from(req.headers.get('x-keo-host') || ''), want = Buffer.from(lanToken);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return new Response('forbidden', { status: 403 });
    let b;
    try { const text = await req.text(); if (text.length > 96 * 1024) return json({ error: 'too large' }, 413); b = JSON.parse(text); } catch (e) { return json({ error: 'bad request' }, 400); }
    try {
      if (b.op === 'hello') return json({ ok: true });
      if (b.op === 'start') return json(await getLan().start({ payload: b.payload == null ? null : b.payload }));
      if (b.op === 'stop') { if (lan) lan.stop(); return json({ ok: true }); }
      if (b.op === 'peers') return json({ peers: lan ? lan.peers() : [] });
      if (b.op === 'request') {
        if (!lan || typeof b.ip !== 'string' || !Number.isInteger(b.port) || typeof b.body !== 'string') return json({ error: 'bad request' }, 400);
        const reply = await lan.request(b.ip, b.port, Buffer.from(b.body, 'base64url'));
        return json({ reply: reply.toString('base64url') });
      }
    } catch (e) { return json({ error: String(e && e.message || e).slice(0, 200) }, 200); }
    return json({ error: 'unknown op' }, 400);
  }

  // One answer for everything at https://keo.test; any other address is passed on to the network untouched, except that a catalogue
  // site the package names may answer this page across origins (the extension has that as a host permission; shell/keo-catalog.js
  // asks for it, and only for that one site).
  protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.hostname === HOST && u.port === '' && u.pathname === '/.keo-host/lan') return lanRoute(req);
    if (u.hostname !== HOST) {
      const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
      if (!policy.catalogHosts.has(u.origin)) return res;
      const h = new Headers(res.headers); h.set('access-control-allow-origin', ORIGIN); h.append('vary', 'Origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    if (u.port !== '') return new Response('not found', { status: 404 });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    const hit = resolveInside(root, u.pathname);
    if (!hit) return new Response('not found', { status: 404 });
    let data;
    try { data = await fs.promises.readFile(hit.file); } catch (e) { return new Response('not found', { status: 404 }); }
    return new Response(req.method === 'HEAD' ? null : data, { status: 200, headers: headersFor(hit.rel, policy) });
  });

  // Two permissions, for the app's own page and for no frame inside it: the camera and microphone (calls are the shell's, drawn and run by
  // the page itself) and writing a copied code to the clipboard (a click in a dialog). Reading the clipboard, location, notifications and the
  // rest are refused. The sandboxed world page is a frame, so it gets neither, whatever the browser would decide for it.
  const GRANTED = { media: true, 'clipboard-sanitized-write': true };
  const ses = session.defaultSession;
  const fromApp = (url) => { try { return new URL(url).origin === ORIGIN; } catch (e) { return false; } };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(!!GRANTED[permission] && details.isMainFrame === true && fromApp(details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) => !!GRANTED[permission] && details.isMainFrame === true && fromApp(origin));

  const win = new BrowserWindow({
    width: 1280, height: 860, title: 'keo', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  if (!opts.devtools) Menu.setApplicationMenu(opts.menuTemplate ? Menu.buildFromTemplate(opts.menuTemplate(() => win)) : null);
  const wc = win.webContents;
  // The window stays on the app's own address. A link out opens nothing (a world can ask for a pop-up; the app does not follow it).
  wc.on('will-navigate', (e, url) => { if (!fromApp(url)) e.preventDefault(); });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The page asks "Leave site?" when it has something unsaved. In this shell a page that stops the unload also stops the window from
  // closing, so the question is put here; the page's own flows that reload on purpose lift the warning first (keoPrepareToLeave).
  wc.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, message: 'Leave keo?', detail: 'Changes that are not saved may be lost.' });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { if (lan) lan.close(); });
  // The secret goes to the main frame of the app's own page each time its document is ready (a reload makes a new document), and to no other frame.
  wc.on('dom-ready', () => {
    if (!fromApp(wc.mainFrame.url)) return;
    wc.mainFrame.executeJavaScript('window.__keoHostToken = ' + JSON.stringify(lanToken) + ';', true).catch(() => {});
  });
  await win.loadURL(ORIGIN + '/');
  if (opts.devtools) wc.openDevTools({ mode: 'detach' });
  return { win, root, policy };
}

module.exports = { start, parseArgs, HOST, ORIGIN };
