// The iOS export bridge: routing, and the two negative controls that matter
// most. platform.js reads globalThis.location/webkit/MagpieNative fresh on
// every call, so each test just sets and clears those directly instead of
// re-importing the module.

import test from "node:test";
import assert from "node:assert/strict";
import { saveOut, shareOut, ExportUnavailableError } from "../app/js/platform.js";

function resetHost() {
  delete globalThis.location;
  delete globalThis.webkit;
  delete globalThis.MagpieNative;
}

function fakeIOSBridge() {
  const posted = [];
  globalThis.location = { protocol: "magpie:" };
  globalThis.webkit = { messageHandlers: { save: { postMessage: (msg) => posted.push(msg) } } };
  return posted;
}

const blob = () => new Blob(["evidence"], { type: "application/zip" });

test.afterEach(resetHost);

test("iOS bridge: saveOut posts the export and reports a share hand-off", async () => {
  const posted = fakeIOSBridge();
  const how = await saveOut(blob(), "magpie-export-test.zip");
  assert.equal(how, "ios-share");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].name, "magpie-export-test.zip");
  assert.equal(posted[0].mime, "application/zip");
  assert.ok(posted[0].b64.length > 0);
  assert.equal(Buffer.from(posted[0].b64, "base64").toString(), "evidence");
});

test("iOS bridge: shareOut posts the export and reports success", async () => {
  const posted = fakeIOSBridge();
  const ok = await shareOut(blob(), "magpie-export-test.zip");
  assert.equal(ok, true);
  assert.equal(posted.length, 1);
});

// Negative control: the scheme says this IS the wrapper, but the message
// handler never registered (a stale build, or the bridge broke). Export
// must fail loudly, never fall back to a silent no-op or a fake "Downloaded".
test("negative control: magpie scheme with no bridge fails loud, not silent", async () => {
  globalThis.location = { protocol: "magpie:" };
  await assert.rejects(() => saveOut(blob(), "x.zip"), ExportUnavailableError);
  assert.equal(await shareOut(blob(), "x.zip"), false);
});

// Negative control: a page that merely HAS window.webkit.messageHandlers.save
// (any embedding could fake that) must not get the bridge unless it is also
// running on the magpie: scheme. Falls through to the plain web path, which
// needs a browser DOM; asserting isIOSWrapped()-gated behavior here is what
// matters, so a bare document stub is enough to prove the bridge was not used.
test("negative control: bridge object without the scheme is not trusted", async () => {
  globalThis.location = { protocol: "https:" };
  globalThis.webkit = { messageHandlers: { save: { postMessage: () => assert.fail("bridge must not fire") } } };
  const clicked = [];
  globalThis.document = {
    createElement: () => ({ set href(_v) {}, set download(_v) {}, click: () => clicked.push(true) }),
  };
  // Left in place rather than restored: saveOut's own fallback schedules a
  // revokeObjectURL 4 seconds out, well after this test returns, and node
  // treats an exception from that stray timer as an unhandled failure.
  globalThis.URL.createObjectURL = () => "blob:fake";
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const how = await saveOut(blob(), "x.zip");
    assert.equal(how, "download");
    assert.equal(clicked.length, 1);
  } finally {
    delete globalThis.document;
  }
});
