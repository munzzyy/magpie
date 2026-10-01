// The zip writer and the export format are validated by INDEPENDENT
// implementations: python's zipfile reads the archive, system unzip tests
// its integrity, and verify.py (pure stdlib) re-verifies the chain that
// magpie's own JS built. If the JS and python canonicalizations ever
// drift, this suite is what catches it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildZip, crc32, readZip } from "../app/js/zip.js";
import { canonical, makeEntry } from "../app/js/canon.js";
import { entryHash, GENESIS, sha256Hex } from "../app/js/chain.js";
import { VERIFY_PY, VERIFY_MD, safeName, selfVerifyExport } from "../app/js/export.js";

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

    // --anchor: a head hash emailed after entry 2 is found in the 4-entry export.
    const anchor = (...hashes) =>
      spawnSync("python3", [path.join(newer, "verify.py"), ...hashes.flatMap((h) => ["--anchor", h])], { encoding: "utf8" });
    const at2 = anchor(chain[1].head);
    assert.equal(at2.status, 0, at2.stdout + at2.stderr);
    assert.match(at2.stdout, new RegExp(`^ANCHOR: ${chain[1].head} is the head after entry 2 of 4$`, "m"));
    const at4 = anchor(chain[3].head);
    assert.equal(at4.status, 0);
    assert.match(at4.stdout, /after entry 4 of 4/);
    const upper = anchor(chain[1].head.toUpperCase());
    assert.equal(upper.status, 0);
    assert.match(upper.stdout, /after entry 2 of 4/);
    const both = anchor(chain[0].head, chain[2].head);
    assert.equal(both.status, 0);
    assert.match(both.stdout, /after entry 1 of 4[\s\S]*after entry 3 of 4/);

    // Negative controls: the fork's head, the genesis string and a bare prefix are no anchors.
    const forked = anchor(rivalPrev);
    assert.equal(forked.status, 1);
    assert.match(forked.stdout, /^FAIL: .* is not the head/m);
    assert.doesNotMatch(forked.stdout, /^ANCHOR:/m);
    const mixed = anchor(chain[1].head, rivalPrev);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stdout, /^ANCHOR: .* entry 2 of 4$/m);
    assert.match(mixed.stdout, /^FAIL: .* is not the head/m);
    for (const notAHash of [GENESIS, chain[1].head.slice(0, 16)]) {
      const r = anchor(notAHash);
      assert.equal(r.status, 2, notAHash);
      assert.doesNotMatch(r.stdout, /^(ANCHOR|OK):/m);
    }
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
    assert.match(ok, /^OK: 1 entry verifies/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Python 3.14 and older on Windows open text in the ANSI code page; the shim forces that here.
const AS_WINDOWS = [
  "import builtins, runpy, sys",
  "_o = builtins.open",
  'def o(f, mode="r", *a, **k):',
  '    if "b" not in mode and "encoding" not in k and len(a) < 2: k["encoding"] = "cp1252"',
  "    return _o(f, mode, *a, **k)",
  'builtins.open = o; sys.argv = [sys.argv[1]]; runpy.run_path(sys.argv[0], run_name="__main__")',
  "",
].join("\n");

test("verify.py reads the export as UTF-8 whatever Python's default text encoding is", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-win-"));
  try {
    const entry = makeEntry({ seq: 1, ts: "2026-09-06T12:00:01.000Z", type: "note", title: "Fuga en la cocina, d\u00eda 1", note: "", file: null });
    const head = await entryHash(GENESIS, entry);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: "magpie-export", v: 1, genesis: GENESIS, head, count: 1 }));
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify([JSON.parse(canonical(entry))]));
    writeFileSync(path.join(dir, "as_windows.py"), AS_WINDOWS);
    const runAsWindows = (verifier) => {
      writeFileSync(path.join(dir, "verify.py"), verifier);
      return spawnSync("python3", [path.join(dir, "as_windows.py"), path.join(dir, "verify.py")], { encoding: "utf8" });
    };

    const ok = runAsWindows(VERIFY_PY);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^OK:/);

    // Negative control: the same verifier without the explicit encoding.
    const old = runAsWindows(VERIFY_PY.replaceAll(', encoding="utf-8"', ""));
    assert.notEqual(old.status, 0);
    assert.match(old.stdout, /^FAIL: recomputed head/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Lays an export out the way buildExport() does; rows with bytes get an attachment.
async function writeExportDir(dir, rows) {
  mkdirSync(path.join(dir, "files"), { recursive: true });
  let head = GENESIS;
  const entries = [];
  for (const [i, row] of rows.entries()) {
    const seq = i + 1;
    const file = row.bytes ? { name: row.name, mime: "application/octet-stream", size: row.bytes.length, sha256: await sha256Hex(row.bytes) } : null;
    const entry = makeEntry({ seq, ts: `2026-09-06T12:00:${String(seq).padStart(2, "0")}.000Z`, type: file ? "file" : "note", title: row.title ?? `t${seq}`, note: row.note ?? "", file });
    head = await entryHash(head, entry);
    const out = JSON.parse(canonical(entry));
    if (file) {
      out._filename = safeName(entry.file.name);
      writeFileSync(path.join(dir, "files", `${String(seq).padStart(3, "0")}-${out._filename}`), row.bytes);
    }
    entries.push(out);
  }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: "magpie-export", v: 1, genesis: GENESIS, head, count: entries.length }));
  writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entries));
  writeFileSync(path.join(dir, "verify.py"), VERIFY_PY);
  return { head, entries };
}

