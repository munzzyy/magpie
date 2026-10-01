// The 50 MB attachment cap lives in three places that must agree: the page,
// the web share-target worker and the Android share hand-off.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const MB = 1024 * 1024;

test("main.js, sw.js and MainActivity.kt share one attachment cap", () => {
  const page = Number(read("app/js/main.js").match(/const MAX_ATTACH_MB = (\d+);/)[1]) * MB;
  const [, a, b, c] = read("app/sw.js").match(/const MAX_ATTACH_BYTES = (\d+) \* (\d+) \* (\d+);/);
  const worker = Number(a) * Number(b) * Number(c);
  const [, x, y, z] = read("android/app/src/main/kotlin/io/github/munzzyy/magpie/MainActivity.kt").match(
    /const val MAX_ATTACH_BYTES = (\d+)L \* (\d+) \* (\d+)/,
  );
  const android = Number(x) * Number(y) * Number(z);
  assert.equal(page, 50 * MB);
  assert.equal(worker, page);
  assert.equal(android, page);
});

test("the worker parks no file over the cap with its body", () => {
  const sw = read("app/sw.js");
  assert.doesNotMatch(sw, /200 \* 1024 \* 1024/);
  assert.match(sw, /file\.size > MAX_ATTACH_BYTES \? new Response\(null, \{ status: 413/);
});
