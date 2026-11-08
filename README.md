# keo-desktop

keo for the desktop: the keo runtime in a window of its own, with no backend. Identity, keys and worlds live on the device.

Status: prototype. It opens a built keo package in a window; the identity, world and storage were run against a virtual authenticator and, for create, sign-in and linking, against a real one. It can be packed as a folder (and a zip) to unzip and run, and it applies a signed release you already have from its menu. It is not signed, has no installer, and does not fetch updates from anywhere.

## How it fits together

This repo is a small fixed host: a window, and a server for one address. Everything keo is comes from a **package folder** built in the keo repo:

```
node extension/build.js <folder> --desktop        # in the keo repo
```

`--desktop` builds the same shell, world and runtime as the browser extension, for the address `https://keo.test`, with no manifest, popup or icons, and a `desktop.json` that says which pages are sandboxed and what policy each kind of page runs under. Nothing of keo is kept in this repo.

The app answers `https://keo.test` itself, from the package, with no socket, certificate or DNS (the name is reserved and never resolves). That kind of address is one a passkey can be made on without a server. The address is the passkey's rpId, so it is fixed in `main.js` and a package cannot change it: identities made here belong to it for good.

Because the app serves the package, replacing the package folder is how the app is updated without a reinstall: see "Releases" below.

What the host does, and what it refuses:

