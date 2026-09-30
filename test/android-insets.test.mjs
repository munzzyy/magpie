// Android 15 and later lay a targetSdk 35+ app out edge to edge, under the
// status bar, the camera cutout and the navigation bar. No desktop run can
// show that, so this pins the fix by reading the source (munzzyy/sepia#6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../android/app/src/main/kotlin/io/github/munzzyy/magpie/MainActivity.kt", import.meta.url),
  "utf8",
);

test("the WebView sits in a container padded clear of the bars, the cutout and the keyboard", () => {
  assert.doesNotMatch(src, /setContentView\(webView\)/, "a bare WebView fills the screen under the bars");
  assert.match(src, /ViewCompat\.setOnApplyWindowInsetsListener\(root\)/);
  assert.match(src, /systemBars\(\) or\s+WindowInsetsCompat\.Type\.displayCutout\(\) or\s+WindowInsetsCompat\.Type\.ime\(\)/);
  assert.match(src, /view\.setPadding\(safe\.left, safe\.top, safe\.right, safe\.bottom\)/);
});
