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

// count(), not get(): checking that an attachment exists must not read every sealed file out of storage.
const missingFiles = (seqs) =>
  idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const store = d.transaction("files").objectStore("files");
        const missing = [];
        for (const seq of seqs) {
          const req = store.count(seq);
          req.onsuccess = () => {
            if (!req.result) missing.push(seq);
          };
        }
        store.transaction.oncomplete = () => resolve(missing.sort((a, b) => a - b));
        store.transaction.onerror = () => reject(store.transaction.error);
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

// add(), not put(), for the KDF record: a second tab on the setup screen must not replace this journal.
export async function setup(passphrase) {
  const salt = randomBytes(16);
  const k = await deriveKey(passphrase, salt, KDF_ITERS);
  const check = await sealText(k, CHECK_TEXT, "check");
  const stateBox = await sealText(k, JSON.stringify({ head: GENESIS, count: 0 }), "state");
  const d = await idb();
  try {
    await new Promise((resolve, reject) => {
      const t = d.transaction("meta", "readwrite");
      t.objectStore("meta").add({ salt, iters: KDF_ITERS, check }, "kdf");
      t.objectStore("meta").put(stateBox, "state");
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error);
    });
  } catch (err) {
    if (err?.name === "ConstraintError") throw new RestoreBlockedError("already-set-up");
    throw err;
  }
  key = k;
  head = GENESIS;
  count = 0;
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
  const missing = await missingFiles(rows.filter((r) => r.entry.file).map((r) => r.entry.seq));
  if (missing.length) return { ok: false, head, count: rows.length, badSeq: missing[0] };
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

// v3 file: a JSON header line (salt, iters, chunk, a random id, the sealed check box), then chunks of
// IV + AES-GCM(chunk bytes, fewer in the last) under AAD backup:<id>:<index>:last|more. Inside them, records
// of a 4-byte big-endian length + JSON: meta, then a file record plus its ciphertext per attachment, then end.
const BACKUP_CHUNK = 512 * 1024;
const HEADER_MAX = 4096;
const backupAad = (id, index, last) => `backup:${id}:${index}:${last ? "last" : "more"}`;

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
const isBox = (o) => typeof o?.iv === "string" && typeof o?.ct === "string";

// The small records in one transaction, so a write from another tab cannot land between them.
const snapshot = () =>
  idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(["meta", "entries", "files"]);
        const out = { entries: [], fileSeqs: [] };
        const meta = t.objectStore("meta");
        for (const name of ["kdf", "state", "anchor"]) {
          const req = meta.get(name);
          req.onsuccess = () => {
            out[name] = req.result ?? null;
          };
        }
        const cursor = t.objectStore("entries").openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          out.entries.push({ seq: c.key, hash: c.value.hash, box: boxOut(c.value.box) });
          c.continue();
        };
        const keys = t.objectStore("files").getAllKeys();
        keys.onsuccess = () => {
          out.fileSeqs = keys.result;
        };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      }),
  );

