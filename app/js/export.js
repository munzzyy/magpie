// Builds the export: a plain zip anyone can open, carrying the decrypted
// evidence, the chain manifest, and a standalone verifier script. The zip
// is the product; the app is just the pen. Before it is handed back to the
// caller, the built zip is read back and re-verified from its own bytes, so
// a corrupt export can never leave the app looking fine.

import { buildZip, readZip } from "./zip.js";
import { canonical } from "./canon.js";
import { listEntries, getFile, headState } from "./vault.js";
import { entryHash, GENESIS, sha256Hex } from "./chain.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const pad = (n) => String(n).padStart(3, "0");

const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";

export const VERIFY_PY = `#!/usr/bin/env python3
# Verifies a Magpie export without Magpie: recomputes the hash chain and
# every attachment digest. Needs only the Python standard library.
#   python3 verify.py
#   python3 verify.py --extends /path/to/an/earlier/export
import argparse, hashlib, json, os, sys

KEYS = ["v", "seq", "ts", "type", "title", "note", "file"]
FILE_KEYS = ["name", "mime", "size", "sha256"]

def canonical(e):
    parts = []
    for k in KEYS:
        v = e.get(k)
        if k == "file" and v is not None:
            v = {fk: v.get(fk) for fk in FILE_KEYS}
        parts.append(json.dumps(k) + ":" + json.dumps(v, ensure_ascii=False, separators=(",", ":")))
    return "{" + ",".join(parts) + "}"

def load(base):
    manifest = json.load(open(os.path.join(base, "manifest.json")))
    entries = json.load(open(os.path.join(base, "entries.json")))
    return manifest, entries

def verify_chain(base, manifest, entries, want_head_at=None):
    # Recomputes the chain from scratch. If want_head_at is given, also
    # returns the head hash after exactly that many entries, so a shorter
    # export's recorded head can be matched against a prefix of a longer one.
    prev = manifest["genesis"]
    prefix_head = None
    for i, e in enumerate(entries):
        if e["seq"] != i + 1:
            return False, f"entry {i} has seq {e['seq']}", None
        h = hashlib.sha256((prev + "\\n" + canonical(e)).encode()).hexdigest()
        prev = h
        if e.get("file"):
            path = os.path.join(base, "files", f"{e['seq']:03d}-" + e["_filename"])
            digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
            if digest != e["file"]["sha256"]:
                return False, f"attachment for entry {e['seq']} does not match its recorded hash", None
        if want_head_at is not None and i + 1 == want_head_at:
            prefix_head = h
    if prev != manifest["head"]:
        return False, f"recomputed head {prev} != recorded head {manifest['head']}", None
    return True, prev, prefix_head

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extends", metavar="DIR", help="an earlier export this one must append-only extend")
    args = ap.parse_args()

    base = os.path.dirname(os.path.abspath(__file__))
    manifest, entries = load(base)
    ok, head_or_reason, _ = verify_chain(base, manifest, entries)
    if not ok:
        print("FAIL:", head_or_reason)
        sys.exit(1)
    print("OK:", len(entries), "entries verify; head", head_or_reason)
    print("This proves the export matches its manifest. It proves the log")
    print("existed in this exact state no LATER than the earliest moment the")
    print("head hash was shared with someone else.")

    if args.extends:
        older_manifest, older_entries = load(args.extends)
        if older_manifest.get("genesis") != manifest.get("genesis"):
            print("FAIL: the two exports do not share a genesis; they are not the same journal")
            sys.exit(1)
        older_count = len(older_entries)
        if older_count > len(entries):
            print("FAIL: the older export has more entries than this one; it cannot be a prefix")
            sys.exit(1)
        ok2, head2, prefix_head = verify_chain(base, manifest, entries, want_head_at=older_count)
        if not ok2:
            print("FAIL:", head2)
            sys.exit(1)
        if prefix_head != older_manifest["head"]:
            print("FAIL: this export does not extend", args.extends, "the chains diverge before entry", older_count)
            sys.exit(1)
        print("EXTENDS: this export is an append-only continuation of", args.extends)
        print(f"the first {older_count} entries are byte-for-byte the same and share the head", older_manifest["head"])

if __name__ == "__main__":
    main()
`;

