// Starts the desktop shell binary from node with the environment it needs.
// Why this exists: some terminals (an editor's integrated one among them) export ELECTRON_RUN_AS_NODE=1, and with it set the
// binary silently behaves as plain node ("Cannot read properties of undefined (reading 'whenReady')"). Only the child's
// environment is changed. Usage: node scripts/run-electron.js <args for the binary, e.g. the app folder>
const { spawn } = require('child_process');
const exe = require('electron');   // the package exports the path of the binary

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
