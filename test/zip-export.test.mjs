// The zip writer and the export format are validated by INDEPENDENT
// implementations: python's zipfile reads the archive, system unzip tests
// its integrity, and verify.py (pure stdlib) re-verifies the chain that
// magpie's own JS built. If the JS and python canonicalizations ever
// drift, this suite is what catches it.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildZip, crc32 } from "../app/js/zip.js";
import { canonical, makeEntry } from "../app/js/canon.js";
import { entryHash, GENESIS, sha256Hex } from "../app/js/chain.js";
import { VERIFY_PY, VERIFY_MD } from "../app/js/export.js";

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
