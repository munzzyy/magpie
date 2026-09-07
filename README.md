# Magpie

[![release](https://img.shields.io/github/v/release/munzzyy/magpie)](https://github.com/munzzyy/magpie/releases/latest) [![ci](https://github.com/munzzyy/magpie/actions/workflows/ci.yml/badge.svg)](https://github.com/munzzyy/magpie/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-17697a)](LICENSE)

A journal that can prove itself.

People document the disputes in their lives with a camera roll and a notes
app: the leak the landlord ignored, the messages that keep arriving, the
state the car came back in. Then months later it matters, and what they
have is a pile of files with shiftable dates that proves nothing about
when anything was written down.

Magpie is an incident journal with receipts. Every entry, a photo, a note,
a file, gets hashed together with the entry before it. Change one word
anywhere in the record, reorder it, delete something from the middle, and
the final hash stops matching. Everything is encrypted on your device with
your passphrase; locked means unreadable, including to the app.

The export is the point. One zip holds your files, the chain manifest, and
a small Python script. Anyone can run it, no Magpie required, and confirm
the whole record is exactly as chained. And the head hash, one line, pins
the entire journal: email it to yourself or anyone you trust, and from
that moment you can prove the record existed in exactly this state.

<p align="center">
  <img src="docs/shots/export.png" width="70%" alt="The export screen: share and save buttons, and the head hash under the words Anchor the record">
</p>

## Get it

Android: install [magpie.apk](https://github.com/munzzyy/magpie/releases/latest/download/magpie.apk)
on Android 10 or newer; the link always points at the current release,
so Obtainium can track it. On the web it is a static page with no server
side at all.

## Check the claims

`npm test` runs the chain, crypto, service-worker, and zip suites; the
zip suite cross-checks against python3 and system unzip, so have both
around. The export verifier is re-implemented in pure Python stdlib and
tested against JS-built exports
with deliberate tampering, so the two can never silently drift. `npm run
e2e` drives the real app in Chromium and then greps the raw IndexedDB
bytes for the test's plaintext canaries: titles, notes, and attachment
bytes must never appear unencrypted at rest, and the exported zip is
verified by Python, outside the app. The APK requests no Android
permissions; its one manifest entry is androidx's self-scoped
not-exported marker, which grants nothing, and CI fails the build if
anything real ever appears. Photos arrive through the system camera app,
and the OS refuses every network connection.

## What it is not

Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). The short version:
tamper-evident is not court-admissible (talk to a lawyer), device
timestamps are claims until the head hash is anchored somewhere with a
date, there is no passphrase recovery on purpose, and no app survives a
device your adversary already controls.

## Run it

For development: `node test/serve_local.mjs` serves the web app, and
`cd android && ./gradlew assembleDebug` builds an installable debug APK
(release signing goes through `tools/release-android.sh`).

## Bugs, holes, contributions

A way to change a chained entry without breaking verification is the bug
that matters; [SECURITY.md](SECURITY.md) has the private route for that.
Everything else: issues and pull requests are open and welcome. Releases
list the APK's sha256 and signing certificate digest, and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) says plainly what the chain
does and does not prove.

MIT.
