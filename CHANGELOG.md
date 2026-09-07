# Changelog

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
