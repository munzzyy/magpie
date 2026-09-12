// The vault: one lock, one key, fail closed. Every read or write of entry
// data passes through here, and every one of them throws while locked. The
// key lives in this module's closure only; locking drops it, and nothing
// is ever written to storage unencrypted. That invariant is the app.

import { deriveKey, seal, open, sealText, openText, randomBytes, KDF_ITERS } from "./cryptobox.js";
import { canonical, makeEntry } from "./canon.js";
import { entryHash, verifyChain, GENESIS, sha256Hex } from "./chain.js";

const DB_NAME = "magpie";
const DB_VERSION = 1;
const CHECK_TEXT = "magpie-ok-v1";

export class LockedError extends Error {
  constructor() {
    super("vault is locked");
  }
}

// Thrown by restoreBackup with a stable machine-readable code (never raw
// English) so the UI can translate the reason instead of showing it as-is.
export class RestoreBlockedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

let db = null;
let key = null;
let head = GENESIS;
let count = 0;

function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("meta");
      d.createObjectStore("entries");
      d.createObjectStore("files");
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
      }),
  );
}

const get = (store, k) =>
  idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const req = d.transaction(store).objectStore(store).get(k);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      }),
  );

// Every {key, value} pair in a store, in cursor order, read inside one
// transaction so a concurrent write cannot interleave a partial view.
const getAllWithKeys = (store) =>
  idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const out = [];
        const req = d.transaction(store).objectStore(store).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            out.push({ key: cursor.key, value: cursor.value });
            cursor.continue();
          } else {
            resolve(out);
          }
        };
        req.onerror = () => reject(req.error);
      }),
  );

const guard = () => {
  if (!key) throw new LockedError();
};

export const isLocked = () => !key;
export const isSetUp = async () => !!(await get("meta", "kdf"));
export const headState = () => {
  guard();
  return { head, count };
};

export async function setup(passphrase) {
  const salt = randomBytes(16);
  const k = await deriveKey(passphrase, salt, KDF_ITERS);
  const check = await sealText(k, CHECK_TEXT, "check");
  await tx("meta", "readwrite", (s) => {
    s.put({ salt, iters: KDF_ITERS, check }, "kdf");
  });
  key = k;
  head = GENESIS;
  count = 0;
  await saveState();
  // Best-effort: ask the browser not to evict this origin's storage under
  // pressure. A plain Safari tab and an installed Home Screen copy get
  // separate storage containers either way; this only changes eviction
  // behavior within whichever one the journal was created in.
  try {
    await navigator.storage?.persist?.();
  } catch {}
}

export async function unlock(passphrase) {
  const kdf = await get("meta", "kdf");
  if (!kdf) throw new Error("not set up");
  const k = await deriveKey(passphrase, kdf.salt, kdf.iters);
  try {
    const text = await openText(k, kdf.check, "check");
    if (text !== CHECK_TEXT) return false;
  } catch {
    return false;
  }
  key = k;
  const state = await get("meta", "state");
  if (state) {
    const parsed = JSON.parse(await openText(key, state, "state"));
    head = parsed.head;
    count = parsed.count;
  } else {
    head = GENESIS;
    count = 0;
  }
  return true;
}

export function lock() {
  key = null;
  head = GENESIS;
  count = 0;
}

async function saveState() {
  guard();
  const box = await sealText(key, JSON.stringify({ head, count }), "state");
  await tx("meta", "readwrite", (s) => {
    s.put(box, "state");
  });
}

// The anchor record: proof that a export was actually handed off, and
// through which entry. It carries the same information the old plaintext
// "magpie-last-export" localStorage timestamp did, but sealed under the
// vault key like everything else the vault remembers; a device backup or a
// stolen localStorage dump used to leak "this vault has been active since
// roughly X" for free, and now it does not.
export async function getAnchor() {
  guard();
  const box = await get("meta", "anchor");
  if (!box) return null;
  try {
    return JSON.parse(await openText(key, box, "anchor"));
  } catch {
    return null;
  }
}

export async function setAnchor(anchor) {
  guard();
  const box = await sealText(key, JSON.stringify(anchor), "anchor");
  await tx("meta", "readwrite", (s) => {
    s.put(box, "anchor");
  });
}

// Adds an entry (and its file bytes, if any) atomically with the chain
// advance: record, file, and encrypted state land in ONE transaction, and
// the in-memory chain only moves after it commits. add(), never put(), so
// a sequence collision (a second unlocked tab, a stale state box after a
// crash) throws instead of silently replacing committed evidence; on that
// collision the state is re-read and the entry retried once at the real
// head. The whole thing runs under a cross-tab lock where the platform
// offers one.
export async function addEntry(args) {
  guard();
  const run = () => addEntryOnce(args);
  if (navigator.locks?.request) {
    return navigator.locks.request("magpie-vault-write", run);
  }
  return run();
}

async function reloadState() {
  guard();
  const state = await get("meta", "state");
  if (state) {
    const parsed = JSON.parse(await openText(key, state, "state"));
    head = parsed.head;
    count = parsed.count;
  }
}