const runVerify = (dir, ...args) => spawnSync("python3", [path.join(dir, "verify.py"), ...args], { encoding: "utf8" });

function withDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a lone surrogate in a note hashes the same in python as in JS", () =>
  withDir("magpie-lone-", async (dir) => {
    const { head } = await writeExportDir(dir, [{ note: "a\uD800b" }, { title: "after it \uDE00" }]);
    const r = runVerify(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^OK: 2 entries verify; head ${head}$`, "m"));

    // Negative control: a different lone surrogate is a different note.
    const entries = JSON.parse(readFileSync(path.join(dir, "entries.json"), "utf8"));
    entries[0].note = "a\uD801b";
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entries));
    const tampered = runVerify(dir);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stdout, /^FAIL: recomputed head/);
  }));

test("a broken export fails with a sentence, never a traceback", () =>
  withDir("magpie-broken-", async (dir) => {
    const bytes = enc.encode("the attachment");
    const { entries } = await writeExportDir(dir, [{}, { name: "proof.txt", bytes }]);
    assert.equal(runVerify(dir).status, 0);
    const failsCleanly = (why, pattern) => {
      const r = runVerify(dir);
      assert.equal(r.status, 1, why);
      assert.match(r.stdout, pattern, why);
      assert.doesNotMatch(r.stderr, /Traceback/, why);
    };
    const restore = () => {
      writeFileSync(path.join(dir, "entries.json"), JSON.stringify(entries));
      assert.equal(runVerify(dir).status, 0);
    };

    unlinkSync(path.join(dir, "files", "002-proof.txt"));
    failsCleanly("missing attachment", /^FAIL: the attachment for entry 2 is missing \(files\/002-proof\.txt\)/);
    writeFileSync(path.join(dir, "files", "002-proof.txt"), bytes);
    restore();

    writeFileSync(path.join(dir, "entries.json"), "[{");
    failsCleanly("entries.json is not JSON", /^FAIL: entries\.json in .* could not be read as JSON/);
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify({ entries }));
    failsCleanly("entries.json is not a list", /^FAIL: entries\.json in .* is not a list of entries/);
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify([{ ...entries[0], seq: undefined }, entries[1]]));
    failsCleanly("an entry without a seq", /^FAIL: entry 1 in entries\.json has seq None/);
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify([entries[0], { ...entries[1], file: "proof.txt" }]));
    failsCleanly("a file record that is not an object", /^FAIL: entry 2's file record is malformed/);
    restore();

    const manifest = path.join(dir, "manifest.json");
    renameSync(manifest, manifest + ".gone");
    failsCleanly("missing manifest.json", /^FAIL: manifest\.json is missing from /);
    writeFileSync(manifest, JSON.stringify({ format: "magpie-export", v: 1, genesis: GENESIS }));
    failsCleanly("manifest.json without a head", /^FAIL: manifest\.json in .* has no genesis or head/);
    renameSync(manifest + ".gone", manifest);
    assert.equal(runVerify(dir).status, 0);
  }));

test("files the chain does not cover are named, and a renamed attachment fails", () =>
  withDir("magpie-cover-", async (dir) => {
    const bytes = enc.encode("photo bytes");
    const { entries } = await writeExportDir(dir, [{}, { name: "photo.jpg", bytes }]);
    const clean = runVerify(dir);
    assert.equal(clean.status, 0);
    assert.doesNotMatch(clean.stdout, /not covered/);

    writeFileSync(path.join(dir, "files", "002-planted.jpg"), enc.encode("planted"));
    mkdirSync(path.join(dir, "files", "more"));
    writeFileSync(path.join(dir, "files", "more", "x.bin"), enc.encode("planted too"));
    const planted = runVerify(dir);
    assert.equal(planted.status, 0, planted.stdout + planted.stderr);
    assert.match(planted.stdout, /^OK: 2 entries verify/);
    assert.match(planted.stdout, /^WARNING: not covered by the chain:\n {2}files\/002-planted\.jpg\n {2}files\/more\/x\.bin\n/m);
    assert.doesNotMatch(planted.stdout, /002-photo\.jpg/);
    rmSync(path.join(dir, "files", "002-planted.jpg"));
    rmSync(path.join(dir, "files", "more"), { recursive: true });

    // The bytes still match their hash, but the name outside the hash moved.
    renameSync(path.join(dir, "files", "002-photo.jpg"), path.join(dir, "files", "002-renamed.jpg"));
    const renamed = structuredClone(entries);
    renamed[1]._filename = "renamed.jpg";
    writeFileSync(path.join(dir, "entries.json"), JSON.stringify(renamed));
    const r = runVerify(dir);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: entry 2's attachment is listed as files\/002-renamed\.jpg, but its chained name makes it files\/002-photo\.jpg/);
  }));

test("python files attachments under the same names export.js gives them", () =>
  withDir("magpie-names-", async (dir) => {
    const names = ["foto \u{1F600}.jpg", "\u{1F600}", "lease (final).pdf", "\u00f1and\u00fa.png", "x".repeat(100) + ".txt", "a/b\\c..d", "\uD800lone"];
    await writeExportDir(dir, names.map((name, i) => ({ name, bytes: enc.encode(`file ${i}`) })));
    const r = runVerify(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^OK: 7 entries verify/);
    assert.doesNotMatch(r.stdout, /not covered/);
  }));

test("--extends checks the older export on its own, and an empty one is a valid prefix", () =>
  withDir("magpie-extends2-", async (dir) => {
    const newer = path.join(dir, "newer");
    const { entries } = await writeExportDir(newer, [{}, {}, {}]);
    const empty = path.join(dir, "empty");
    await writeExportDir(empty, []);
    const fromEmpty = runVerify(newer, "--extends", empty);
    assert.equal(fromEmpty.status, 0, fromEmpty.stdout + fromEmpty.stderr);
    assert.match(fromEmpty.stdout, /^EXTENDS:/m);

    // Negative control: the older export's own entries were edited after it was made.
    const older = path.join(dir, "older");
    await writeExportDir(older, [{}, {}]);
    const r0 = runVerify(newer, "--extends", older);
    assert.equal(r0.status, 0, r0.stdout + r0.stderr);
    const edited = structuredClone(entries.slice(0, 2));
    edited[0].note = "edited after the fact";
    writeFileSync(path.join(older, "entries.json"), JSON.stringify(edited));
    const r = runVerify(newer, "--extends", older);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL: the older export does not verify on its own: recomputed head/m);
  }));
