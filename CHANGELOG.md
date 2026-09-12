# Changelog

## 0.4.2

Backups survive a real attachment.

- Sealing a backup of a journal that held a file of any real size failed:
  the encode step spread the whole attachment across a single function call
  and hit the argument limit. It builds the base64 in chunks now, so a backup
  carries its attachments no matter how big they are.

## 0.4.1

The file buttons open something now.

- Attaching a file to a note, and picking a backup to restore, both did
  nothing: the button opened no file picker at all. The WebView had never
  been handed a file-chooser, so every file input was dead. Both work now.

## 0.4.0

The chain proves order, not the clock.

- verifyChain and verify.py both certified a chain clean even when an
  entry's timestamp was earlier than the one before it, a device clock
  jumping back for any reason (drift, a time zone change, a reset) and
  nobody noticing. Both now catch it and say so: the badge and the export
  verifier report a warning naming the entry, never a rejection. Refusing
  to record something because a clock moved would be worse than the drift
  itself, and the chain was never proving clock order to begin with, only
  that each entry was added after the one before it.

## 0.3.0

The journal grows a spine, a backup, and a longer memory.

- The timeline draws its chain: a spine, a dot and hash chip per entry, an
  anchor line saying how far the record is pinned, and a sealing snap when
  an entry joins.
- Sealed backup and restore: one encrypted envelope under the vault key,
  only the key-derivation parameters readable outside it. Restore verifies
  the whole chain in memory before a byte lands, with five distinct
  refusal codes for everything that can be wrong.
- verify.py --extends proves one export is an append-only extension of
  another; exports self-verify before they can leave the app.
- Multi-file attach, in-memory search that a lock wipes, a first-run empty
  state, and a wrong-passphrase shake that still announces itself.

## 0.2.0

The iOS round.

- An iOS wrapper in `ios/` on the permanent `magpie://localhost` origin,
  with export reaching the system share sheet through a native bridge and
  WebKit storage excluded from iCloud and device backups, because an
  evidence vault must not quietly ride into a cloud copy. docs/IOS.md
  carries the honest capability table.
- A wrong passphrase now announces itself to screen readers instead of
  failing silently, screens move focus when they open, headings exist past
  the lock screen, and the delete confirm has a label.
- Storage asks the browser to persist; settings show days since the last
  export; attached photos keep their metadata on purpose and the copy says
  so where you attach them.

## 0.1.0

First release.

- Encrypted incident journal: AES-256-GCM under a PBKDF2 passphrase key,
  everything sealed at rest, fail-closed lock, aggressive auto-lock.
- Hash chain over every entry with an always-visible intact/broken badge
  and one-tap verification.
- Self-proving exports: a plain zip with the files, the chain manifest,
  and a stdlib python verifier; head hash one tap away for anchoring.
- Share-in from any app (single or batch), photo capture through the
  system camera, exports out through the share sheet or Downloads.
- Offline PWA with share target, English and Spanish.
- Android wrapper with zero permissions, secure-screen flag, backups
  disabled.
