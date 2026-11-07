// The rules for what the app serves, in plain node (no desktop runtime, no browser): node test/serve-test.js
const path = require('path');
const { resolveInside, readPolicy, headersFor, typeOf } = require('../lib/serve.js');
let passed = 0, failed = 0;
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 300) : '')); }
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const root = path.resolve(path.join(__dirname, '..', 'fixture-root'));   // never touched: only paths are computed
const ok = (p) => resolveInside(root, p);

check('"/" is the shell page', ok('/') && ok('/').rel === 'start.html');
check('a file in a folder', ok('/core/lively/Foo.js') && ok('/core/lively/Foo.js').rel === 'core/lively/Foo.js');
check('the resolved file sits under the root', ok('/a/b.js').file.indexOf(root + path.sep) === 0);
check('a percent-escaped name is decoded once', ok('/a%20b.js') && ok('/a%20b.js').rel === 'a b.js');
for (const bad of ['/../x', '/a/../../x', '/a/..', '/%2e%2e/x', '/a/%2e%2e/%2e%2e/x', '/..%2fx', '/a%5c..%5cx', '/a\\b', '/a%00.js', '/.keo-world-build', '/a/.hidden', '/a//b', '/a/./b', '/%zz', '//x//']) {
  check('refused: ' + bad, ok(bad) === null, ok(bad));
}
check('a double-encoded dot-dot is NOT decoded twice (it is just a name)', ok('/%252e%252e/x') && ok('/%252e%252e/x').rel === '%2e%2e/x');

check('types', typeOf('a.js').startsWith('text/javascript') && typeOf('a.wasm') === 'application/wasm' && typeOf('a.woff2') === 'font/woff2' && typeOf('a.unknown') === 'application/octet-stream' && typeOf('noext') === 'application/octet-stream');

const doc = () => ({ v: 1, origin: 'https://keo.test', host: 'keo.test', version: '1.2.3',
  csp: { shell: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'", world: "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval'" },
  sandboxedPages: ['world.html'], catalogHosts: ['https://itunes.apple.com'] });
const pol = readPolicy(doc(), 'keo.test');
check('a good document is read', pol.origin === 'https://keo.test' && pol.sandboxed.has('world.html') && pol.catalogHosts.has('https://itunes.apple.com') && pol.version === '1.2.3', pol);
const mut = (f) => { const d = doc(); f(d); return throws(() => readPolicy(d, 'keo.test')); };
check('a package for another origin is refused', /not https:\/\/keo.test/.test(mut((d) => { d.host = 'evil.test'; d.origin = 'https://evil.test'; })));
check('a package whose origin and host disagree is refused', !!mut((d) => { d.origin = 'https://evil.test'; }));
check('a shell policy that allows eval is refused', /scripts from the package only/.test(mut((d) => { d.csp.shell = "script-src 'self' 'unsafe-eval'"; })));
check('a shell policy that allows inline script is refused', !!mut((d) => { d.csp.shell = "script-src 'self' 'unsafe-inline'"; }));
check('a shell policy with no script-src self is refused', !!mut((d) => { d.csp.shell = "default-src *"; }));
check('a world policy that is not a sandbox is refused', /start with sandbox/.test(mut((d) => { d.csp.world = "script-src 'self'"; })));
check('a missing policy is refused', !!mut((d) => { delete d.csp.world; }));
check('a sandboxed page name with a path is refused', !!mut((d) => { d.sandboxedPages = ['../x.html']; }));
check('a catalogue host with a path is refused', !!mut((d) => { d.catalogHosts = ['https://a.test/x']; }));
check('a catalogue host over http is refused', !!mut((d) => { d.catalogHosts = ['http://a.test']; }));
check('not a document', !!throws(() => readPolicy(null, 'keo.test')) && !!throws(() => readPolicy({ v: 2 }, 'keo.test')));

const hw = headersFor('world.html', pol), hs = headersFor('start.html', pol), hj = headersFor('core/a.js', pol);
check('the world page gets the sandbox policy', /^sandbox/.test(hw['content-security-policy']));
check('every other page gets the shell policy', hs['content-security-policy'] === pol.shellCsp && hs['content-type'].startsWith('text/html'));
check('a script has no page policy but is readable from the sandbox and not sniffed', hj['content-security-policy'] === undefined && hj['access-control-allow-origin'] === '*' && hj['x-content-type-options'] === 'nosniff');
check('nothing is cached without asking', hs['cache-control'] === 'no-cache');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