async function addEntryOnce({ type, title, note, fileBytes, fileName, fileMime }, retried = false) {
  guard();
  await reloadState();
  let file = null;
  if (fileBytes) {
    file = {
      name: fileName || "file",
      mime: fileMime || "application/octet-stream",
      size: fileBytes.length,
      sha256: await sha256Hex(fileBytes),
    };
  }
  const entry = makeEntry({
    seq: count + 1,
    ts: new Date().toISOString(),
    type,
    title,
    note,
    file,
  });
  const hash = await entryHash(head, entry);
  const entryBox = await seal(key, new TextEncoder().encode(canonical(entry)), `entry:${entry.seq}`);
  const fileBox = fileBytes ? await seal(key, fileBytes, `file:${entry.seq}`) : null;
  const stateBox = await sealText(key, JSON.stringify({ head: hash, count: entry.seq }), "state");
  const d = await idb();
  try {
    await new Promise((resolve, reject) => {
      const t = d.transaction(["entries", "files", "meta"], "readwrite");
      t.objectStore("entries").add({ box: entryBox, hash }, entry.seq);
      if (fileBox) t.objectStore("files").put(fileBox, entry.seq);
      t.objectStore("meta").put(stateBox, "state");
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (err) {
    if (!retried && err?.name === "ConstraintError") {
      // Seq N already exists: another tab won the race, or a crash left a
      // committed entry the state box never heard about. The store is the
      // truth; walk forward to the real head and chain after it.
      await reloadState();
      let probe;
      while ((probe = await get("entries", count + 1))) {
        head = probe.hash;
        count = count + 1;
      }
      const stateFix = await sealText(key, JSON.stringify({ head, count }), "state");
      await tx("meta", "readwrite", (s) => {
        s.put(stateFix, "state");
      });
      return addEntryOnce({ type, title, note, fileBytes, fileName, fileMime }, true);
    }
    throw err;
  }
  head = hash;
  count = entry.seq;
  return { entry, hash };
}

export async function listEntries() {
  guard();
  const out = [];
  for (let seq = 1; seq <= count; seq++) {
    const rec = await get("entries", seq);
    if (!rec) break;
    const entry = JSON.parse(await openText(key, rec.box, `entry:${seq}`));
    out.push({ entry, hash: rec.hash });
  }
  return out;
}

export async function getFile(seq) {
  guard();
  const box = await get("files", seq);
  if (!box) return null;
  return open(key, box, `file:${seq}`);
}

// Full chain recomputation against the stored records. The stored row
// count must equal the encrypted state's count, and every entry with file
// metadata must still have its sealed attachment; a green badge over a
// hollowed-out vault is the failure mode this exists to prevent.
export async function verify() {
  guard();
  const rows = await listEntries();
  if (rows.length !== count) {
    return { ok: false, head, count: rows.length, badSeq: rows.length + 1 };
  }
  for (const { entry } of rows) {
    if (entry.file && !(await get("files", entry.seq))) {
      return { ok: false, head, count: rows.length, badSeq: entry.seq };
    }
  }
  return verifyChain(
    rows.map((r) => r.entry),
    rows.map((r) => r.hash),
    head,
  );
}

// Destroys everything. The caller owns the confirmation ceremony.
export async function wipe() {
  lock();
  await idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(["meta", "entries", "files"], "readwrite");
        t.objectStore("meta").clear();
        t.objectStore("entries").clear();
        t.objectStore("files").clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      }),
  );
}

// -------------------------------------------------------------- backup

// A sealed backup is ONE encrypted envelope: every record is unpacked from
// IndexedDB, bundled into a single plaintext blob, and sealed as one
// AES-GCM box under the live vault key. Nothing about that bundle is
// visible from outside the box, not the entry count, not the per-entry
// hashes, not the head, not when it was made: the only plaintext left in
// the file is the KDF salt and iteration count, which have to stay
// readable to derive a key from a passphrase at all, exactly like the
// vault's own meta.kdf record already is. Restoring needs the exact
// passphrase that sealed it: deriving the wrong key and failing to open
// this envelope look identical, on purpose, because AES-GCM cannot (and
// should not be made to) tell "wrong key" apart from "tampered ciphertext".

