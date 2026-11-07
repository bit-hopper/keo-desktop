# keo-desktop

keo for the desktop: the keo runtime in a window of its own, with no backend. Identity, keys and worlds live on the device.

Status: prototype. It opens a built keo package in a window, and the identity, world and storage work against a virtual authenticator. It has not been run with a real authenticator, has no installer and cannot update itself yet.

## How it fits together

This repo is a small fixed host: a window, and a server for one address. Everything keo is comes from a **package folder** built in the keo repo:

```
node extension/build.js <folder> --desktop        # in the keo repo
```

`--desktop` builds the same shell, world and runtime as the browser extension, for the address `https://keo.test`, with no manifest, popup or icons, and a `desktop.json` that says which pages are sandboxed and what policy each kind of page runs under. Nothing of keo is kept in this repo.

The app answers `https://keo.test` itself, from the package, with no socket, certificate or DNS (the name is reserved and never resolves). That kind of address is one a passkey can be made on without a server. The address is the passkey's rpId, so it is fixed in `main.js` and a package cannot change it: identities made here belong to it for good.

Because the app serves the package, replacing the package folder is how the app will be updated without a reinstall. That is not built; the signed-release checks it will use are in the keo repo.

What the host does, and what it refuses:

- serves only files of the package, by a path check that refuses `..`, hidden names, backslashes and anything that does not decode;
- GET and HEAD only; the shell pages run under a policy that allows scripts from the package only, and `world.html` runs sandboxed (an opaque origin) under its own;
- keeps the window on its own address, opens no pop-ups, and asks "Leave keo?" itself when a page has unsaved changes;
- allows two permissions, to the app's own page and to no frame inside it: the camera and microphone (calls are the page's), and writing a copied code to the clipboard. Reading the clipboard, location, notifications and the rest are refused, and the sandboxed world page gets neither;
- passes any other address on to the network untouched, except that the one catalogue site the package names may answer the shell page across origins.

## Running

```
npm install
node node_modules/electron/install.js                   # npm does not always fetch the binary
node scripts/run-electron.js . --package <folder>       # --devtools opens the developer tools
```

`scripts/run-electron.js` starts the app with `ELECTRON_RUN_AS_NODE` removed from the child's environment: some terminals export it, and with it set the binary behaves as plain node. `app.js` is the entry and `main.js` only exports what it uses; they are two files because `require.main === module` is false for the entry module in this runtime, so a check of that kind never starts the app. The app keeps its storage under the user's application-data folder in `keo` (`KEO_USER_DATA` overrides it); a second instance hands over to the first.

## Tests

```
npm run test:serve                                       # no window: the serving rules, 37 checks
node test/entry-test.js <folder> <scratch folder>        # starts the app by its own entry (app.js), as a person does: a window on keo.test, a second start hands over, a bad package is refused with a reason
node scripts/run-electron.js scripts/smoke.js --package <folder> --work <scratch folder>
```

The smoke script opens the app on a built package with a virtual authenticator and checks: the address, the sandbox of the world, the policy headers and the refusals, an identity made and signed in again for `keo.test`, storage kept across a reload, the window staying put, and that no request leaves the app. A virtual authenticator shows none of the focus or prompt-timing problems a real one can, so this says nothing about a real one.

```
node scripts/run-electron.js scripts/permissions.js --package <folder> --work <scratch folder>   # fake camera and microphone: who gets them, what is refused, that copying works
node scripts/run-electron.js scripts/dialogs.js --package <folder> --work <scratch folder>       # the link dialog's Copy and Save as file by real clicks, and the "Leave keo?" question
```

The permissions script can also be pointed at the machine's own camera and microphone with `--real-devices` (the camera light comes on for a moment; it reports the devices and whether a stream opened, and checks nothing else). The dialogs script sets the save path and stubs the leave answer from the test, so it shows that the data reaches a file with the right name and content, that the clipboard holds the copied code, and that Leave and Stay are obeyed; how the native Save box and the leave box look and read is for a person to see.

```
node scripts/run-electron.js scripts/real.js --package <folder> --work <scratch folder>
```

That one uses a real authenticator and needs a person at the keyboard: four OS prompts (make the passkey, sign the identity, sign in, sign in again after a reload), each announced before it appears. It reports whether the window had focus at the start of each, and writes `real-desktop.json` to the scratch folder. The passkey it makes stays in the authenticator; delete "Real desktop test" for `keo.test` in the OS passkey settings afterwards.

## Licence

MIT.
