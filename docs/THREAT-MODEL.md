# Magpie threat model

What the chain proves, what the crypto protects, and where the honest
edges are. If a dispute actually matters to you, read the whole page.
It's short because the guarantees are few and specific.

## What it protects you from

Someone with your export claiming you doctored it. The chain covers every
entry's content, order, and recorded time; verification recomputes it all
from scratch. If entries.json or any attachment was edited after export,
verify.py says so. That includes you: there is no edit button, and that
absence is a feature. A journal whose author can quietly rewrite it proves
nothing, so Magpie's answer to a mistake is a correcting entry, chained
like everything else.

Someone picking up your phone and reading the journal. Entries and
attachments are sealed with AES-256-GCM under a key derived from your
passphrase (PBKDF2-SHA256 at 600k iterations). Locked, the vault is
ciphertext and nothing else. I don't ask you to take that on faith
either: the test suite plants known text and attachment bytes, then greps
the raw database for them on every run. Encryption claims rot silently;
this one has a tripwire.

Quiet deletion breaks loudly. Remove an entry from the middle and every
hash after it stops matching. The badge on the timeline recomputes the
whole chain each time it paints.

## What the export does NOT protect

The export zip is not encrypted. Building it takes the entries out of the
vault and writes them as plain files so the standalone Python verifier can
check them without touching Magpie's crypto at all; that is also what makes
it readable by anyone who gets a copy. Send it only where you mean the
contents to be readable, and encrypt the zip yourself (a password-protected
archive, an encrypted email attachment) before it leaves your hands if that
matters for where it is going.

Photos and files you attach keep whatever metadata they already carry,
including GPS location if your camera records it and the device/software
details most cameras embed by default. Magpie does not strip any of that,
on purpose: for an incident journal, where and when a photo was taken can
itself be part of what you are trying to prove. If you would rather a
specific attachment not carry its location, strip it in another app before
attaching it here; Magpie does not do that for you today.

## What anchoring means, and why you should do it

A hash chain on one device proves internal consistency, not time. The
owner of the vault could delete everything and rebuild a different
journal from scratch; nothing on the device can prevent that. What fixes
the record in time is getting the head hash OUT of your hands early:
email it to yourself, text it to a friend, hand it to a lawyer. From that
moment, the record it commits to is pinned, and every later export that
extends the same chain inherits that anchor. Magpie puts the head hash
one tap from the export screen because this step is the difference
between a diary and evidence.

## What it does NOT protect you from

Legal weight is not automatic, and Magpie never says "court-ready".
Courts weigh testimony, custody, context. A verified chain is a strong
exhibit about integrity, nothing more. Anything with real stakes deserves
a lawyer early, not an app.

Device time is a claim. The timestamps come from your clock, and clocks
can be set. Anchoring is what turns claimed time into provable time.

Then there's the device itself. Someone who has your passphrase, or
malware running while the vault is open, sees what you see; Magpie locks
aggressively and blocks app-switcher thumbnails on Android, but no app
beats an adversary who owns the phone. And the flip side of "no cloud" is
on you: there is no copy to subpoena or breach, and also no copy when the
phone dies in a puddle. Export regularly. Keep the zips somewhere safe.
Uninstalling the app, or clearing site data in the browser, deletes the
vault, and there is no passphrase recovery, because a recovery path is an
access path.

Coercion. Someone who can force you to unlock gets everything, and a
journal can be exactly the thing they go looking for. If that's your
situation, think hard about what belongs in here at all, and talk to
people who do safety planning for a living before an app.

## Where your data goes

Nowhere. No accounts, no analytics, no server. The web app's CSP allows
its own origin only; the Android app has no INTERNET permission, so the
OS enforces the promise. Photos taken from inside the app go through the
system camera application and come back over a local one-shot hand-off.
Exports go exactly where you send them.

## What you're trusting

WebCrypto in your browser or WebView, which is the same primitive your
bank relies on. About two thousand lines of dependency-free JavaScript
plus a thin native shell, MIT licensed: Kotlin on Android, Swift on iOS.
Both shells exist to serve the same bundle and, on iOS, to hand exports to
the system share sheet; neither adds crypto or storage logic of its own.
The iOS shell's network guarantee rests on a page-level CSP rather than an
OS permission Android can revoke outright; see
[docs/IOS.md](IOS.md) for exactly what that difference means. And your own
passphrase habits: four random words remembered beat anything clever
forgotten.
