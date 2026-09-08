// The hash chain. Every entry's hash covers the previous hash plus its own
// canonical bytes, so reordering, editing, or deleting anything before the
// head changes the head. What that buys, honestly: an export (or just its
// head hash) shared at time T proves the log existed in exactly this state
// at T. It does not stop the vault's owner from rebuilding a different
// chain from scratch; anchoring the head early is what makes it evidence.

import { canonical } from "./canon.js";

export const GENESIS = "magpie-genesis-v1";

const enc = new TextEncoder();

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function entryHash(prevHash, entry) {
  return sha256Hex(enc.encode(`${prevHash}\n${canonical(entry)}`));
}

// Recomputes the whole chain. Returns { ok, head, count, badSeq, timeWarning }
// where badSeq is the first entry whose recorded hash does not match, or
// whose seq is out of order, and timeWarning is the first entry whose ts is
// earlier than the entry before it. The chain proves insertion order, not
// clock order, so a backwards timestamp is a warning, never a failure:
// clocks drift and phones change time zones, and refusing to record
// something because of that would be worse than the drift itself.
export async function verifyChain(entries, recordedHashes, recordedHead) {
  let prev = GENESIS;
  let prevTs = null;
  let timeWarning = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.seq !== i + 1) return { ok: false, head: prev, count: i, badSeq: entry.seq, timeWarning };
    const h = await entryHash(prev, entry);
    if (recordedHashes && recordedHashes[i] && recordedHashes[i] !== h) {
      return { ok: false, head: prev, count: i, badSeq: entry.seq, timeWarning };
    }
    if (timeWarning === null && prevTs !== null && entry.ts < prevTs) timeWarning = entry.seq;
    prevTs = entry.ts;
    prev = h;
  }
  // No emptiness exemption: a wiped entry store against a surviving head
  // must scream, not certify. A genuinely fresh vault has head === GENESIS
  // and passes on its own.
  if (recordedHead && recordedHead !== prev) {
    return { ok: false, head: prev, count: entries.length, badSeq: null, timeWarning };
  }
  return { ok: true, head: prev, count: entries.length, badSeq: null, timeWarning };
}
