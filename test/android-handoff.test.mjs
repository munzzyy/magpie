// The Android export hand-off, pinned by reading the source: no desktop run
// has a Java heap to run out of. The emulator run that found the OOM is in
// the commit that added this.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OUT_CHUNK_BYTES } from "../app/js/platform.js";

const KT = "android/app/src/main/kotlin/io/github/munzzyy/magpie/";
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const bridge = read(KT + "MagpieBridge.kt");
const activity = read(KT + "MainActivity.kt");

test("the page's slice is exactly the most base64 the bridge takes in one call", () => {
  const [, a, b] = bridge.match(/const val MAX_CHUNK_CHARS = (\d+) \* (\d+)/);
  assert.equal(Number(a) * Number(b), (OUT_CHUNK_BYTES / 3) * 4);
  assert.match(bridge, /b64\.length > MAX_CHUNK_CHARS \|\| b64\.length % 4 != 0/);
});

test("no whole-export byte array on the Java side", () => {
  assert.doesNotMatch(bridge, /fun (shareFile|saveFile)\(/);
  assert.doesNotMatch(bridge + activity, /readBytes\(\)|writeBytes\(/);
  assert.doesNotMatch(activity, /pendingSave: ByteArray/);
  assert.equal(bridge.match(/Base64\.decode\(/g).length, 1);
});

test("every way out reports back to the page", () => {
  for (const status of ['"ok"', '"failed"', '"cancelled"']) {
    assert.ok((bridge + activity).includes(status), status);
  }
  assert.match(activity, /__magpieOutDone\(\\"\$id\\", \\"\$status\\"\)/);
});

test("a dead renderer gets a fresh WebView on the start page instead of taking the app down", () => {
  assert.match(activity, /override fun onRenderProcessGone\(view: WebView, detail: RenderProcessGoneDetail\): Boolean \{\s*replaceWebView\(view\)\s*return true/);
  const replace = activity.slice(activity.indexOf("private fun replaceWebView"));
  for (const step of ["root.removeView(dead)", "dead.destroy()", "setUpWebView(fresh)", "fresh.loadUrl(START_URL)"]) {
    assert.ok(replace.includes(step), step);
  }
});