const toB64 = (bytes) => {
  // Chunked because String.fromCharCode(...bigArray) blows the argument limit
  // once a real attachment is in the box, which is exactly what a backup carries.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const boxOut = (box) => ({ iv: toB64(box.iv), ct: toB64(box.ct) });
const boxIn = (o) => ({ iv: fromB64(o.iv), ct: fromB64(o.ct) });

export async function exportBackup() {
  guard();
  const kdf = await get("meta", "kdf");
  const state = await get("meta", "state");
  const anchor = await get("meta", "anchor");
  const entryRows = await getAllWithKeys("entries");
  const fileRows = await getAllWithKeys("files");
  const inner = {
    kdf: { check: boxOut(kdf.check) },
    state: state ? boxOut(state) : null,
    anchor: anchor ? boxOut(anchor) : null,
    entries: entryRows.map(({ key: seq, value }) => ({ seq, hash: value.hash, box: boxOut(value.box) })),
    files: fileRows.map(({ key: seq, value }) => ({ seq, box: boxOut(value) })),
    generated_at: new Date().toISOString(),
  };
  const outer = await seal(key, new TextEncoder().encode(JSON.stringify(inner)), "backup");
  const out = {
    format: "magpie-backup",
    v: 2,
    salt: toB64(kdf.salt),
    iters: kdf.iters,
    box: boxOut(outer),
  };
  return new TextEncoder().encode(JSON.stringify(out));
}

// Restores a sealed backup, but only onto a device with no journal yet: a
// silent overwrite of a live vault is worse than refusing. The outer
// envelope is opened first; only once that succeeds does anything inside
// it exist in memory, and the chain is recomputed and every attachment
// opened BEFORE anything reaches storage, so a tampered or corrupt backup
// writes nothing at all, not even a partial vault.
export async function restoreBackup(bytes, passphrase) {
  if (await isSetUp()) throw new RestoreBlockedError("already-set-up");

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RestoreBlockedError("not-a-backup");
  }
  if (
    parsed?.format !== "magpie-backup" ||
    parsed.v !== 2 ||
    typeof parsed.salt !== "string" ||
    !Number.isFinite(parsed.iters) ||
    typeof parsed.box?.iv !== "string" ||
    typeof parsed.box?.ct !== "string"
  ) {
    // Also what an untouched v1 (pre-outer-envelope) backup file hits: that
    // format never shipped, and there is no migration path for it.
    throw new RestoreBlockedError("not-a-backup");
  }

  let salt, k;
  try {
    salt = fromB64(parsed.salt);
    k = await deriveKey(passphrase, salt, parsed.iters);
  } catch {
    throw new RestoreBlockedError("not-a-backup");
  }

  let inner;
  try {
    const plaintext = await open(k, boxIn(parsed.box), "backup");
    inner = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new RestoreBlockedError("wrong-passphrase");
  }

  // A genuine backup always carries a state box: setup() writes one in the
  // same breath it writes the KDF record. One stripped out is a hollowed-out
  // tamper wearing an empty vault's clothes, not a legitimately empty vault,
  // and the outer envelope opening cleanly does not excuse it.
  if (!inner || typeof inner !== "object" || !inner.kdf?.check || !inner.state) {
    throw new RestoreBlockedError("corrupt");
  }

  let checkText;
  try {
    checkText = await openText(k, boxIn(inner.kdf.check), "check");
  } catch {
    throw new RestoreBlockedError("corrupt");
  }
  if (checkText !== CHECK_TEXT) throw new RestoreBlockedError("corrupt");

  const decrypted = [];
  for (const e of inner.entries || []) {
    let entry;
    try {
      entry = JSON.parse(await openText(k, boxIn(e.box), `entry:${e.seq}`));
    } catch {
      throw new RestoreBlockedError("corrupt");
    }
    decrypted.push({ entry, hash: e.hash });
  }
  decrypted.sort((a, b) => a.entry.seq - b.entry.seq);

  let recordedHead;
  try {
    recordedHead = JSON.parse(await openText(k, boxIn(inner.state), "state")).head;
  } catch {
    throw new RestoreBlockedError("corrupt");
  }

  const result = await verifyChain(
    decrypted.map((r) => r.entry),
    decrypted.map((r) => r.hash),
    recordedHead,
  );
  if (!result.ok) throw new RestoreBlockedError("chain-invalid");

  // A green chain over a hollowed-out backup is the same failure mode
  // verify() already refuses to certify: every entry that claims a file
  // must actually have one, and it must open.
  const fileMap = new Map((inner.files || []).map((f) => [f.seq, f.box]));
  for (const { entry } of decrypted) {
    if (!entry.file) continue;
    const box = fileMap.get(entry.seq);
    if (!box) throw new RestoreBlockedError("corrupt");
    try {
      await open(k, boxIn(box), `file:${entry.seq}`);
    } catch {
      throw new RestoreBlockedError("corrupt");
    }
  }

  const d = await idb();
  await new Promise((resolve, reject) => {
    const t = d.transaction(["meta", "entries", "files"], "readwrite");
    t.objectStore("meta").put({ salt, iters: parsed.iters, check: boxIn(inner.kdf.check) }, "kdf");
    t.objectStore("meta").put(boxIn(inner.state), "state");
    if (inner.anchor) t.objectStore("meta").put(boxIn(inner.anchor), "anchor");
    for (const e of inner.entries || []) t.objectStore("entries").put({ box: boxIn(e.box), hash: e.hash }, e.seq);
    for (const f of inner.files || []) t.objectStore("files").put(boxIn(f.box), f.seq);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

  key = k;
  head = result.head;
  count = result.count;
  try {
    await navigator.storage?.persist?.();
  } catch {}
  return { count };
}