function chunkSealer(k, id) {
  const parts = [];
  const buf = new Uint8Array(BACKUP_CHUNK);
  let fill = 0;
  const sealChunk = async (last) => {
    const box = await seal(k, buf.subarray(0, fill), backupAad(id, parts.length, last));
    const part = new Uint8Array(box.iv.length + box.ct.length);
    part.set(box.iv);
    part.set(box.ct, box.iv.length);
    parts.push(part);
    fill = 0;
  };
  const push = async (bytes) => {
    for (let at = 0; at < bytes.length; ) {
      // A full chunk is sealed only once more bytes arrive, so the last one is never empty.
      if (fill === BACKUP_CHUNK) await sealChunk(false);
      const take = Math.min(bytes.length - at, BACKUP_CHUNK - fill);
      buf.set(bytes.subarray(at, at + take), fill);
      fill += take;
      at += take;
    }
  };
  const record = async (obj, payload) => {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    const n = json.length;
    await push(new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
    await push(json);
    if (payload) await push(payload);
  };
  const finish = async () => {
    await sealChunk(true);
    return parts;
  };
  return { record, finish };
}

// A list of byte parts, not a Blob: WebView caps Blob storage, so only the web download makes one.
export async function exportBackup() {
  guard();
  const k = key;
  const snap = await snapshot();
  const id = toB64(randomBytes(16));
  const header = {
    format: "magpie-backup",
    v: 3,
    salt: toB64(snap.kdf.salt),
    iters: snap.kdf.iters,
    chunk: BACKUP_CHUNK,
    id,
    check: boxOut(snap.kdf.check),
  };
  const out = chunkSealer(k, id);
  await out.record({
    t: "meta",
    state: snap.state ? boxOut(snap.state) : null,
    anchor: snap.anchor ? boxOut(snap.anchor) : null,
    entries: snap.entries,
    generated_at: new Date().toISOString(),
  });
  for (const seq of snap.fileSeqs) {
    guard();
    const box = await get("files", seq);
    if (!box) throw new Error(`file ${seq} vanished during the backup`);
    await out.record({ t: "file", seq, iv: toB64(box.iv), n: box.ct.length }, box.ct);
  }
  await out.record({ t: "end" });
  return [new TextEncoder().encode(JSON.stringify(header) + "\n"), ...(await out.finish())];
}

// One chunk in memory at a time; a chunk moved, dropped or wrongly marked last fails to open.
function chunkReader(blob, start, h, k) {
  const sealed = h.chunk + 12 + 16;
  const total = Math.ceil((blob.size - start) / sealed);
  let index = 0;
  let cur = new Uint8Array(0);
  let pos = 0;
  const next = async () => {
    if (index >= total) return false;
    const at = start + index * sealed;
    const raw = new Uint8Array(await blob.slice(at, at + sealed).arrayBuffer());
    cur = await open(k, { iv: raw.subarray(0, 12), ct: raw.subarray(12) }, backupAad(h.id, index, index === total - 1));
    index++;
    pos = 0;
    return true;
  };
  const bytes = async (n) => {
    if (!Number.isInteger(n) || n < 0 || n > blob.size) throw new Error("bad length");
    const out = new Uint8Array(n);
    for (let got = 0; got < n; ) {
      if (pos === cur.length && !(await next())) throw new Error("ends early");
      const take = Math.min(n - got, cur.length - pos);
      out.set(cur.subarray(pos, pos + take), got);
      got += take;
      pos += take;
    }
    return out;
  };
  const record = async () => {
    const b = await bytes(4);
    return JSON.parse(new TextDecoder().decode(await bytes(b[0] * 0x1000000 + (b[1] << 16) + (b[2] << 8) + b[3])));
  };
  const done = () => index === total && pos === cur.length;
  return { bytes, record, done };
}

async function keyFor(passphrase, salt, iters) {
  try {
    const s = fromB64(salt);
    return { salt: s, k: await deriveKey(passphrase, s, iters) };
  } catch {
    throw new RestoreBlockedError("not-a-backup");
  }
}

async function readV3(blob, headerBytes, start, passphrase) {
  let h;
  try {
    h = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    throw new RestoreBlockedError("not-a-backup");
  }
  if (
    h?.format !== "magpie-backup" ||
    h.v !== 3 ||
    typeof h.salt !== "string" ||
    !Number.isFinite(h.iters) ||
    !Number.isInteger(h.chunk) ||
    h.chunk < 1024 ||
    h.chunk > 16 * 1024 * 1024 ||
    typeof h.id !== "string" ||
    !isBox(h.check)
  ) {
    throw new RestoreBlockedError("not-a-backup");
  }
  const { salt, k } = await keyFor(passphrase, h.salt, h.iters);
  try {
    if ((await openText(k, boxIn(h.check), "check")) !== CHECK_TEXT) throw new Error("check");
  } catch {
    throw new RestoreBlockedError("wrong-passphrase");
  }

  try {
    const r = chunkReader(blob, start, h, k);
    const meta = await r.record();
    if (meta?.t !== "meta" || !Array.isArray(meta.entries)) throw new Error("no meta");
    const files = new Map();
    for (;;) {
      const rec = await r.record();
      if (rec?.t === "end") break;
      if (rec?.t !== "file" || !Number.isInteger(rec.seq) || typeof rec.iv !== "string") throw new Error("bad record");
      files.set(rec.seq, { iv: fromB64(rec.iv), ct: await r.bytes(rec.n) });
    }
    if (!r.done()) throw new Error("trailing chunks");
    return {
      k,
      salt,
      iters: h.iters,
      check: boxIn(h.check),
      state: isBox(meta.state) ? boxIn(meta.state) : null,
      anchor: isBox(meta.anchor) ? boxIn(meta.anchor) : null,
      entries: meta.entries.map((e) => ({ seq: e.seq, hash: e.hash, box: boxIn(e.box) })),
      files,
    };
  } catch {
    throw new RestoreBlockedError("corrupt");
  }
}

// v2 (0.4.0 to 0.5.1) is one JSON object around one sealed box, and those files are out there for good.
async function readV2(blob, passphrase) {
  let parsed;
  try {
    parsed = JSON.parse(await blob.text());
  } catch {
    throw new RestoreBlockedError("not-a-backup");
  }
  if (
    parsed?.format !== "magpie-backup" ||
    parsed.v !== 2 ||
    typeof parsed.salt !== "string" ||
    !Number.isFinite(parsed.iters) ||
    !isBox(parsed.box)
  ) {
    // Also what an untouched v1 (pre-outer-envelope) backup file hits: that
    // format never shipped, and there is no migration path for it.
    throw new RestoreBlockedError("not-a-backup");
  }
  const { salt, k } = await keyFor(passphrase, parsed.salt, parsed.iters);

  // Deriving the wrong key and failing to open this envelope look the same, on purpose: AES-GCM cannot tell them apart.
  let inner;
  try {
    inner = JSON.parse(new TextDecoder().decode(await open(k, boxIn(parsed.box), "backup")));
  } catch {
    throw new RestoreBlockedError("wrong-passphrase");
  }
  if (!inner || typeof inner !== "object" || !isBox(inner.kdf?.check)) throw new RestoreBlockedError("corrupt");
  const check = boxIn(inner.kdf.check);
  try {
    if ((await openText(k, check, "check")) !== CHECK_TEXT) throw new Error("check");
    return {
      k,
      salt,
      iters: parsed.iters,
      check,
      state: isBox(inner.state) ? boxIn(inner.state) : null,
      anchor: isBox(inner.anchor) ? boxIn(inner.anchor) : null,
      entries: (inner.entries || []).map((e) => ({ seq: e.seq, hash: e.hash, box: boxIn(e.box) })),
      files: new Map((inner.files || []).map((f) => [f.seq, boxIn(f.box)])),
    };
  } catch {
    throw new RestoreBlockedError("corrupt");
  }
}

// Restores a sealed backup, but only onto a device with no journal yet: a
// silent overwrite of a live vault is worse than refusing. The chain is
// recomputed and every attachment opened BEFORE anything reaches storage,
// so a tampered or corrupt backup writes nothing at all, not even a
// partial vault.
export async function restoreBackup(file, passphrase) {
  if (await isSetUp()) throw new RestoreBlockedError("already-set-up");
  const blob = file instanceof Blob ? file : new Blob([file]);
  const first = new Uint8Array(await blob.slice(0, HEADER_MAX).arrayBuffer());
  // JSON.stringify never writes a raw newline, so a v2 file has none.
  const newline = first.indexOf(10);
  if (newline < 0 && !new TextDecoder().decode(first).startsWith('{"format":"magpie-backup"')) throw new RestoreBlockedError("not-a-backup");
  const b = newline < 0 ? await readV2(blob, passphrase) : await readV3(blob, first.subarray(0, newline), newline + 1, passphrase);

  // A genuine backup always carries a state box: setup() writes one in the
  // same breath it writes the KDF record. One stripped out is a hollowed-out
  // tamper wearing an empty vault's clothes, not a legitimately empty vault,
  // and the outer envelope opening cleanly does not excuse it.
  if (!b.state) throw new RestoreBlockedError("corrupt");

  const decrypted = [];
  for (const e of b.entries) {
    let entry;
    try {
      entry = JSON.parse(await openText(b.k, e.box, `entry:${e.seq}`));
    } catch {
      throw new RestoreBlockedError("corrupt");
    }
    decrypted.push({ entry, hash: e.hash });
  }
  decrypted.sort((x, y) => x.entry.seq - y.entry.seq);

  let recordedHead;
  try {
    recordedHead = JSON.parse(await openText(b.k, b.state, "state")).head;
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
  for (const { entry } of decrypted) {
    if (!entry.file) continue;
    const box = b.files.get(entry.seq);
    if (!box) throw new RestoreBlockedError("corrupt");
    try {
      await open(b.k, box, `file:${entry.seq}`);
    } catch {
      throw new RestoreBlockedError("corrupt");
    }
  }

  // add() again: another tab may have created a journal since the isSetUp() check above.
  const d = await idb();
  try {
    await new Promise((resolve, reject) => {
      const t = d.transaction(["meta", "entries", "files"], "readwrite");
      t.objectStore("meta").add({ salt: b.salt, iters: b.iters, check: b.check }, "kdf");
      t.objectStore("meta").put(b.state, "state");
      if (b.anchor) t.objectStore("meta").put(b.anchor, "anchor");
      for (const e of b.entries) t.objectStore("entries").put({ box: e.box, hash: e.hash }, e.seq);
      for (const [seq, box] of b.files) t.objectStore("files").put(box, seq);
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error);
    });
  } catch (err) {
    if (err?.name === "ConstraintError") throw new RestoreBlockedError("already-set-up");
    throw err;
  }

  key = b.k;
  head = result.head;
  count = result.count;
  try {
    await navigator.storage?.persist?.();
  } catch {}
  return { count };
}
