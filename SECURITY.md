# Security policy

Magpie's whole job is being trustworthy, so reports get taken seriously
and answered fast.

## Reporting

Email Munzzyy1@proton.me, or use GitHub's private vulnerability reporting on
this repository. You will get an answer within 72 hours.

Especially interested in:

- Any way to alter, reorder, or delete a chained entry without
  verification failing (this is the core promise; treat any
  counterexample as critical).
- Plaintext journal content reachable at rest while the vault is locked.
- Any network traffic from the app at all.
- Ways the export's verify.py accepts a tampered export.

## Scope notes

- Anchoring is the user's step; a chain never anchored proving less is
  documented behavior, not a vulnerability.
- Coercion, compromised devices, and passphrase loss are documented
  limits in the threat model.

## No bounty

There is no money behind this project. What you get is a fast fix, credit in
the changelog if you want it, and a tool that stays trustworthy.
