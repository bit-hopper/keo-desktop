// What the desktop app answers when a page asks for something at its own address: which file of the package a request path means,
// what type to call it, and the headers every answer carries. Pure functions over strings and the package's desktop.json: no
// desktop runtime, no network, so the rules can be tested in plain node (test/serve-test.js).
//
// What this must not be used for: serving anything outside the package folder. resolveInside is the only way a request path becomes
// a file path, and it refuses everything it cannot account for rather than trying to repair it.
const path = require('path');

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  map: 'application/json; charset=utf-8'
};
const typeOf = (rel) => MIME[(rel.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

// A request path ('/core/lively/Foo.js', '/' for the shell page) -> { file, rel } inside `root`, or null. Refused: a path that does not
// decode, a NUL, a backslash (a second kind of separator on some systems), '.' and '..' segments, and any segment that starts with a dot
// (the builder's marker, hidden files). The result is checked to sit under root once resolved, as a last line.
function resolveInside(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath)); } catch (e) { return null; }
  if (p.indexOf('\0') !== -1 || p.indexOf('\\') !== -1) return null;
  if (p === '/' || p === '') p = '/start.html';
  const segs = p.replace(/^\/+/, '').split('/');
  for (const s of segs) if (s === '' || s === '.' || s === '..' || s[0] === '.') return null;
  const rel = segs.join('/'), file = path.resolve(root, rel), base = path.resolve(root) + path.sep;
  if (file.indexOf(base) !== 0) return null;
  return { file, rel };
}

// The package says which pages are sandboxed and what policy the shell pages and the sandboxed pages run under (desktop.json,
// written by the build). The host takes the origin from its own constant, never from the package: the origin is the address
// identities are made on, so a package cannot move it. A policy that would weaken the shell is refused here too.
function readPolicy(doc, host) {
  const bad = (m) => { throw new Error('desktop.json: ' + m); };
  if (!doc || typeof doc !== 'object' || doc.v !== 1) bad('not a version 1 document');
  if (doc.host !== host || doc.origin !== 'https://' + host) bad('this package is for ' + doc.origin + ', not https://' + host);
  const csp = doc.csp || {};
  if (typeof csp.shell !== 'string' || typeof csp.world !== 'string') bad('the two page policies are missing');
  if (/'unsafe-(eval|inline)'/.test(csp.shell) || !/script-src 'self'/.test(csp.shell)) bad('the shell policy must allow scripts from the package only');
  if (!/^sandbox\b/.test(csp.world)) bad('the world policy must start with sandbox');
  const pages = Array.isArray(doc.sandboxedPages) ? doc.sandboxedPages : bad('sandboxedPages is missing');
  for (const x of pages) if (typeof x !== 'string' || !/^[A-Za-z0-9._-]+\.html$/.test(x)) bad('a sandboxed page name is not valid');
  const hosts = Array.isArray(doc.catalogHosts) ? doc.catalogHosts : [];
  for (const h of hosts) if (typeof h !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(h)) bad('a catalogue host is not valid');
  return { origin: doc.origin, shellCsp: csp.shell, worldCsp: csp.world, sandboxed: new Set(pages), catalogHosts: new Set(hosts), version: String(doc.version || '') };
}

// The headers of an answer for package file `rel`. Every file is public code, so the sandboxed world page (an opaque origin, which
// the browser treats as cross-origin to everything) may read it: that is why access-control-allow-origin is *. Nothing private is
// ever served from here; the identity's data lives in the page's own storage.
function headersFor(rel, policy) {
  const h = {
    'content-type': typeOf(rel), 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache',
    'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin'
  };
  if (/\.html$/.test(rel)) h['content-security-policy'] = policy.sandboxed.has(rel) ? policy.worldCsp : policy.shellCsp;
  return h;
}

module.exports = { resolveInside, readPolicy, headersFor, typeOf };
