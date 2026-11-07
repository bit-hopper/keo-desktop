// keo for the desktop: a window that runs a built keo package on its own address, https://keo.test, answered inside the app (no socket,
// no certificate, no DNS: the name is reserved and never resolves). That kind of origin is one a passkey can be made on without a
// server, which file:// and a custom scheme are not (probes/passkey-electron.js found that out).
//
// The app is a small fixed host and a package folder it serves. The package is the folder `node extension/build.js <dir> --desktop`
// makes in the keo repo, so shell, world and runtime come from there and nothing of keo is kept in this repo. Replacing the package
// folder is how the app is updated without a reinstall (not built yet; see README).
//
// This file only exports start(); app.js is the entry that runs it (see there for why they are two files).
//   node scripts/run-electron.js . --package <folder>      run it (the script clears ELECTRON_RUN_AS_NODE, which some terminals export)
//   --devtools    open the developer tools in a window of their own
//
// The page has no access to node or to this process: the window is sandboxed, with context isolation, and there is no preload script.
const { BrowserWindow, protocol, session, net, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveInside, readPolicy, headersFor } = require('./lib/serve.js');

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

// Opens the window on the package. `opts`: { packageDir, devtools, userData }. Resolves to { win, root, policy }.
async function start(opts) {
  if (!opts.packageDir) throw new Error('No package given. Build one with `node extension/build.js <folder> --desktop` in the keo repo, then pass --package <folder>.');
  const root = path.resolve(opts.packageDir);
  let policy;
  try { policy = readPolicy(JSON.parse(fs.readFileSync(path.join(root, 'desktop.json'), 'utf8')), HOST); }
  catch (e) { throw new Error('That folder is not a desktop package of keo (' + (e && e.message) + '): ' + root); }
  if (!fs.existsSync(path.join(root, 'start.html'))) throw new Error('The package has no start.html: ' + root);

  // One answer for everything at https://keo.test; any other address is passed on to the network untouched, except that a catalogue
  // site the package names may answer this page across origins (the extension has that as a host permission; shell/keo-catalog.js
  // asks for it, and only for that one site).
  protocol.handle('https', async (req) => {
    const u = new URL(req.url);
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

  // Camera and microphone for calls, for the app's own address only; every other permission is refused.
  const ses = session.defaultSession;
  const fromApp = (url) => { try { return new URL(url).origin === ORIGIN; } catch (e) { return false; } };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(permission === 'media' && fromApp(details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && fromApp(origin));

  const win = new BrowserWindow({
    width: 1280, height: 860, title: 'keo', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  if (!opts.devtools) Menu.setApplicationMenu(null);
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
  await win.loadURL(ORIGIN + '/');
  if (opts.devtools) wc.openDevTools({ mode: 'detach' });
  return { win, root, policy };
}

module.exports = { start, parseArgs, HOST, ORIGIN };
