import test from "node:test";
import assert from "node:assert/strict";
import { canonical, makeEntry } from "../app/js/canon.js";
import { entryHash, verifyChain, GENESIS, sha256Hex } from "../app/js/chain.js";

const entry = (seq, over = {}) =>
  makeEntry({ seq, ts: `2026-09-06T12:00:0${seq}.000Z`, type: "note", title: `t${seq}`, note: `n${seq}`, ...over });

test("canonical bytes are stable and key-ordered", () => {
  const a = canonical(entry(1));
  const shuffled = canonical({ note: "n1", title: "t1", type: "note", ts: "2026-09-06T12:00:01.000Z", seq: 1, v: 1, file: null });
  assert.equal(a, shuffled);
  assert.match(a, /^\{"v":1,"seq":1,"ts":/);
});

test("extra fields never reach the canonical bytes", () => {
  const sneaky = { ...entry(1), extra: "field", file: null };
  assert.equal(canonical(sneaky), canonical(entry(1)));
});

test("chain verifies and every tamper class is caught", async () => {
  const entries = [entry(1), entry(2), entry(3)];
  const hashes = [];
  let prev = GENESIS;
  for (const e of entries) {
    prev = await entryHash(prev, e);
    hashes.push(prev);
  }
  const good = await verifyChain(entries, hashes, prev);
  assert.equal(good.ok, true);
  assert.equal(good.count, 3);

  // Edit an early entry.
  const edited = [entry(1, { note: "changed later" }), entry(2), entry(3)];
  assert.equal((await verifyChain(edited, hashes, prev)).ok, false);

  // Delete from the middle (seq gap).
  assert.equal((await verifyChain([entries[0], entries[2]], null, prev)).ok, false);

  // Reorder.
  const reordered = [entries[1], entries[0], entries[2]];
  assert.equal((await verifyChain(reordered, null, prev)).ok, false);

  // Truncate and pretend the shorter chain is complete.
  assert.equal((await verifyChain(entries.slice(0, 2), hashes.slice(0, 2), prev)).ok, false);
});

test("negative control: an untouched chain never false-alarms", async () => {
  const entries = [];
  let prev = GENESIS;
  const hashes = [];
  for (let i = 1; i <= 25; i++) {
    const e = entry(i, { note: `unicode ✓ ${i} "quotes" \n newline` });
    entries.push(e);
    prev = await entryHash(prev, e);
    hashes.push(prev);
  }
  assert.equal((await verifyChain(entries, hashes, prev)).ok, true);
});

test("sha256Hex matches a known vector", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
