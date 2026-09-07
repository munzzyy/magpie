// Builds the export: a plain zip anyone can open, carrying the decrypted
// evidence, the chain manifest, and a standalone verifier script. The zip
// is the product; the app is just the pen.

import { buildZip } from "./zip.js";
import { canonical } from "./canon.js";
import { listEntries, getFile, headState } from "./vault.js";

const enc = new TextEncoder();

const pad = (n) => String(n).padStart(3, "0");

const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";

export const VERIFY_PY = `#!/usr/bin/env python3
# Verifies a Magpie export without Magpie: recomputes the hash chain and
# every attachment digest. Needs only the Python standard library.
#   python3 verify.py
import hashlib, json, os, sys

base = os.path.dirname(os.path.abspath(__file__))
manifest = json.load(open(os.path.join(base, "manifest.json")))
entries = json.load(open(os.path.join(base, "entries.json")))

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

prev = manifest["genesis"]
ok = True
for i, e in enumerate(entries):
    if e["seq"] != i + 1:
        print(f"FAIL: entry {i} has seq {e['seq']}"); ok = False; break
    h = hashlib.sha256((prev + "\\n" + canonical(e)).encode()).hexdigest()
    prev = h
    if e.get("file"):
        path = os.path.join(base, "files", f"{e['seq']:03d}-" + e["_filename"])
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
        if digest != e["file"]["sha256"]:
            print(f"FAIL: attachment for entry {e['seq']} does not match its recorded hash"); ok = False

if ok and prev != manifest["head"]:
    print("FAIL: recomputed head", prev, "!= recorded head", manifest["head"]); ok = False

if ok:
    print("OK:", len(entries), "entries verify; head", manifest["head"])
    print("This proves the export matches its manifest. It proves the log")
    print("existed in this exact state no LATER than the earliest moment the")
    print("head hash was shared with someone else.")
else:
    sys.exit(1)
`;

export const VERIFY_MD = `# Verifying this export

This folder is self-proving. Run:

    python3 verify.py

It recomputes the whole hash chain and every attachment digest from
scratch. If anything in entries.json or files/ was edited, reordered, or
removed after export, verification fails.

What that means, honestly: a valid chain proves this log existed in
exactly this state at whatever moment the head hash (in manifest.json)
was first shared with someone else. Share the head hash early: email it
to yourself, your lawyer, or a friend. The earlier it left your hands,
the more the chain proves.
`;

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
  return { zip, head, count };
}
