// What a person sees of updating: a small native menu (hidden until the menu key is pressed) with "Apply a release ...", "Go back to the
// previous version" and "About keo", and the questions each puts. The rules themselves are in update.js.
//
// This is a native menu and native boxes on purpose: the page has no way to reach the files of the app (it has no preload script and no
// channel to this process), and giving it one to draw these in the world would be a hole in the wall between a page and the machine.
//
// `dialog`, `restart` and `log` are passed in so a script can answer the questions and watch the restart without a person (scripts/update.js).
// What this must not be used for: starting a release from anywhere but update.js's staged folders.
const path = require('path');
const fs = require('fs');
const upd = require('./update.js');

const say = (m) => String(m && m.message || m);

// ctx: { dialog, userData, verifierDir, current: { version, name, source }, explicit: <true when the package was named on the command line>,
//        restart(): relaunches the app, log(line) }
function makeFlows(ctx) {
  const box = (win, o) => ctx.dialog.showMessageBox(win, Object.assign({ noLink: true }, o));
  const refuse = async (win, title, e) => { ctx.log && ctx.log('refused: ' + say(e)); await box(win, { type: 'error', buttons: ['OK'], title: 'keo', message: title, detail: say(e) }); return { status: 'refused', reason: say(e) }; };

  async function applyRelease(win) {
    if (ctx.explicit) return refuse(win, 'Updating is off', new Error('This run was given a package on the command line, so a release applied now would not be the one that starts next time.'));
    let verifier;
    try { verifier = await upd.loadVerifier(ctx.verifierDir); } catch (e) { return refuse(win, 'This app cannot take updates', e); }
    const pick = await ctx.dialog.showOpenDialog(win, { title: 'Choose a release folder', message: 'Choose the folder that holds release.json and the package', properties: ['openDirectory'], buttonLabel: 'Choose' });
    if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { status: 'cancelled' };
    let read;
    try { read = await upd.readRelease(pick.filePaths[0], verifier, ctx.current.version); } catch (e) { return refuse(win, 'That release cannot be applied', e); }
    const n = Object.keys(read.manifest.files).length;
    const ask = await box(win, {
      type: 'question', buttons: ['Apply and restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'keo',
      message: 'Apply release ' + read.manifest.version + ' (' + read.manifest.name + ')?',
      detail: 'It is signed by the key this app trusts and replaces what is running now (' + ctx.current.name + ', release ' + ctx.current.version + '). It has ' + n + ' files. keo restarts to use it, and "Go back to the previous version" returns to what you have now.'
    });
    if (ask.response !== 0) return { status: 'cancelled' };
    let entry;
    try { entry = await upd.stageRelease(ctx.userData, read, verifier); } catch (e) { return refuse(win, 'That release was not applied', e); }
    ctx.log && ctx.log('applied release ' + entry.version);
    ctx.restart();
    return { status: 'applied', entry };
  }

  async function goBack(win) {
    if (ctx.explicit) return refuse(win, 'Updating is off', new Error('This run was given a package on the command line.'));
    const state = upd.readState(ctx.userData);
    if (!state.active) return refuse(win, 'Nothing to go back to', new Error('The package that came with the app is running.'));
    const to = state.previous ? 'release ' + state.previous.version + ' (' + state.previous.name + ')' : 'the package that came with the app';
    const ask = await box(win, {
      type: 'question', buttons: ['Go back and restart', 'Cancel'], defaultId: 1, cancelId: 1, title: 'keo',
      message: 'Go back to ' + to + '?', detail: 'Release ' + state.active.version + ' (' + state.active.name + ') is removed from this computer. To use it again you need its folder. Your identities and data stay as they are.'
    });
    if (ask.response !== 0) return { status: 'cancelled' };
    let r;
    try { r = upd.rollBack(ctx.userData); } catch (e) { return refuse(win, 'Could not go back', e); }
    ctx.log && ctx.log('went back from release ' + r.from.version);
    ctx.restart();
    return { status: 'rolled-back', from: r.from, to: r.to };
  }

  async function about(win) {
    let built = '';
    try { built = JSON.parse(fs.readFileSync(path.join(ctx.packageDir || '', 'keo-build.json'), 'utf8')); } catch (e) { built = null; }
    const lines = ['Running: ' + ctx.current.name + (ctx.current.version ? ', release ' + ctx.current.version : '')];
    if (built && built.version) lines.push('Package: ' + built.version + (built.kernel && built.kernel.commit ? ', runtime ' + String(built.kernel.commit).slice(0, 7) : ''));
    lines.push('Address: https://keo.test');
    await box(win, { type: 'info', buttons: ['OK'], title: 'keo', message: 'keo', detail: lines.join('\n') });
    return { status: 'shown', lines };
  }
  return { applyRelease, goBack, about };
}

// The menu, for Menu.buildFromTemplate. `getWin` is the window to attach the boxes to.
function menuTemplate(ctx, flows, getWin) {
  const off = !!ctx.explicit;
  return [{
    label: 'keo',
    submenu: [
      { label: 'About keo', click: () => flows.about(getWin()) },
      { type: 'separator' },
      { label: off ? 'Apply a release ... (off: a package was named on the command line)' : 'Apply a release ...', enabled: !off, click: () => flows.applyRelease(getWin()) },
      { label: 'Go back to the previous version', enabled: !off, click: () => flows.goBack(getWin()) },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ]
  }];
}

module.exports = { makeFlows, menuTemplate };
