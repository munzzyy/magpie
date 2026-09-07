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
