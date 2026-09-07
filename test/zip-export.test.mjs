// The zip writer and the export format are validated by INDEPENDENT
// implementations: python's zipfile reads the archive, system unzip tests
// its integrity, and verify.py (pure stdlib) re-verifies the chain that
// magpie's own JS built. If the JS and python canonicalizations ever
// drift, this suite is what catches it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildZip, crc32, readZip } from "../app/js/zip.js";
import { canonical, makeEntry } from "../app/js/canon.js";
import { entryHash, GENESIS, sha256Hex } from "../app/js/chain.js";
import { VERIFY_PY, VERIFY_MD, selfVerifyExport } from "../app/js/export.js";

const enc = new TextEncoder();

test("crc32 matches the reference value for 'hello'", () => {
  assert.equal(crc32(enc.encode("hello")), 0x3610a686);
});

test("python zipfile and system unzip both accept our archives", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-zip-"));
  try {
    const zip = buildZip([
      { name: "manifest.json", bytes: enc.encode('{"a":1}') },
      { name: "files/001-photo.jpg", bytes: Uint8Array.from({ length: 5000 }, (_, i) => i % 251) },
      { name: "notes/unicode ✓.txt", bytes: enc.encode("body ✓") },
    ]);
    const file = path.join(dir, "out.zip");
    writeFileSync(file, zip);
    const listing = execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
assert bad is None, bad
names = z.namelist()
assert names == ["manifest.json", "files/001-photo.jpg", "notes/unicode \\u2713.txt"], names
assert z.read("notes/unicode \\u2713.txt").decode() == "body \\u2713"
assert len(z.read("files/001-photo.jpg")) == 5000
print("python-ok")
`, file], { encoding: "utf8" });
    assert.match(listing, /python-ok/);
    try {
      execFileSync("unzip", ["-t", file], { stdio: "pipe" });
    } catch (err) {
      t.diagnostic("system unzip unavailable or failed: " + err.message);
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify.py independently verifies a JS-built export, and catches tampering", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-verify-"));
  try {
    const fileBytes = enc.encode("attachment payload ✓");
    const entries = [];
    let prev = GENESIS;
    for (let seq = 1; seq <= 3; seq++) {
      const entry = makeEntry({
        seq,
        ts: `2026-09-06T12:00:0${seq}.000Z`,
        type: seq === 2 ? "file" : "note",
        title: `Entry "${seq}" with quotes ✓`,
        note: "line one\nline two",
        file:
          seq === 2
            ? { name: "proof.txt", mime: "text/plain", size: fileBytes.length, sha256: await sha256Hex(fileBytes) }
            : null,
      });
      prev = await entryHash(prev, entry);
      const out = JSON.parse(canonical(entry));
      if (entry.file) out._filename = "proof.txt";
      entries.push(out);
    }
    const manifest = { format: "magpie-export", v: 1, genesis: GENESIS, head: prev, count: 3 };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entries));
    writeFileSync(path.join(dir, "verify.py"), VERIFY_PY);
    writeFileSync(path.join(dir, "VERIFY.md"), VERIFY_MD);
    execFileSync("mkdir", ["-p", path.join(dir, "files")]);
    writeFileSync(path.join(dir, "files", "002-proof.txt"), fileBytes);

    const ok = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(ok, /^OK: 3 entries verify/);

    // Negative control: edit a note; python must refuse.
    const tampered = structuredClone(entries);
    tampered[0].note = "edited after the fact";
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(tampered));
    assert.throws(() => execFileSync("python3", [path.join(dir, "verify.py")], { stdio: "pipe" }));

    // Negative control: swap the attachment; python must refuse.
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entries));
    writeFileSync(path.join(dir, "files", "002-proof.txt"), enc.encode("different bytes"));
    assert.throws(() => execFileSync("python3", [path.join(dir, "verify.py")], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readZip is the exact mirror of buildZip", () => {
  const files = [
    { name: "a.txt", bytes: enc.encode("hello") },
    { name: "dir/b.bin", bytes: Uint8Array.from({ length: 300 }, (_, i) => i % 256) },
    { name: "unicode ✓.txt", bytes: enc.encode("body ✓") },
  ];
  const zip = buildZip(files);
  const read = readZip(zip);
  assert.deepEqual(
    read.map((f) => f.name),
    files.map((f) => f.name),
  );
  for (let i = 0; i < files.length; i++) assert.deepEqual([...read[i].bytes], [...files[i].bytes]);
});

test("selfVerifyExport accepts a correct export and rejects tampering, both in the manifest and in the zip bytes", async () => {
  const entry = makeEntry({ seq: 1, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "t", note: "n", file: null });
  const head = await entryHash(GENESIS, entry);
  const entriesOut = [JSON.parse(canonical(entry))];
  const manifest = { format: "magpie-export", v: 1, genesis: GENESIS, head, count: 1, generated_at: "2026-09-06T12:00:00.000Z" };
  const zip = buildZip([
    { name: "manifest.json", bytes: enc.encode(JSON.stringify(manifest)) },
    { name: "entries.json", bytes: enc.encode(JSON.stringify(entriesOut)) },
    { name: "VERIFY.md", bytes: enc.encode(VERIFY_MD) },
    { name: "verify.py", bytes: enc.encode(VERIFY_PY) },
  ]);
  await assert.doesNotReject(selfVerifyExport(zip, manifest, entriesOut));

  // Negative control: the manifest recorded a head that does not match the entries.
  await assert.rejects(selfVerifyExport(zip, { ...manifest, head: "0".repeat(64) }, entriesOut));

  // Negative control: a byte flips inside manifest.json's own file data,
  // right after its local header and name ("manifest.json", 13 bytes).
  const corrupted = zip.slice();
  const dataStart = 30 + "manifest.json".length;
  corrupted[dataStart + 5] ^= 0xff;
  await assert.rejects(selfVerifyExport(corrupted, manifest, entriesOut));
});

test("verify.py --extends proves one export is an append-only extension of another, and refuses a fork", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-extends-"));
  try {
    let prev = GENESIS;
    const chain = [];
    for (let seq = 1; seq <= 4; seq++) {
      const entry = makeEntry({ seq, ts: `2026-09-06T12:00:0${seq}.000Z`, type: "note", title: `t${seq}`, note: `n${seq}`, file: null });
      prev = await entryHash(prev, entry);
      chain.push({ out: JSON.parse(canonical(entry)), head: prev });
    }
    const writeExport = (dest, entries, head) => {
      mkdirSync(dest, { recursive: true });
      const manifest = { format: "magpie-export", v: 1, genesis: GENESIS, head, count: entries.length };
      writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(path.join(dest, "entries.json"), JSON.stringify(entries));
      writeFileSync(path.join(dest, "verify.py"), VERIFY_PY);
    };

    const older = path.join(dir, "older");
    const newer = path.join(dir, "newer");
    writeExport(older, chain.slice(0, 2).map((c) => c.out), chain[1].head);
    writeExport(newer, chain.map((c) => c.out), chain[3].head);

    const out = execFileSync("python3", [path.join(newer, "verify.py"), "--extends", older], { encoding: "utf8" });
    assert.match(out, /EXTENDS: this export is an append-only continuation/);

    // Negative control: a rival export that is internally 100% valid, and
    // shares entry 1 with the older export, but diverges at entry 2. Being
    // self-consistent is not enough; it must match the older head exactly.
    let rivalPrev = chain[0].head;
    const rivalEntry2 = makeEntry({ seq: 2, ts: chain[1].out.ts, type: "note", title: "t2", note: "DIFFERENT", file: null });
    rivalPrev = await entryHash(rivalPrev, rivalEntry2);
    const rivalEntry3 = makeEntry({ seq: 3, ts: "2026-09-06T12:00:09.000Z", type: "note", title: "t3", note: "n3", file: null });
    rivalPrev = await entryHash(rivalPrev, rivalEntry3);
    const rival = path.join(dir, "rival");
    writeExport(rival, [chain[0].out, JSON.parse(canonical(rivalEntry2)), JSON.parse(canonical(rivalEntry3))], rivalPrev);

    assert.throws(() => execFileSync("python3", [path.join(rival, "verify.py"), "--extends", older], { stdio: "pipe" }));
    // But the rival still verifies fine on its own: this proves --extends
    // is catching genuine divergence, not just any old failure.
    const rivalOk = execFileSync("python3", [path.join(rival, "verify.py")], { encoding: "utf8" });
    assert.match(rivalOk, /^OK: 3 entries verify/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emoji split across the truncation boundary cannot brick the python verifier", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-astral-"));
  try {
    // 199 chars then an astral emoji: a naive slice(0,200) would keep only
    // its high surrogate and crash python's .encode() forever after.
    const entry = makeEntry({
      seq: 1,
      ts: "2026-09-06T12:00:01.000Z",
      type: "note",
      title: "x".repeat(199) + "\u{1F600}",
      note: "boundary \u{1F988} test",
      file: null,
    });
    assert.ok(!/[\uD800-\uDBFF]$/.test(entry.title), "no trailing lone surrogate");
    const head = await entryHash(GENESIS, entry);
    const out = JSON.parse(canonical(entry));
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: "magpie-export", v: 1, genesis: GENESIS, head, count: 1 }));
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify([out]));
    writeFileSync(path.join(dir, "verify.py"), VERIFY_PY);
    const ok = execFileSync("python3", [path.join(dir, "verify.py")], { encoding: "utf8" });
    assert.match(ok, /^OK: 1 entries verify/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
