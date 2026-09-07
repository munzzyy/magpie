import test from "node:test";
import assert from "node:assert/strict";
import { deriveKey, seal, open, sealText, openText, randomBytes } from "../app/js/cryptobox.js";

// Full-strength derivation is exercised once; the rest of the suite uses a
// lighter count so tests stay fast without touching production paths.
const FAST = 1000;

test("round trip, and the wrong passphrase fails closed", async () => {
  const salt = randomBytes(16);
  const key = await deriveKey("correct horse", salt, FAST);
  const box = await sealText(key, "secret text ✓", "aad1");
  assert.equal(await openText(key, box, "aad1"), "secret text ✓");

  const wrong = await deriveKey("correct horsf", salt, FAST);
  await assert.rejects(() => openText(wrong, box, "aad1"));
});

test("tampered ciphertext and tampered aad both fail", async () => {
  const key = await deriveKey("pass", randomBytes(16), FAST);
  const box = await seal(key, new TextEncoder().encode("payload"), "entry:1");
  const flipped = { iv: box.iv, ct: Uint8Array.from(box.ct) };
  flipped.ct[0] ^= 1;
  await assert.rejects(() => open(key, flipped, "entry:1"));
  await assert.rejects(() => open(key, box, "entry:2"));
});

test("ivs never repeat across seals", async () => {
  const key = await deriveKey("pass", randomBytes(16), FAST);
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const { iv } = await sealText(key, "x", "a");
    const hex = Buffer.from(iv).toString("hex");
    assert.ok(!seen.has(hex));
    seen.add(hex);
  }
});

test("production iteration count derives (slow path, run once)", async () => {
  const key = await deriveKey("p", randomBytes(16));
  const box = await sealText(key, "ok");
  assert.equal(await openText(key, box), "ok");
});