export const VERIFY_MD = `# Verifying this export

This folder is self-proving. Run:

    python3 verify.py

It recomputes the whole hash chain and every attachment digest from
scratch. If anything in entries.json or files/ was edited, reordered, or
removed after export, verification fails.

If you also have an earlier export of the same journal, point this one
at it and prove the newer export only ever appended to the older one,
never edited or reordered it:

    python3 verify.py --extends /path/to/the/older/export

What that means, honestly: a valid chain proves this log existed in
exactly this state at whatever moment the head hash (in manifest.json)
was first shared with someone else. Share the head hash early: email it
to yourself, your lawyer, or a friend. The earlier it left your hands,
the more the chain proves.
`;

// Reads the zip back and recomputes everything from the archive bytes
// alone, never from the values that built them, so a bug in buildZip or a
// corrupted write can never hand back a broken export looking fine.
export async function selfVerifyExport(zipBytes, manifest, entriesOut) {
  const files = readZip(zipBytes);
  const byName = new Map(files.map((f) => [f.name, f]));
  const manifestFile = byName.get("manifest.json");
  const entriesFile = byName.get("entries.json");
  const verifyPyFile = byName.get("verify.py");
  if (!manifestFile || !entriesFile || !verifyPyFile) {
    throw new Error("self-check: export is missing manifest.json, entries.json, or verify.py");
  }
  if (dec.decode(verifyPyFile.bytes) !== VERIFY_PY) {
    throw new Error("self-check: verify.py in the zip does not match the shipped verifier");
  }
  const readManifest = JSON.parse(dec.decode(manifestFile.bytes));
  const readEntries = JSON.parse(dec.decode(entriesFile.bytes));
  if (readManifest.head !== manifest.head || readManifest.count !== manifest.count) {
    throw new Error("self-check: manifest in the zip does not match what was recorded");
  }
  if (readEntries.length !== entriesOut.length) {
    throw new Error("self-check: entries.json entry count does not match");
  }
  let prev = GENESIS;
  for (let i = 0; i < readEntries.length; i++) {
    const e = readEntries[i];
    if (e.seq !== i + 1) throw new Error(`self-check: entry ${i} has seq ${e.seq}`);
    prev = await entryHash(prev, e);
    if (e.file) {
      const f = byName.get(`files/${pad(e.seq)}-${e._filename}`);
      if (!f) throw new Error(`self-check: missing attachment for entry ${e.seq}`);
      const digest = await sha256Hex(f.bytes);
      if (digest !== e.file.sha256) throw new Error(`self-check: attachment hash mismatch for entry ${e.seq}`);
    }
  }
  if (prev !== manifest.head) throw new Error("self-check: recomputed head does not match the manifest");
}

export async function buildExport() {
  const rows = await listEntries();
  const { head, count } = headState();
  const files = [];
  const entriesOut = [];
  for (const { entry } of rows) {
    const out = JSON.parse(canonical(entry));
    if (entry.file) {
      const bytes = await getFile(entry.seq);
      const fname = safeName(entry.file.name);
      out._filename = fname;
      files.push({ name: `files/${pad(entry.seq)}-${fname}`, bytes });
    }
    entriesOut.push(out);
  }
  const manifest = {
    format: "magpie-export",
    v: 1,
    genesis: "magpie-genesis-v1",
    algorithm: "sha256(prev_hash + \"\\n\" + canonical_entry_json)",
    head,
    count,
    generated_at: new Date().toISOString(),
  };
  const zip = buildZip([
    { name: "manifest.json", bytes: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "entries.json", bytes: enc.encode(JSON.stringify(entriesOut, null, 2)) },
    { name: "VERIFY.md", bytes: enc.encode(VERIFY_MD) },
    { name: "verify.py", bytes: enc.encode(VERIFY_PY) },
    ...files,
  ]);
  await selfVerifyExport(zip, manifest, entriesOut);
  return { zip, head, count };
}
