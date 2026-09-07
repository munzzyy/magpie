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
// advance. The ts is the device clock, recorded as UTC; the threat model
// is explicit that device time is claimable, not proven.
export async function addEntry({ type, title, note, fileBytes, fileName, fileMime }) {
  guard();
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
  const d = await idb();
  await new Promise((resolve, reject) => {
    const t = d.transaction(["entries", "files", "meta"], "readwrite");
    t.objectStore("entries").put({ box: entryBox, hash }, entry.seq);
    if (fileBox) t.objectStore("files").put(fileBox, entry.seq);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  head = hash;
  count = entry.seq;
  await saveState();
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

// Full chain recomputation against the stored records.
export async function verify() {
  guard();
  const rows = await listEntries();
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
