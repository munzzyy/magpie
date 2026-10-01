// tools/compare-apk.py on small zips laid out like a build and a signed
// release: the signature files are the only thing it may skip.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "tools", "compare-apk.py");

// Each entry is [name, text, deflate?]; flip names an entry whose first stored byte is changed in place.
const MAKE = `
import json, sys, zipfile
out, entries, flip = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
with zipfile.ZipFile(out, "w") as z:
    for name, text, deflate in entries:
        z.writestr(zipfile.ZipInfo(name), text, zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED)
if flip:
    with zipfile.ZipFile(out) as z:
        info = z.getinfo(flip)
    with open(out, "r+b") as f:
        f.seek(info.header_offset + 26)
        n, m = int.from_bytes(f.read(2), "little"), int.from_bytes(f.read(2), "little")
        f.seek(info.header_offset + 30 + n + m)
        b = f.read(1)
        f.seek(-1, 1)
        f.write(bytes([b[0] ^ 1]))
`;

const BUILD = [
  ["AndroidManifest.xml", "manifest", true],
  ["classes.dex", "dex bytes", false],
  ["assets/index.html", "<!doctype html>", true],
];
const SIGS = [
  ["META-INF/MANIFEST.MF", "Manifest-Version: 1.0", true],
  ["META-INF/CERT.SF", "sig", true],
  ["META-INF/CERT.RSA", "rsa", false],
];

test("compare-apk.py passes a signed copy and catches every kind of change", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-apk-"));
  try {
    let n = 0;
    const zip = (entries, flip = "") => {
      const out = path.join(dir, `${n++}.apk`);
      execFileSync("python3", ["-c", MAKE, out, JSON.stringify(entries), flip]);
      return out;
    };
    const compare = (release) => spawnSync("python3", [TOOL, built, release], { encoding: "utf8" });
    const built = zip(BUILD);

    const signed = compare(zip([...BUILD, ...SIGS]));
    assert.equal(signed.status, 0, signed.stdout);
    assert.match(signed.stdout, /^SAME: all 3 entries match; signature files skipped: 0 in the build, 3 in the release/);

    const cases = [
      ["a byte flipped in place, CRC left alone", zip([...BUILD, ...SIGS], "classes.dex"), /classes\.dex: compressed bytes differ/],
      ["different contents", zip([BUILD[0], ["classes.dex", "dex bytez", false], BUILD[2]]), /classes\.dex: CRC-32/],
      ["stored instead of deflated", zip([[BUILD[0][0], BUILD[0][1], false], BUILD[1], BUILD[2]]), /AndroidManifest\.xml: compression method 8 vs 0/],
      ["reordered", zip([BUILD[1], BUILD[0], BUILD[2]]), /entry order differs from entry 1/],
      ["an entry missing", zip(BUILD.slice(0, 2)), /only in the build: assets\/index\.html/],
      ["an entry added", zip([...BUILD, ["assets/extra.js", "x", true]]), /only in the release: assets\/extra\.js/],
      ["a .SF below META-INF is not a signature", zip([...BUILD, ["META-INF/sub/X.SF", "x", true]]), /only in the release: META-INF\/sub\/X\.SF/],
    ];
    for (const [why, release, pattern] of cases) {
      const r = compare(release);
      assert.equal(r.status, 1, `${why}: ${r.stdout}`);
      assert.match(r.stdout, /^DIFFERENT:/, why);
      assert.match(r.stdout, pattern, why);
    }

    const notZip = spawnSync("python3", [TOOL, built, TOOL], { encoding: "utf8" });
    assert.equal(notZip.status, 2);
    assert.match(notZip.stdout, /^ERROR:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
