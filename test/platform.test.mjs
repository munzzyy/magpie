// The iOS export bridge: routing, and the two negative controls that matter
// most. platform.js reads globalThis.location/webkit/MagpieNative fresh on
// every call, so each test just sets and clears those directly instead of
// re-importing the module.

import test from "node:test";
import assert from "node:assert/strict";
import { saveOut, shareOut, ExportUnavailableError, HandOffError, OUT_CHUNK_BYTES } from "../app/js/platform.js";

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

// Android: a fake MagpieBridge that keeps what appendOut gets and answers
// finishOut the way MainActivity.reportOut does, a moment later.
function fakeAndroid({ status = "ok", appendOk = () => true, id = "a1b2" } = {}) {
  const log = { begun: [], chunks: [], aborted: [], finished: [] };
  globalThis.MagpieNative = {
    beginOut: (name, mime, mode) => (log.begun.push({ name, mime, mode }), id),
    appendOut: (outId, b64) => {
      assert.equal(outId, id);
      log.chunks.push(b64);
      return appendOk(log.chunks.length);
    },
    abortOut: (outId) => log.aborted.push(outId),
    finishOut: (outId) => {
      log.finished.push(outId);
      setTimeout(() => globalThis.__magpieOutDone(outId, status), 5);
    },
  };
  return log;
}

const bigBlob = () => {
  const bytes = new Uint8Array(OUT_CHUNK_BYTES * 3 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  return { blob: new Blob([bytes], { type: "application/zip" }), bytes };
};

test("Android: saveOut sends the export in slices that reassemble exactly", async () => {
  const log = fakeAndroid();
  const { blob, bytes } = bigBlob();
  assert.equal(await saveOut(blob, "magpie-export-abcd.zip"), "native");
  assert.deepEqual(log.begun, [{ name: "magpie-export-abcd.zip", mime: "application/zip", mode: "save" }]);
  assert.equal(log.chunks.length, 4);
  for (const b64 of log.chunks) {
    assert.ok(b64.length <= 1024 * 1024, `chunk of ${b64.length} chars`);
    assert.equal(b64.length % 4, 0);
  }
  assert.equal(log.chunks[0].length, 1024 * 1024);
  assert.deepEqual(Buffer.concat(log.chunks.map((c) => Buffer.from(c, "base64"))), Buffer.from(bytes));
  assert.deepEqual(log.finished, ["a1b2"]);
});

test("Android: bytes are sliced in place, with the type passed in", async () => {
  const log = fakeAndroid();
  const { bytes } = bigBlob();
  assert.equal(await saveOut(bytes, "magpie-backup-abcd.magpiebackup", "application/json"), "native");
  assert.equal(log.begun[0].mime, "application/json");
  assert.ok(log.chunks.every((c) => c.length <= 1024 * 1024));
  assert.deepEqual(Buffer.concat(log.chunks.map((c) => Buffer.from(c, "base64"))), Buffer.from(bytes));
});

// A sealed backup arrives as a list of parts, one per sealed chunk, and none may be joined into one buffer on the way.
const backupParts = () => {
  const { bytes } = bigBlob();
  return [bytes.subarray(0, 300), bytes.subarray(300, 300 + OUT_CHUNK_BYTES + 5), bytes.subarray(300 + OUT_CHUNK_BYTES + 5)];
};

test("Android: a backup's parts go out in order, each sliced on its own", async () => {
  const log = fakeAndroid();
  const parts = backupParts();
  assert.equal(await saveOut(parts, "magpie-backup-abcd.magpiebackup", "application/json"), "native");
  assert.deepEqual(log.chunks.map((c) => Buffer.from(c, "base64").length), [300, OUT_CHUNK_BYTES, 5, OUT_CHUNK_BYTES, OUT_CHUNK_BYTES, 12345 - 305]);
  assert.deepEqual(Buffer.concat(log.chunks.map((c) => Buffer.from(c, "base64"))), Buffer.concat(parts));
  assert.deepEqual(log.finished, ["a1b2"]);
});

test("iOS bridge: a backup's parts are posted whole", async () => {
  const posted = fakeIOSBridge();
  const parts = backupParts();
  assert.equal(await saveOut(parts, "magpie-backup-abcd.magpiebackup", "application/json"), "ios-share");
  assert.deepEqual(Buffer.from(posted[0].b64, "base64"), Buffer.concat(parts));
});

test("Android: shareOut asks for the share sheet and reports success once it opened", async () => {
  const log = fakeAndroid();
  assert.equal(await shareOut(bigBlob().blob, "x.zip"), true);
  assert.equal(log.begun[0].mode, "share");
});

test("negative control: a save the wrapper reports failed rejects, never resolves", async () => {
  fakeAndroid({ status: "failed" });
  await assert.rejects(() => saveOut(bigBlob().blob, "x.zip"), HandOffError);
  fakeAndroid({ status: "failed" });
  await assert.rejects(() => shareOut(bigBlob().blob, "x.zip"), HandOffError);
});

test("Android 9: backing out of the save picker is cancelled, not saved", async () => {
  fakeAndroid({ status: "cancelled" });
  assert.equal(await saveOut(bigBlob().blob, "x.zip"), "cancelled");
});

test("negative control: a chunk the wrapper could not write stops the hand-off", async () => {
  const log = fakeAndroid({ appendOk: (n) => n < 2 });
  await assert.rejects(() => saveOut(bigBlob().blob, "x.zip"), HandOffError);
  assert.equal(log.chunks.length, 2);
  assert.deepEqual(log.aborted, ["a1b2"]);
  assert.deepEqual(log.finished, []);
});

test("negative control: a wrapper that refuses to begin gets nothing", async () => {
  const log = fakeAndroid({ id: "" });
  await assert.rejects(() => saveOut(bigBlob().blob, "x.zip"), HandOffError);
  assert.deepEqual(log.chunks, []);
});
