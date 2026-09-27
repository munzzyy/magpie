// The chain badge used to read "1 entries, chain intact". These pin the
// singular in both shipped languages, using the templates main.js passes.

import test from "node:test";
import assert from "node:assert/strict";
import { setLocale, tn } from "../app/js/i18n.js";

const BADGE = ["{count} entry, chain intact", "{count} entries, chain intact"];
const VERIFY = ["Chain intact: {count} entry verifies.", "Chain intact: {count} entries verify."];

test("one entry takes the singular in English", () => {
  setLocale("en");
  assert.equal(tn(1, ...BADGE), "1 entry, chain intact");
  assert.equal(tn(2, ...BADGE), "2 entries, chain intact");
  assert.equal(tn(0, ...BADGE), "0 entries, chain intact");
  assert.equal(tn(1, ...VERIFY), "Chain intact: 1 entry verifies.");
  assert.equal(tn(12, ...VERIFY), "Chain intact: 12 entries verify.");
});

test("one entry takes the singular in Spanish", () => {
  setLocale("es");
  try {
    assert.equal(tn(1, ...BADGE), "1 entrada, cadena intacta");
    assert.equal(tn(3, ...BADGE), "3 entradas, cadena intacta");
    assert.equal(tn(1, ...VERIFY), "Cadena intacta: 1 entrada verifica.");
    assert.equal(tn(3, ...VERIFY), "Cadena intacta: 3 entradas verifican.");
  } finally {
    setLocale("en");
  }
});

test("a count passed in vars cannot override the real one", () => {
  setLocale("en");
  assert.equal(tn(1, ...BADGE, { count: 9 }), "1 entry, chain intact");
});
