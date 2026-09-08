// The backwards-timestamp warning is checked in TWO independent places: JS
// (app/js/chain.js, exercised in chain.test.mjs) and the bundled python
// verifier (VERIFY_PY in app/js/export.js). This suite cross-checks the
// python side against the same fixtures, and pins a pre-fix export as a
// fixture to prove the fix never touched canonicalization or hashing: an
// export written before this change must still verify clean after it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonical, makeEntry } from "../app/js/canon.js";
import { entryHash, verifyChain, GENESIS } from "../app/js/chain.js";
import { VERIFY_PY } from "../app/js/export.js";

const enc = new TextEncoder();

// A real export built and frozen BEFORE this fix (app/js/canon.js and the
// hash computation in app/js/chain.js untouched since): manifest.json and
// entries.json exactly as buildExport() produced them, with entry 2's
// attachment. test/fixtures/ is gitignored scratch space, so this is
// embedded here instead of as a file, which also pins it against drift.
const LEGACY_ATTACHMENT = enc.encode("legacy attachment payload");
const LEGACY_MANIFEST = {
  format: "magpie-export",
  v: 1,
  genesis: "magpie-genesis-v1",
  algorithm: 'sha256(prev_hash + "\\n" + canonical_entry_json)',
  head: "87c74a063debb88b2936e8b3f4ed757b25f840b1bd63b88ffd26c879c5da4f94",
  count: 3,
  generated_at: "2026-08-01T09:31:00.000Z",
};
const LEGACY_ENTRIES = [
  {
    v: 1,
    seq: 1,
    ts: "2026-08-01T09:00:00.000Z",
    type: "note",
    title: "First entry",
    note: "Started the journal.",
    file: null,
  },
  {
    v: 1,
    seq: 2,
    ts: "2026-08-01T09:15:00.000Z",
    type: "file",
    title: "Photo of the scene",
    note: "Attached.",
    file: {
      name: "proof.txt",
      mime: "text/plain",
      size: 25,
      sha256: "a26b332a05ea370f48f0da08eb378c6862cb01987b36948d3e7fe65c937a53db",
    },
    _filename: "proof.txt",
  },
  {
    v: 1,
    seq: 3,
    ts: "2026-08-01T09:30:00.000Z",
    type: "note",
    title: "Follow up",
    note: "Everything as before.",
    file: null,
  },
];

async function writeExport(dir, rawEntries, verifyPy) {
  let prev = GENESIS;
  const entriesOut = [];
  for (const r of rawEntries) {
    const entry = makeEntry(r);
    prev = await entryHash(prev, entry);
    entriesOut.push(JSON.parse(canonical(entry)));
  }
  const manifest = { format: "magpie-export", v: 1, genesis: GENESIS, head: prev, count: rawEntries.length };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entriesOut));
  writeFileSync(path.join(dir, "verify.py"), verifyPy);
  return { manifest, entriesOut };
}

test("negative control: python raises no warning over a forward-only chain", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-order-"));
  try {
    await writeExport(
      dir,
      [
        { seq: 1, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "t1", note: "n1", file: null },
        { seq: 2, ts: "2026-09-06T12:00:02.000Z", type: "note", title: "t2", note: "n2", file: null },
        { seq: 3, ts: "2026-09-06T12:00:03.000Z", type: "note", title: "t3", note: "n3", file: null },
      ],
      VERIFY_PY,
    );
    const out = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(out, /^OK: 3 entries verify/);
    assert.doesNotMatch(out, /WARNING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python warns, but still passes, when an entry's clock goes backwards", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-order-"));
  try {
    await writeExport(
      dir,
      [
        { seq: 1, ts: "2026-09-06T12:00:03.000Z", type: "note", title: "t1", note: "n1", file: null },
        { seq: 2, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "t2", note: "n2", file: null },
        { seq: 3, ts: "2026-09-06T12:00:02.000Z", type: "note", title: "t3", note: "n3", file: null },
      ],
      VERIFY_PY,
    );
    const out = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(out, /^OK: 3 entries verify/);
    assert.match(out, /WARNING: entry 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control: a tampered hash still fails in python even with a backwards timestamp", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-order-"));
  try {
    const { entriesOut } = await writeExport(
      dir,
      [
        { seq: 1, ts: "2026-09-06T12:00:03.000Z", type: "note", title: "t1", note: "n1", file: null },
        { seq: 2, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "t2", note: "n2", file: null },
      ],
      VERIFY_PY,
    );
    const tampered = structuredClone(entriesOut);
    tampered[0].note = "edited after the fact";
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(tampered));
    assert.throws(() => execFileSync("python3", [path.join(dir, "verify.py")], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chain that goes backwards in time still verifies clean in JS and raises the matching warning in python", async () => {
  const raw = [
    { seq: 1, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "t1", note: "n1", file: null },
    { seq: 2, ts: "2026-09-06T11:00:00.000Z", type: "note", title: "t2", note: "n2", file: null },
    { seq: 3, ts: "2026-09-06T12:00:03.000Z", type: "note", title: "t3", note: "n3", file: null },
  ];
  const entries = raw.map(makeEntry);
  const hashes = [];
  let prev = GENESIS;
  for (const e of entries) {
    prev = await entryHash(prev, e);
    hashes.push(prev);
  }
  const jsResult = await verifyChain(entries, hashes, prev);
  assert.equal(jsResult.ok, true);
  assert.equal(jsResult.timeWarning, 2);

  const dir = mkdtempSync(path.join(tmpdir(), "magpie-order-"));
  try {
    await writeExport(dir, raw, VERIFY_PY);
    const out = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(out, /WARNING: entry 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an export built before this fix still verifies clean under the fixed JS and the fixed python", async () => {
  // Recompute the chain with the current JS: no recorded per-entry hashes
  // are stored in entries.json (only the manifest head), so this exercises
  // the same seq-and-canonical-bytes recomputation verify.py does.
  const jsResult = await verifyChain(LEGACY_ENTRIES, null, LEGACY_MANIFEST.head);
  assert.equal(jsResult.ok, true, "canonicalization or hashing changed under an old export");
  assert.equal(jsResult.timeWarning, null);

  // Run the CURRENT (fixed) verify.py against the OLD export's own
  // manifest.json, entries.json, and attachment, to prove the new verifier
  // still accepts an export it never wrote.
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-legacy-"));
  try {
    mkdirSync(path.join(dir, "files"), { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(LEGACY_MANIFEST));
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(LEGACY_ENTRIES));
    writeFileSync(path.join(dir, "files", "002-proof.txt"), LEGACY_ATTACHMENT);
    writeFileSync(path.join(dir, "verify.py"), VERIFY_PY);
    const out = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(out, /^OK: 3 entries verify; head 87c74a063debb88b2936e8b3f4ed757b25f840b1bd63b88ffd26c879c5da4f94/);
    assert.doesNotMatch(out, /WARNING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
