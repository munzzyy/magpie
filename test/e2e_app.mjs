// Drives the real app in headless Chromium: create a vault, chain entries
// (one with a canary attachment), export, then verify the export OUTSIDE
// the app with python's zipfile and the export's own verify.py. Locking is
// probed hard: raw IndexedDB bytes are searched for every plaintext canary,
// because "encrypted at rest" is a claim, not a vibe.
//
// Run from the repo root:  node test/e2e_app.mjs

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8951;
const CDP_PORT = 9351;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const SHOTS = path.join(ROOT, "test", "screenshots");

const PASS = "correct horse magpie staple";
const CANARY_TITLE = "Broken window in the kitchen";
const CANARY_NOTE = "The landlord was told on Tuesday CANARY-NOTE-TEXT";
const CANARY_BYTES = "PLAINTEXT-CANARY-BYTES-0451";

const fails = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    fails.push(name);
  }
}

async function waitFor(fn, desc, timeout = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = String(err);
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${desc}; last: ${JSON.stringify(last)}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.result.exceptionDetails)}`);
    return r.result?.result?.value;
  };
  return {
    send,
    evalJs,
    open: new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    }),
    close: () => ws.close(),
  };
}

// Serializes every IndexedDB record (keys, strings, buffers) into one big
// string so canaries can be grepped. Runs inside the page.
const DUMP_IDB = `(async () => {
  const req = indexedDB.open("magpie");
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  let out = "";
  for (const store of [...db.objectStoreNames]) {
    const rows = await new Promise((res, rej) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    for (const row of rows) {
      out += JSON.stringify(row, (k, v) => {
        if (v instanceof Uint8Array) return [...v].map((b) => String.fromCharCode(b)).join("");
        if (v instanceof ArrayBuffer) return [...new Uint8Array(v)].map((b) => String.fromCharCode(b)).join("");
        return v;
      });
    }
  }
  db.close();
  return out;
})()`;

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "magpie-e2e-"));
  const work = mkdtempSync(path.join(tmpdir(), "magpie-e2e-work-"));
  const server = spawn("node", [path.join(ROOT, "test", "serve_local.mjs"), String(HTTP_PORT)], { stdio: "ignore" });
  const chromium = spawn(
    "chromium",
    ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + profile, "--no-sandbox", "--disable-gpu", "about:blank"],
    { stdio: "ignore" },
  );
  try {
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        fetch(`${BASE}/index.html`).then((r) => r.ok).catch(() => false),
        fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false),
      ]);
      return a && b;
    }, "server and devtools up");

    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
    const tab = await res.json();
    const c = connect(tab.webSocketDebuggerUrl);
    await c.open;
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("DOM.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "setup screen");

    check("boot: landing present on web", (await c.evalJs("document.querySelectorAll('.web-only').length")) > 0);
    check("web: in-app author credit stays hidden (the web footer already has one)", await c.evalJs("document.getElementById('about-site').hidden"));
    check(
      "web: Settings carries the author credit too, for anyone past setup",
      (await c.evalJs("document.querySelector('#screen-timeline details.danger #about-app a').href")) === "https://github.com/munzzyy",
    );

    // ------------------------------------------------------------ setup
    await c.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline after setup");
    check("setup: lands unlocked on an empty timeline", await c.evalJs("!document.getElementById('timeline-empty').hidden"));
    await (async () => {
      const s = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, "01-timeline-empty.png"), Buffer.from(s.result.data, "base64"));
    })();

    // ---------------------------------------------------------- autolock
    // A fresh install stores nothing, and a short trip to the camera must come back unlocked.
    const hideFor = async (ms) => {
      await c.evalJs(`Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); 'ok'`);
      await sleep(ms);
      await c.evalJs(`Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); 'ok'`);
    };
    check("autolock: a fresh install stores no setting", (await c.evalJs("localStorage.getItem('magpie-autolock')")) === null);
    const autolockDefault = await c.evalJs("[...document.getElementById('autolock').options].find((o) => o.defaultSelected).value");
    check("autolock: the select shows its default", (await c.evalJs("document.getElementById('autolock').value")) === autolockDefault, autolockDefault);
    await hideFor(2000);
    check(
      `autolock: 2 s away with nothing stored keeps it open (default ${autolockDefault} s)`,
      (await c.evalJs("__magpieApi.state.locked")) === (Number(autolockDefault) < 2),
    );
    await c.evalJs(`(() => { const s = document.getElementById("autolock"); s.value = "0"; s.dispatchEvent(new Event("change")); })()`);
    await hideFor(300);
    check("autolock: 'Immediately' locks on return", (await c.evalJs("__magpieApi.state.locked")) === true);
    check("autolock: and says why", (await c.evalJs("document.getElementById('toast').textContent")) === "Locked while you were away.");
    await c.evalJs(`delete document.hidden; localStorage.removeItem("magpie-autolock"); 'ok'`);
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline after the autolock check");

    // ------------------------------------------------------ first entry
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen");
    await c.evalJs(`(() => {
      document.getElementById("add-title").value = ${JSON.stringify(CANARY_TITLE)};
      document.getElementById("add-note").value = ${JSON.stringify(CANARY_NOTE)};
      document.getElementById("add-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 1"), "entry 1 chained");
    const badgeSays = (want) =>
      waitFor(() => c.evalJs(`document.getElementById('chain-badge').textContent === ${JSON.stringify(want)}`), want).then(
        () => true,
        () => false,
      );
    check("chain badge says 1 entry, singular", await badgeSays("1 entry, chain intact"));
    check("chain spine: entry has a dot and a hash chip", await c.evalJs(
      "!!document.querySelector('#timeline li .tl-dot') && !!document.querySelector('#timeline li .tl-hash')",
    ));
    check("sealing moment: the just-chained entry carries the seal class", await c.evalJs(
      "document.querySelector('#timeline li').classList.contains('tl-seal')",
    ));

    // ------------------------------------- second entry with attachment
    // Written under the repo tree: CI runners' chromium cannot always read
    // files living in another process's temp directory.
    mkdirSync(path.join(ROOT, "test", "fixtures"), { recursive: true });
    const canaryFile = path.join(ROOT, "test", "fixtures", "evidence.bin");
    // Padded past 512KB on purpose: a small attachment let a real bug through
    // where exportBackup base64-encoded the sealed file by spreading the whole
    // byte array as call arguments, which throws once an attachment is this big.
    writeFileSync(canaryFile, `${CANARY_BYTES} repeated ${CANARY_BYTES} ` + "E".repeat(768 * 1024));
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen 2");
    const { root } = (await c.send("DOM.getDocument")).result;
    const input = (await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#attach-input" })).result;
    await c.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [canaryFile] });
    await waitFor(() => c.evalJs("!document.getElementById('attach-name').hidden"), "attachment registered");
    await c.evalJs(`(() => {
      document.getElementById("add-title").value = "The photo of it";
      document.getElementById("add-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("document.querySelectorAll('#timeline li').length === 2"), "entry 2 chained");
    check("chain badge says 2 entries, plural", await badgeSays("2 entries, chain intact"));

    // ------------------------------------------------------ entry view
    await c.evalJs("document.querySelectorAll('#timeline li button')[1].click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'entry'"), "entry view");
    check("entry view shows the note", (await c.evalJs("document.getElementById('entry-note').textContent")).includes("CANARY-NOTE-TEXT"));
    check("entry hash is 64 hex chars", /^[0-9a-f]{64}$/.test(await c.evalJs("document.getElementById('entry-hash').textContent")));
    await c.evalJs("document.getElementById('btn-entry-back').click(); 'ok'");

    // ------------------------------------------ multi-file attach: 1 -> 2
    const fixtureB = path.join(ROOT, "test", "fixtures", "evidence2.bin");
    writeFileSync(fixtureB, "second file bytes CANARY-2");
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen 3");
    let { root: rootMulti } = (await c.send("DOM.getDocument")).result;
    let inputMulti = (await c.send("DOM.querySelector", { nodeId: rootMulti.nodeId, selector: "#attach-input" })).result;
    await c.send("DOM.setFileInputFiles", { nodeId: inputMulti.nodeId, files: [canaryFile, fixtureB] });
    await waitFor(() => c.evalJs("!document.getElementById('attach-name').hidden"), "first of two attached");
    check("multi-attach: first file staged", (await c.evalJs("document.getElementById('attach-name').textContent")).includes("evidence.bin"));
    await c.evalJs(`(() => { document.getElementById("add-title").value = "First of two"; document.getElementById("add-form").requestSubmit(); })()`);
    await waitFor(
      () => c.evalJs("__magpieApi.state.screen === 'add' && document.getElementById('attach-name').textContent.includes('evidence2.bin')"),
      "second file auto-staged",
    );
    check("multi-attach: second file queued into its own entry", true);
    await c.evalJs(`(() => { document.getElementById("add-title").value = "Second of two"; document.getElementById("add-form").requestSubmit(); })()`);
    await waitFor(() => c.evalJs("document.querySelectorAll('#timeline li').length === 4"), "both of the two chained");
    check("multi-attach: one pick became two chained entries", true);
    const s1b = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "03-timeline-chain.png"), Buffer.from(s1b.result.data, "base64"));

    // -------------------------------------- oversized attachment is refused
    // Refused by File.size before any read, so a huge pick can't OOM the app.
    // Regression: a ~500MB video pick used to crash it (found in review).
    const bigFile = path.join(ROOT, "test", "fixtures", "toobig.bin");
    writeFileSync(bigFile, Buffer.alloc(51 * 1024 * 1024));
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen 4");
    const { root: rootBig } = (await c.send("DOM.getDocument")).result;
    const inputBig = (await c.send("DOM.querySelector", { nodeId: rootBig.nodeId, selector: "#attach-input" })).result;
    await c.send("DOM.setFileInputFiles", { nodeId: inputBig.nodeId, files: [bigFile] });
    await waitFor(() => c.evalJs("document.getElementById('toast').classList.contains('show')"), "oversized reject toast");
    check("oversized attachment: refused, nothing staged", (await c.evalJs("document.getElementById('attach-name').hidden")) === true);
    check("oversized attachment: toast names the 50 MB limit", (await c.evalJs("document.getElementById('toast').textContent")).includes("50 MB"));
    await c.evalJs("document.getElementById('btn-add-cancel').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline after refusal");
    check("oversized attachment: added no entry", (await c.evalJs("document.querySelectorAll('#timeline li').length")) === 4);

    // ---------------------------------------------------- in-memory search
    await c.evalJs(`(() => { document.getElementById("search-timeline").value = "Broken window"; document.getElementById("search-timeline").dispatchEvent(new Event("input")); })()`);
    check("search: matching entry stays visible", (await c.evalJs("document.querySelectorAll('#timeline li:not([hidden])').length")) === 1);
    check("search: never persisted to localStorage", await c.evalJs("!Object.keys(localStorage).some((k) => k.toLowerCase().includes('search'))"));
    const s1c = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "04-search.png"), Buffer.from(s1c.result.data, "base64"));
    await c.evalJs(`(() => { document.getElementById("search-timeline").value = "there is nothing here at all xyz"; document.getElementById("search-timeline").dispatchEvent(new Event("input")); })()`);
    check("search: no-match message appears for a query with no hits", !(await c.evalJs("document.getElementById('search-no-match').hidden")));
    await c.evalJs(`(() => { document.getElementById("search-timeline").value = ""; document.getElementById("search-timeline").dispatchEvent(new Event("input")); })()`);
    check("search: clearing the query shows everything again", (await c.evalJs("document.querySelectorAll('#timeline li:not([hidden])').length")) === 4);

    // ---------------------------------------------------------- export
    await c.evalJs("document.getElementById('btn-export').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'export'"), "export screen");
    const head = await c.evalJs("document.getElementById('export-head').textContent");
    check("export shows a head hash", /^[0-9a-f]{64}$/.test(head), head);
    const s2 = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "02-export.png"), Buffer.from(s2.result.data, "base64"));

    const zipB64 = await c.evalJs(
      `(async () => { const { buildExport } = await import("/js/export.js");
        const { zip } = await buildExport();
        let out = ""; for (let i = 0; i < zip.length; i += 0x8000) out += String.fromCharCode.apply(null, zip.subarray(i, i + 0x8000));
        return btoa(out); })()`,
      true,
    );
    const zipFile = path.join(work, "export.zip");
    writeFileSync(zipFile, Buffer.from(zipB64, "base64"));
    execFileSync("python3", ["-m", "zipfile", "-e", zipFile, path.join(work, "unzipped")]);
    const verdict = execFileSync("python3", [path.join(work, "unzipped", "verify.py")], { encoding: "utf8" });
    check("independent: verify.py accepts the browser-built export", /^OK: 4 entries verify/.test(verdict), verdict.split("\n")[0]);
    check("independent: exported head matches the screen", verdict.includes(head));

    // -------------------------------------- anchor: pin the record via Save
    await c.send("Page.setDownloadBehavior", { behavior: "deny" });
    await c.evalJs("document.getElementById('btn-export-save').click(); 'ok'");
    await waitFor(() => c.evalJs("document.getElementById('toast').classList.contains('show')"), "export save toast");
    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "back on timeline after export");
    check("anchor: timeline shows pinned-through-entry-N after an export leaves the app", await c.evalJs(
      "document.getElementById('anchor-line').textContent.includes('Pinned through entry 4')",
    ));

    // ------------------------------------------------------------ lock
    // Leave a live, non-empty query in the search box on purpose: this is
    // the case the old assertion here never actually exercised (the search
    // block below always cleared the query itself before locking).
    await c.evalJs(`(() => { document.getElementById("search-timeline").value = "Broken window"; document.getElementById("search-timeline").dispatchEvent(new Event("input")); })()`);
    await c.evalJs("document.getElementById('btn-lock').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'lock'"), "locked");
    const lockedDom = await c.evalJs(`["timeline", "entry-note", "entry-title", "entry-meta", "entry-file", "entry-hash", "attach-name", "export-head", "sr-live", "search-timeline"]
      .map((id) => (document.getElementById(id).value ?? document.getElementById(id).textContent)).join("|") + (document.getElementById("entry-img").getAttribute("src") || "")`);
    check("locked: no journal content left anywhere in the DOM", !lockedDom.includes("CANARY") && !lockedDom.includes("Broken window") && !lockedDom.includes("evidence.bin"), lockedDom.slice(0, 100));
    check("locked: the search query itself is cleared, not just re-filtered", (await c.evalJs("document.getElementById('search-timeline').value")) === "");

    const idbDump = await c.evalJs(DUMP_IDB, true);
    check("at rest: title never stored in plaintext", !idbDump.includes(CANARY_TITLE));
    check("at rest: note never stored in plaintext", !idbDump.includes("CANARY-NOTE-TEXT"));
    check("at rest: attachment bytes never stored in plaintext", !idbDump.includes(CANARY_BYTES));
    check("at rest: something IS stored (probe is live)", idbDump.length > 500, String(idbDump.length));

    // ---------------------------------------------------------- unlock
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = "wrong passphrase";
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await sleep(600);
    check("wrong passphrase is rejected", await c.evalJs("__magpieApi.state.screen === 'lock' && !document.getElementById('lock-error').hidden"));
    check("wrong passphrase shakes the form without losing the screen-reader announcement", await c.evalJs(
      "document.getElementById('lock-form').classList.contains('shake') && document.getElementById('sr-live').textContent.length > 0",
    ));
    const s3 = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "05-lock-shake.png"), Buffer.from(s3.result.data, "base64"));
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "unlocked again");
    check("entries survive lock/unlock", (await c.evalJs("document.querySelectorAll('#timeline li').length")) === 4);

    // --------------------------------------------------- reload persists
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'lock'"), "lock after reload");
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 4"), "entries after reload");
    check("reload: vault persists and reopens", true);

    // ------------------------------------------- web share-target pickup
    // The worker parks shared files in a cache and an oversized one as a bodiless 413.
    await c.evalJs(`(async () => {
      const cache = await caches.open("magpie-share");
      await cache.put("/share-incoming-0", new Response(null, { status: 413, headers: { "content-type": "video/mp4", "x-magpie-name": "holiday%20video.mp4" } }));
      await cache.put("/share-incoming-1", new Response(new Blob(["shared through the share sheet"]), { headers: { "content-type": "text/plain", "x-magpie-name": "notes%20from%20the%20call.txt" } }));
      return "ok";
    })()`, true);
    await c.send("Page.navigate", { url: BASE + "/?share-target=1" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'lock'"), "lock after a share-target launch");
    check("share target: both parked items are queued, unread", JSON.stringify(await c.evalJs("__magpieApi.state.queued")) === '["too-big","blob"]');
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add' && !document.getElementById('attach-name').hidden"), "shared file staged");
    const shareLine = await c.evalJs("document.getElementById('attach-name').textContent");
    check("share target: the small file is staged from its blob, under its own name", shareLine === "Attached: notes from the call.txt (1 KB)", shareLine);
    const shareToast = await c.evalJs("document.getElementById('toast').textContent");
    check("share target: the oversized one is refused by name, not read", shareToast.includes("holiday video.mp4 is too big to attach"), shareToast);
    check("share target: the parking cache is emptied", (await c.evalJs("caches.open('magpie-share').then((x) => x.keys()).then((k) => k.length)", true)) === 0);
    await c.evalJs("document.getElementById('btn-add-cancel').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 4"), "timeline after the share target");

    // -------------------------------------------------- sealed backup out
    const backupB64 = await c.evalJs(
      `(async () => { const bytes = await __magpieApi.vault.exportBackup();
        let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(out); })()`,
      true,
    );
    const backupBytes = Buffer.from(backupB64, "base64");
    check("backup: bytes produced", backupBytes.length > 100);
    check("backup: title never appears in the sealed backup", !backupBytes.toString("latin1").includes(CANARY_TITLE));
    check("backup: note never appears in the sealed backup", !backupBytes.toString("latin1").includes("CANARY-NOTE-TEXT"));
    check("backup: attachment bytes never appear in the sealed backup", !backupBytes.toString("latin1").includes(CANARY_BYTES));
    const goodBackup = JSON.parse(backupBytes.toString("utf8"));
    check("backup: it really is one outer envelope, nothing itemized outside it", (
      Object.keys(goodBackup).sort().join(",") === "box,format,iters,salt,v" &&
      typeof goodBackup.box.iv === "string" && typeof goodBackup.box.ct === "string"
    ), JSON.stringify(Object.keys(goodBackup)));
    const backupPlain = JSON.stringify(goodBackup);
    check("backup: no plaintext head hash, entry count, or generated_at sits outside the envelope", (
      !backupPlain.includes(head) && !backupPlain.includes('"generated_at"') && !backupPlain.includes('"entries"')
    ));
    const goodBackupFile = path.join(ROOT, "test", "fixtures", "backup-good.magpiebackup");
    writeFileSync(goodBackupFile, backupBytes);

    // Outer-envelope tamper: flip a character inside the sealed ciphertext
    // itself. This is what "attack the envelope, not a record inside it"
    // means now that there are no records visible from outside the box.
    const outerTampered = { ...goodBackup, box: { ...goodBackup.box, ct: goodBackup.box.ct.slice(0, -4) + (goodBackup.box.ct.slice(-4) === "AAAA" ? "BBBB" : "AAAA") } };
    const outerTamperedFile = path.join(ROOT, "test", "fixtures", "backup-outer-tampered.magpiebackup");
    writeFileSync(outerTamperedFile, JSON.stringify(outerTampered));

    // A pre-fix (v1, per-record) shaped file: never shipped, must read as
    // plain "not a backup", not silently half-parse.
    const oldFormatFile = path.join(ROOT, "test", "fixtures", "backup-old-format.magpiebackup");
    writeFileSync(oldFormatFile, JSON.stringify({ format: "magpie-backup", v: 1, kdf: { salt: "x", iters: 1, check: { iv: "x", ct: "x" } }, entries: [] }));

    // Two envelopes that open cleanly (the real passphrase, honestly
    // resealed) but whose CONTENT is wrong: one with a tampered entry hash,
    // one with its state box stripped to fake an empty vault. Both must
    // still be refused, proving the inner checks are not just a formality
    // that a valid outer AEAD tag makes moot.
    const mutated = await c.evalJs(
      `(async () => {
        const { deriveKey, seal, open } = await import("/js/cryptobox.js");
        const toB64 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
        const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const boxIn = (o) => ({ iv: fromB64(o.iv), ct: fromB64(o.ct) });
        const boxOut = (b) => ({ iv: toB64(b.iv), ct: toB64(b.ct) });
        const good = ${JSON.stringify(goodBackup)};
        const salt = fromB64(good.salt);
        const k = await deriveKey(${JSON.stringify(PASS)}, salt, good.iters);
        const inner = JSON.parse(new TextDecoder().decode(await open(k, boxIn(good.box), "backup")));
        const reseal = async (obj) => {
          const outer = await seal(k, new TextEncoder().encode(JSON.stringify(obj)), "backup");
          return { format: "magpie-backup", v: 2, salt: good.salt, iters: good.iters, box: boxOut(outer) };
        };
        const chainInvalid = structuredClone(inner);
        chainInvalid.entries[0].hash = "0".repeat(64);
        const hollowed = structuredClone(inner);
        hollowed.state = null;
        return {
          chainInvalid: JSON.stringify(await reseal(chainInvalid)),
          hollowed: JSON.stringify(await reseal(hollowed)),
        };
      })()`,
      true,
    );
    const chainInvalidFile = path.join(ROOT, "test", "fixtures", "backup-chain-invalid.magpiebackup");
    writeFileSync(chainInvalidFile, mutated.chainInvalid);
    const hollowedFile = path.join(ROOT, "test", "fixtures", "backup-hollowed.magpiebackup");
    writeFileSync(hollowedFile, mutated.hollowed);

    // ------------------------- a pick of several large files, read lazily
    // Only the staged file is read; the rest wait as File objects, never bytes.
    const MB = 1024 * 1024;
    const bigPick = ["big49-a.bin", "big49-b.bin", "big60.bin", "big49-c.bin"].map((n) => path.join(ROOT, "test", "fixtures", n));
    for (const f of bigPick) writeFileSync(f, Buffer.alloc((f.includes("big60") ? 60 : 49) * MB, 7));
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen for the big pick");
    const { root: rootPick } = (await c.send("DOM.getDocument")).result;
    const inputPick = (await c.send("DOM.querySelector", { nodeId: rootPick.nodeId, selector: "#attach-input" })).result;
    await c.send("DOM.setFileInputFiles", { nodeId: inputPick.nodeId, files: bigPick });
    await waitFor(() => c.evalJs("!document.getElementById('attach-name').hidden"), "first big file staged");
    check("big pick: the first file is staged", (await c.evalJs("document.getElementById('attach-name').textContent")).includes("big49-a.bin"));
    const queued = await c.evalJs("__magpieApi.state.queued");
    check("big pick: the other two wait as File objects, unread", JSON.stringify(queued) === '["file","file"]', JSON.stringify(queued));
    const pickToast = await c.evalJs("document.getElementById('toast').textContent");
    check("big pick: the 60 MB file is refused by name", pickToast.includes("big60.bin is too big to attach; the limit is 50 MB."), pickToast);
    check("big pick: and the same toast says two more are waiting", pickToast.includes("2 more"), pickToast);
    await c.evalJs("document.getElementById('btn-add-cancel').click(); 'ok'");
    for (const f of bigPick) rmSync(f, { force: true });

    // ------------------------------------------------------------- wipe
    await c.evalJs(`(() => {
      document.querySelector(".danger").open = true;
      const el = document.getElementById("wipe-confirm");
      el.value = "DELETE";
      el.dispatchEvent(new Event("input"));
    })()`);
    await waitFor(() => c.evalJs("!document.getElementById('btn-wipe').disabled"), "wipe armed");
    await c.evalJs("document.getElementById('btn-wipe').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'setup'"), "back to setup after wipe");
    const wipedDump = await c.evalJs(DUMP_IDB, true);
    check("wipe: storage is actually empty", wipedDump.length < 50, String(wipedDump.length));

    // --------------------------------------------- restore: negative sweep
    await c.evalJs("document.querySelector('.restore-block').open = true; document.querySelector('.restore-block').scrollIntoView({ block: 'start' }); 'ok'");
    const s4 = await c.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "06-restore-setup.png"), Buffer.from(s4.result.data, "base64"));

    async function attemptRestore(file, pass) {
      const { root: r } = (await c.send("DOM.getDocument")).result;
      const input = (await c.send("DOM.querySelector", { nodeId: r.nodeId, selector: "#restore-file" })).result;
      await c.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [file] });
      await c.evalJs(`(() => {
        document.getElementById("restore-pass").value = ${JSON.stringify(pass)};
        document.getElementById("restore-form").requestSubmit();
      })()`);
      await waitFor(() => c.evalJs("!document.getElementById('restore-error').hidden"), "restore refused");
      return c.evalJs("document.getElementById('restore-error').textContent");
    }

    // Five refusal shapes, all of which must write nothing at all: an
    // old (never-shipped) format, a tampered outer envelope, a plain wrong
    // passphrase, and two envelopes that open cleanly but whose CONTENT is
    // wrong (a bad entry hash, a stripped state box faking an empty vault).
    const notABackupMsg = await attemptRestore(oldFormatFile, PASS);
    check("restore: pre-fix (v1) format reads as not-a-backup, not a half-parse", notABackupMsg.length > 0, notABackupMsg);
    check("restore: refusing an old-format file writes nothing", (await c.evalJs("__magpieApi.vault.isSetUp()", true)) === false);

    await attemptRestore(outerTamperedFile, PASS);
    check("restore: a tampered OUTER envelope is refused even with the right passphrase", (await c.evalJs("__magpieApi.vault.isSetUp()", true)) === false);

    await attemptRestore(goodBackupFile, "wrong passphrase entirely");
    check("restore: wrong passphrase is refused, loud", (await c.evalJs("document.getElementById('restore-error').textContent")).length > 0);
    check("restore: wrong passphrase writes nothing", (await c.evalJs("__magpieApi.vault.isSetUp()", true)) === false);

    await attemptRestore(chainInvalidFile, PASS);
    check("restore: a validly-resealed but chain-tampered backup is still refused", (await c.evalJs("__magpieApi.vault.isSetUp()", true)) === false);

    await attemptRestore(hollowedFile, PASS);
    check("restore: a validly-resealed backup with its state box stripped cannot pass as an empty vault", (await c.evalJs("__magpieApi.vault.isSetUp()", true)) === false);

    // ------------------- restore: a journal appears while it is running
    // A journal created during the restore's KDF (planted here) must survive, and the restore write nothing.
    const raced = await c.evalJs(
      `(async () => {
        const bytes = new TextEncoder().encode(${JSON.stringify(backupBytes.toString("utf8"))});
        const outcome = __magpieApi.vault.restoreBackup(bytes, ${JSON.stringify(PASS)}).then(() => "restored", (e) => e.code || String(e));
        const db = await new Promise((res, rej) => { const r = indexedDB.open("magpie"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        await new Promise((res, rej) => { const t = db.transaction("meta", "readwrite"); t.objectStore("meta").put({ planted: true }, "kdf"); t.oncomplete = res; t.onabort = () => rej(t.error); });
        const result = await outcome;
        const after = await new Promise((res) => { const r = db.transaction(["meta", "entries"]).objectStore("meta").get("kdf"); r.onsuccess = () => res(r.result); });
        const entries = await new Promise((res) => { const r = db.transaction("entries").objectStore("entries").count(); r.onsuccess = () => res(r.result); });
        db.close();
        return { result, planted: after?.planted === true, entries };
      })()`,
      true,
    );
    check("restore: a journal created mid-restore is not replaced", raced.result === "already-set-up" && raced.planted && raced.entries === 0, JSON.stringify(raced));
    await c.evalJs("__magpieApi.vault.wipe()", true);

    // --------------------------------- restore: correct backup succeeds
    const { root: rootGood } = (await c.send("DOM.getDocument")).result;
    const goodInput = (await c.send("DOM.querySelector", { nodeId: rootGood.nodeId, selector: "#restore-file" })).result;
    await c.send("DOM.setFileInputFiles", { nodeId: goodInput.nodeId, files: [goodBackupFile] });
    await c.evalJs(`(() => {
      document.getElementById("restore-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("restore-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "restored into timeline");
    check("restore: all entries come back", (await c.evalJs("document.querySelectorAll('#timeline li').length")) === 4);
    const restoreVerify = await c.evalJs("__magpieApi.vault.verify()", true);
    check("restore: chain verifies after restore", restoreVerify.ok === true);

    // The five negative-control restore attempts above each deliberately
    // push one logged error: expected, not a bug. Anything beyond those
    // five is a real, unaccounted-for failure.
    const errs = await c.evalJs("(__magpieErrors || []).slice(0, 12)");
    const unexpected = errs.filter((e) => !/^restore: Error: (chain-invalid|wrong-passphrase|corrupt|not-a-backup)$/.test(e));
    check("no page errors across the whole run", unexpected.length === 0, JSON.stringify(errs));
    check("restore negative controls logged exactly the expected refusals", errs.length === 5, JSON.stringify(errs));

    // ------------------------------------- two tabs on the setup screen
    // Two tabs booted before any journal existed: the second setup must not replace the first.
    const PASS_B = "a different passphrase entirely";
    await c.evalJs("__magpieApi.vault.wipe()", true);
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "tab A on setup");
    const tabB = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const b = connect(tabB.webSocketDebuggerUrl);
    await b.open;
    await b.send("Page.enable");
    await b.send("Runtime.enable");
    await b.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => b.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "tab B on setup");
    await c.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "tab A set up");
    await c.evalJs(`__magpieApi.vault.addEntry({ type: "note", title: "Written in tab A", note: "" })`, true);
    await b.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS_B)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS_B)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    const bScreen = await waitFor(
      () => b.evalJs("['lock', 'timeline'].includes(__magpieApi.state.screen) && __magpieApi.state.screen"),
      "tab B leaves setup",
    );
    check("two tabs: the second setup is refused and lands on the lock screen", bScreen === "lock", bScreen);
    check(
      "two tabs: and says a journal already exists",
      (await b.evalJs("document.getElementById('toast').textContent")) === "A journal already exists on this device. Unlock it instead.",
    );
    check("two tabs: the refused setup leaves no passphrase in the form", (await b.evalJs("document.getElementById('setup-pass').value + document.getElementById('setup-pass2').value")) === "");
    b.close();
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'lock'"), "tab A reloaded");
    check("two tabs: tab A's own passphrase still opens its journal", (await c.evalJs(`__magpieApi.vault.unlock(${JSON.stringify(PASS)})`, true)) === true);
    const twoTabVerify = await c.evalJs("__magpieApi.vault.verify()", true);
    check("two tabs: tab A's entry is intact", twoTabVerify.ok === true && twoTabVerify.count === 1, JSON.stringify(twoTabVerify));
    await c.evalJs("__magpieApi.vault.lock()");
    check("two tabs: tab B's passphrase opens nothing", (await c.evalJs(`__magpieApi.vault.unlock(${JSON.stringify(PASS_B)})`, true)) === false);
    c.close();
  } finally {
    chromium.kill();
    server.kill();
    await sleep(400);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(work, { recursive: true, force: true });
    } catch {}
  }
  if (fails.length) {
    console.log("FAILS:", fails.join("; "));
    process.exit(1);
  }
  console.log("E2E APP PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
