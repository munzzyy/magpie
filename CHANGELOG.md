# Changelog

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
