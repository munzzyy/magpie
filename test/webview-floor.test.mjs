// The Android app won't load the page on a WebView older than
// SystemCheck.MIN_WEBVIEW, so the page must not reach for anything newer.
// Features that only cost looks when missing (:focus-visible, scrollbar
// colors) are left out on purpose; everything here breaks layout or script.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const MIN = Number(
  readFileSync(join(root, "android/app/src/main/kotlin/io/github/munzzyy/magpie/SystemCheck.kt"), "utf8").match(/const val MIN_WEBVIEW = (\d+)/)[1],
);

const JS = [
  [85, "logical assignment", /[^=!<>]\s*(\?\?|\|\||&&)=[^=]/],
  [85, "String.replaceAll", /\.replaceAll\(/],
  [86, "replaceChildren", /\.replaceChildren\(/],
  [92, ".at()", /\.at\(\s*-?[\w.]*\s*\)/],
  [93, "Object.hasOwn", /\bObject\.hasOwn\(/],
  [94, "class static block", /\bstatic\s*\{/],
  [97, "findLast", /\.findLast(Index)?\(/],
  [98, "structuredClone", /\bstructuredClone\(/],
  [110, "change-array-by-copy", /\.(toSorted|toReversed|toSpliced)\(/],
  [117, "groupBy", /\b(Object|Map)\.groupBy\(/],
  [119, "Promise.withResolvers", /\bPromise\.withResolvers\b/],
  [120, "URL.canParse", /\bURL\.canParse\b/],
  [126, "URL.parse", /\bURL\.parse\(/],
  [137, "WebCrypto Ed25519", /["']Ed25519["']/],
  [140, "Uint8Array base64", /\bUint8Array\.fromBase64\b|\.toBase64\(\s*\)/],
];
const CSS = [
  [84, "flex gap", /(^|[;{\s])(row-|column-)?gap\s*:/],
  [87, "inset", /(^|[;{\s])inset\s*:/],
  [88, "aspect-ratio", /(^|[;{\s])aspect-ratio\s*:/],
  [88, ":is()/:where()", /:(is|where)\(/],
  [105, ":has()", /:has\(/],
  [105, "container queries", /@container|container-type\s*:/],
  [108, "dynamic viewport units", /\d(dvh|svh|lvh|dvw|svw|lvw)\b/],
  [111, "color-mix()", /color-mix\(/],
  [111, "oklch/lab", /\b(oklch|oklab|lch|lab)\(/],
  [112, "CSS nesting", /\{[^{}]*&[^{};]*\{/],
  [123, "light-dark()", /light-dark\(/],
];

function files(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");

function hits(table, paths) {
  const found = [];
  for (const p of paths) {
    const src = stripComments(readFileSync(p, "utf8"));
    for (const [v, what, re] of table) {
      if (v > MIN && re.test(src)) found.push(`${what} (Chromium ${v}) in ${p.slice(root.length)}`);
    }
  }
  return found;
}

test("the page uses nothing newer than MIN_WEBVIEW", () => {
  assert.ok(MIN >= 80, "optional chaining and ?? are everywhere, so 80 is the lowest this can be");
  const found = [
    ...hits(JS, files(join(root, "app"), [".js", ".mjs"])),
    ...hits(CSS, files(join(root, "app"), [".css"])),
  ];
  assert.deepEqual(found, [], `raise MIN_WEBVIEW or drop these:\n${found.join("\n")}`);
});