- serves only files of the package, by a path check that refuses `..`, hidden names, backslashes and anything that does not decode;
- GET and HEAD only; the shell pages run under a policy that allows scripts from the package only, and `world.html` runs sandboxed (an opaque origin) under its own;
- keeps the window on its own address, opens no pop-ups, and asks "Leave keo?" itself when a page has unsaved changes;
- allows two permissions, to the app's own page and to no frame inside it: the camera and microphone (calls are the page's), and writing a copied code to the clipboard. Reading the clipboard, location, notifications and the rest are refused, and the sandboxed world page gets neither;
- passes any other address on to the network untouched, except that the one catalogue site the package names may answer the shell page across origins;
- gives the shell page, and nothing else, a way onto the local network (`lib/lan.js`): it listens for short multicast announcements and announces the signed-in person when they are visible, and it carries one request and its reply over TCP to a device that announced itself. It knows no keys and decides nothing: the page makes and checks every request (keo's `shell/keo-lan.js`). Only private IPv4 addresses are used, sizes and rates are capped, and a request goes only to an address and port announced in the last twenty seconds. The page reaches it by a POST to `/.keo-host/lan` on its own address; because the sandboxed world page can send requests to that address too and the request does not say which frame it came from, the app pushes a random secret into the shell page's main frame (read once, then removed) and answers 403 without it.

## Running

```
npm install
node node_modules/electron/install.js                   # npm does not always fetch the binary
node scripts/run-electron.js . --package <folder>       # --devtools opens the developer tools
```

`scripts/run-electron.js` starts the app with `ELECTRON_RUN_AS_NODE` removed from the child's environment: some terminals export it, and with it set the binary behaves as plain node. `app.js` is the entry and `main.js` only exports what it uses; they are two files because `require.main === module` is false for the entry module in this runtime, so a check of that kind never starts the app. The app keeps its storage under the user's application-data folder in `keo` (`KEO_USER_DATA` overrides it); a second instance hands over to the first.

## Packing

```
node scripts/pack.js --package <built desktop package> --out <new folder> [--update-key <file>] [--bundled-version <n>] [--zip]
```

Makes `<out>/app/keo-<system>-<arch>/` (run `keo` in it) and, with `--zip`, `<out>/keo-<system>-<arch>.zip`. The folder holds the desktop runtime, the host (`app.js`, `main.js`, `lib/`, without the tests or probes) in an archive, and the package it serves as `resources/keo-package`. It is made for the system it runs on. The runtime comes from the packager's download cache at the version pinned in `package.json`.

It is not signed: no code-signing certificate exists yet, so the system warns on the first run. **An installer is needed before anything is deployed** (it needs that certificate); the zipped folder is for trying the app and for handing it to people who know why it warns.

The update key is the public half of the key releases are signed with (`update-key.json`, from `node extension/sign-release.js keygen` in the keo repo, made offline). `--update-key` names it; without that option the one inside the package is used, and a build with neither takes no updates and says so. The app keeps its own copy of the key and of the code that checks signatures (`verify/` in its archive); it never uses the ones in a package or a release, because a package must not be the only thing vouching for its own verifier.

## Releases

A release folder holds `release.json` (the signed list the keo repo's `sign-release.js` writes) and `package/` (the built desktop package it describes, every file):

```
node extension/build.js <out>/package --desktop            # in the keo repo
node extension/sign-release.js sign <out>/package --key <key file> --version <n> --name <label> --out <out>/release.json
```

In the app, press the menu key (Alt) and choose **keo > Apply a release ...**, then pick the folder. The app checks the signature against its own key, that the release is newer than the one running (the package that came with the app counts as release 0 unless it was packed with `--bundled-version`), and then that the folder holds exactly the files the signed list names with the sizes and hashes it gives; each file is checked as it is copied, so what was checked is what is kept. Nothing runs from the release folder. If any check fails, nothing is kept and the reason is shown. When it passes the app asks once, copies the package into its data folder (`releases/`), and restarts on it. **keo > Go back to the previous version** returns to the release before (or to the package that came with the app) and removes the one it leaves; the two most recent releases are kept at most. Identities and data are not touched by either: they belong to the address (`keo.test`), not to the package.

If the release in use is later found damaged or missing a file, the app starts on the one before, or on the package it came with, and says so. A package named on the command line (`--package`) always wins and turns the menu entries off, since a release applied then would not be the one that starts next time.

Not built yet: fetching a release from an address (the plan is the project's repository releases page), a zip as the release (a folder is what is read), and updating the host itself (the code in `app.js`, `main.js` and `lib/` and the desktop runtime change only with a new pack).

## Tests

```
npm run test:serve                                       # no window: the serving rules, 37 checks
node test/entry-test.js <folder> <scratch folder>        # starts the app by its own entry (app.js), as a person does: a window on keo.test, a second start hands over, a bad package is refused with a reason
node scripts/run-electron.js scripts/smoke.js --package <folder> --work <scratch folder>
```

The smoke script opens the app on a built package with a virtual authenticator and checks: the address, the sandbox of the world, the policy headers and the refusals, an identity made and signed in again for `keo.test`, storage kept across a reload, the window staying put, and that no request leaves the app. A virtual authenticator shows none of the focus or prompt-timing problems a real one can, so this says nothing about a real one.

```
node test/update-test.js <built desktop package> <scratch folder>         # no window: reading, staging, refusing and going back, and the questions put to the person (answered from the test), 62 checks
node test/update-entry-test.js <built desktop package> <scratch folder>   # the app started by its entry: which package the window serves after a release, going back, a damaged release, a package named on the command line, 11 checks
node test/packed-test.js <built desktop package> <scratch folder>         # packs the app and starts the packed executable: the package inside, the key inside, a release applied and undone, 12 checks (about two minutes)
```

The update tests make their own signing key and small made-up packages (the built package is used for its verifier code and, in the second test, as the package that is served); no real key is involved. The menu itself and the native folder and question boxes are not driven: the same functions are called with the questions answered from the test, so how they look and read is for a person to see.

```
node scripts/run-electron.js scripts/permissions.js --package <folder> --work <scratch folder>   # fake camera and microphone: who gets them, what is refused, that copying works
node scripts/run-electron.js scripts/dialogs.js --package <folder> --work <scratch folder>       # the link dialog's Copy and Save as file by real clicks, and the "Leave keo?" question
```

```
node test/lan-test.js                                                                         # the network part alone, in plain node, on this machine's real interfaces: two instances find each other and pass a request, bad sockets are cut, 22 checks
node scripts/lan.js --package <folder> --work <scratch folder> --playwright <keo repo folder> # TWO apps on one machine, virtual authenticators: found only when a friend, declined when not added, dialed by key both ways, a repeated request refused, the sandboxed world locked out, 28 checks
```

`scripts/lan.js` adds friends with the contact book's own function, not through the dialog where two people compare eight words (that dialog is tested in the keo repo). Two apps on one machine share one network: it cannot show a packet crossing a real link, a router that isolates its clients, or a firewall that blocks the app. Known flake, cause not found: `test/update-entry-test.js` fails in some runs (the app as committed before the network work failed 5 of 8) on which page the debugging port lists.

The permissions script can also be pointed at the machine's own camera and microphone with `--real-devices` (the camera light comes on for a moment; it reports the devices and whether a stream opened, and checks nothing else). Add `--hold <seconds>` to keep the camera and microphone open that long: the picture shows in the window, and the script reports the tracks, the picture size, how many frames arrived and the loudest microphone sample.

Known flake, cause not found: in some runs of the fake-device permissions script the fake camera disappears part-way (the device list has no camera and a new camera request fails with "Requested device not found"), so "and sees the devices" fails. In such a run the check that the world page gets no camera also passes for the wrong reason, because it only requires an error. Repeat a failing run before drawing a conclusion. The dialogs script sets the save path and stubs the leave answer from the test, so it shows that the data reaches a file with the right name and content, that the clipboard holds the copied code, and that Leave and Stay are obeyed; how the native Save box and the leave box look and read is for a person to see.

```
node scripts/run-electron.js scripts/real.js --package <folder> --work <scratch folder>
```

That one uses a real authenticator and needs a person at the keyboard: four OS prompts (make the passkey, sign the identity, sign in, sign in again after a reload), each announced before it appears. It reports whether the window had focus at the start of each, and writes `real-desktop.json` to the scratch folder. The passkey it makes stays in the authenticator; delete "Real desktop test" for `keo.test` in the OS passkey settings afterwards.

## Licence

MIT.
