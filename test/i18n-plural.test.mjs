// The chain badge used to read "1 entries, chain intact". These pin the
// singular in both shipped languages, using the templates main.js passes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setLocale, tn } from "../app/js/i18n.js";
import { es } from "../app/js/strings-es.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const MORE = ["{count} more shared file waiting; it becomes its own entry.", "{count} more shared files waiting; each becomes its own entry."];
const DAYS = ["{count} day since your last export.", "{count} days since your last export."];
const PINNED = ["Pinned through entry {n}. {count} entry added since.", "Pinned through entry {n}. {count} entries added since."];
const RESTORED = ["Restored: {count} entry.", "Restored: {count} entries."];

const EXPECTED = {
  en: [
    [MORE, "1 more shared file waiting; it becomes its own entry.", "2 more shared files waiting; each becomes its own entry."],
    [DAYS, "1 day since your last export.", "2 days since your last export."],
    [PINNED, "Pinned through entry 4. 1 entry added since.", "Pinned through entry 4. 2 entries added since."],
    [RESTORED, "Restored: 1 entry.", "Restored: 2 entries."],
  ],
  es: [
    [MORE, "1 archivo compartido más en espera; será su propia entrada.", "2 archivos compartidos más en espera; cada uno será su propia entrada."],
    [DAYS, "1 día desde tu última exportación.", "2 días desde tu última exportación."],
    [PINNED, "Fijado hasta la entrada 4. 1 entrada añadida desde entonces.", "Fijado hasta la entrada 4. 2 entradas añadidas desde entonces."],
    [RESTORED, "Restaurado: 1 entrada.", "Restaurado: 2 entradas."],
  ],
};

for (const [code, rows] of Object.entries(EXPECTED)) {
  test(`shared files, days, pinned and restored counts read right at 1 and 2 (${code})`, () => {
    setLocale(code);
    try {
      for (const [templates, one, two] of rows) {
        assert.equal(tn(1, ...templates, { n: 4 }), one);
        assert.equal(tn(2, ...templates, { n: 4 }), two);
      }
    } finally {
      setLocale("en");
    }
  });
}

test("every tn() in main.js passes two different templates, both translated", () => {
  const src = readFileSync(path.join(ROOT, "app", "js", "main.js"), "utf8");
  const calls = [...src.matchAll(/\btn\(\s*[^,"()]+,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g)];
  assert.ok(calls.length >= 6, `found ${calls.length} tn() calls`);
  for (const [, one, other] of calls) {
    assert.notEqual(one, other);
    assert.ok(one in es && other in es, `${one} / ${other}`);
    assert.notEqual(es[one], es[other]);
  }
  assert.doesNotMatch(src, /\((s|ies)\)/);
  assert.doesNotMatch(Object.values(es).join("\n"), /\((s|es)\)|ad[ao]\(s\)/);
});
