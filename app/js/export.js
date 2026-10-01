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

export const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";

export const VERIFY_PY = `#!/usr/bin/env python3
# Verifies a Magpie export without Magpie: recomputes the hash chain and
# every attachment digest. Needs only the Python standard library.
#   python3 verify.py
#   python3 verify.py --extends /path/to/an/earlier/export
#   python3 verify.py --anchor HEAD_HASH_SHARED_EARLIER
import argparse, hashlib, json, os, re, sys

KEYS = ["v", "seq", "ts", "type", "title", "note", "file"]
FILE_KEYS = ["name", "mime", "size", "sha256"]
SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")

class Bad(Exception):
    pass

def canonical(e):
    parts = []
    for k in KEYS:
        v = e.get(k)
        if k == "file" and v is not None:
            v = {fk: v.get(fk) for fk in FILE_KEYS}
        parts.append(json.dumps(k) + ":" + json.dumps(v, ensure_ascii=False, separators=(",", ":")))
    # A lone surrogate: JSON.stringify escapes it, json.dumps leaves it raw, .encode() refuses it.
    return re.sub("[\\ud800-\\udfff]", lambda m: "\\\\u%04x" % ord(m.group()), "{" + ",".join(parts) + "}")

def safe_name(name):
    # export.js safeName; its regex has no u flag, so an astral character becomes two underscores.
    out = "".join(c if c in SAFE else "__" if ord(c) > 0xFFFF else "_" for c in name)
    return out[:80] or "file"

def load_json(base, name):
    path = os.path.join(base, name)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise Bad(f"{name} is missing from {base}")
    except (OSError, ValueError) as err:
        raise Bad(f"{name} in {base} could not be read as JSON ({err})")

def load(base):
    manifest = load_json(base, "manifest.json")
    entries = load_json(base, "entries.json")
    if not isinstance(manifest, dict) or not all(isinstance(manifest.get(k), str) for k in ("genesis", "head")):
        raise Bad(f"manifest.json in {base} has no genesis or head")
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        raise Bad(f"entries.json in {base} is not a list of entries")
    return manifest, entries

def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()

def verify_chain(base, manifest, entries):
    # heads[i] is the head after entry i + 1. A clock going backwards is a warning, never a failure.
    prev = manifest["genesis"]
    heads = []
    covered = set()
    prev_ts = None
    warn_seq = None
    for i, e in enumerate(entries):
        seq = e.get("seq")
        if seq != i + 1:
            raise Bad(f"entry {i + 1} in entries.json has seq {seq!r}")
        f = e.get("file")
        if f is not None and not (isinstance(f, dict) and isinstance(f.get("name"), str) and isinstance(f.get("sha256"), str)):
            raise Bad(f"entry {seq}'s file record is malformed")
        prev = hashlib.sha256((prev + "\\n" + canonical(e)).encode()).hexdigest()
        heads.append(prev)
        if f is not None:
            # _filename sits outside the hash; only the chained name decides where the file lives.
            want = f"files/{seq:03d}-{safe_name(f['name'])}"
            got = f"files/{seq:03d}-{e.get('_filename')}"
            if got != want:
                raise Bad(f"entry {seq}'s attachment is listed as {got}, but its chained name makes it {want}")
            try:
                digest = file_digest(os.path.join(base, *want.split("/")))
            except OSError:
                raise Bad(f"the attachment for entry {seq} is missing ({want})")
            if digest != f["sha256"]:
                raise Bad(f"attachment for entry {seq} does not match its recorded hash")
            covered.add(want)
        ts = e.get("ts")
        if warn_seq is None and isinstance(prev_ts, str) and isinstance(ts, str) and ts < prev_ts:
            warn_seq = seq
        prev_ts = ts
    if prev != manifest["head"]:
        raise Bad(f"recomputed head {prev} != recorded head {manifest['head']}")
    return prev, heads, covered, warn_seq

def uncovered(base, covered):
    extra = []
    for dirpath, _, names in os.walk(os.path.join(base, "files")):
        for name in names:
            rel = os.path.relpath(os.path.join(dirpath, name), base).replace(os.sep, "/")
            if rel not in covered:
                extra.append(rel)
    return sorted(extra)

def run(args, anchors):
    base = os.path.dirname(os.path.abspath(__file__))
    manifest, entries = load(base)
    head, heads, covered, warn_seq = verify_chain(base, manifest, entries)
    n = len(entries)
    print("OK:", n, "entry verifies;" if n == 1 else "entries verify;", "head", head)
    extra = uncovered(base, covered)
    if extra:
        print("WARNING: not covered by the chain:")
        for rel in extra:
            print("  " + rel)
        print("No entry vouches for these files, so they prove nothing about the journal.")
    if warn_seq is not None:
        print(f"WARNING: entry {warn_seq}'s recorded time is earlier than the entry before it.")
        print("The chain still verifies. This only means a clock moved backward at some point,")
        print("not that anything was tampered with.")
    print("This proves the export matches its manifest. It proves the log")
    print("existed in this exact state no LATER than the earliest moment the")
    print("head hash was shared with someone else.")

    missed = False
    for a in anchors:
        if a in heads:
            print(f"ANCHOR: {a} is the head after entry {heads.index(a) + 1} of {n}")
        else:
            print(f"FAIL: {a} is not the head of this journal after any entry")
            missed = True
    if missed:
        sys.exit(1)
    if anchors:
        print("Each anchored entry, and every entry before it, existed exactly as it is")
        print("here by the time that hash was shared.")

    if args.extends:
        older_manifest, older_entries = load(args.extends)
        if older_manifest["genesis"] != manifest["genesis"]:
            raise Bad("the two exports do not share a genesis; they are not the same journal")
        try:
            verify_chain(args.extends, older_manifest, older_entries)
        except Bad as err:
            raise Bad(f"the older export does not verify on its own: {err}")
        older_count = len(older_entries)
        if older_count > n:
            raise Bad("the older export has more entries than this one; it cannot be a prefix")
        if ([manifest["genesis"]] + heads)[older_count] != older_manifest["head"]:
            raise Bad(f"this export does not extend {args.extends}; the chains diverge at or before entry {older_count}")
        print("EXTENDS: this export is an append-only continuation of", args.extends)
        print(f"the first {older_count} entries are byte-for-byte the same and share the head", older_manifest["head"])

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--extends", metavar="DIR", help="an earlier export this one must append-only extend")
    ap.add_argument("--anchor", metavar="HASH", action="append", default=[],
                    help="a head hash shared earlier (repeatable): names the entry it was the head after")
    args = ap.parse_args()
    anchors = []
    for a in args.anchor:
        if not re.fullmatch("[0-9a-fA-F]{64}", a):
            ap.error(f"--anchor takes a full 64-character hex head hash, not {a!r}")
        anchors.append(a.lower())
    try:
        run(args, anchors)
    except Bad as err:
        print("FAIL:", err)
        sys.exit(1)
    except Exception as err:
        print(f"FAIL: this export could not be checked ({type(err).__name__}: {err})")
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

export const VERIFY_MD = `# Verifying this export

This folder is self-proving. Run:

    python3 verify.py

On Windows the command is usually:

    py verify.py

It recomputes the whole hash chain and every attachment digest from
scratch. If anything in entries.json or files/ was edited, reordered,
renamed or removed after export, verification fails. A file added to
files/ afterwards doesn't fail it, but it is listed as not covered by the
chain: no entry vouches for it.

If you also have an earlier export of the same journal, point this one
at it and prove the newer export only ever appended to the older one,
never edited or reordered it:

    python3 verify.py --extends /path/to/the/older/export

If the head hash was shared earlier (emailed, texted, handed to a lawyer),
check that this export carries on from the exact record it pinned:

    python3 verify.py --anchor THE_HASH_THAT_WAS_SHARED

It names the entry that hash was the head after. That entry and every one
before it existed, exactly as they are here, by the time the hash was
shared. A hash from a different or rewritten journal fails.

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
