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

    // ------------------------------------------------------ first entry
    await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen");
    await c.evalJs(`(() => {
      document.getElementById("add-title").value = ${JSON.stringify(CANARY_TITLE)};
      document.getElementById("add-note").value = ${JSON.stringify(CANARY_NOTE)};
      document.getElementById("add-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 1"), "entry 1 chained");
    check("chain badge shows intact after entry 1", /chain intact/.test(await c.evalJs("document.getElementById('chain-badge').textContent")));

    // ------------------------------------- second entry with attachment
    const canaryFile = path.join(work, "evidence.bin");
    writeFileSync(canaryFile, `${CANARY_BYTES} repeated ${CANARY_BYTES}`);
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

    // ------------------------------------------------------ entry view
    await c.evalJs("document.querySelectorAll('#timeline li button')[1].click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'entry'"), "entry view");
    check("entry view shows the note", (await c.evalJs("document.getElementById('entry-note').textContent")).includes("CANARY-NOTE-TEXT"));
    check("entry hash is 64 hex chars", /^[0-9a-f]{64}$/.test(await c.evalJs("document.getElementById('entry-hash').textContent")));
    await c.evalJs("document.getElementById('btn-entry-back').click(); 'ok'");

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
    check("independent: verify.py accepts the browser-built export", /^OK: 2 entries verify/.test(verdict), verdict.split("\n")[0]);
    check("independent: exported head matches the screen", verdict.includes(head));

    // ------------------------------------------------------------ lock
    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await c.evalJs("document.getElementById('btn-lock').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'lock'"), "locked");
    const lockedDom = await c.evalJs("document.getElementById('timeline').innerHTML + document.getElementById('entry-note').textContent + (document.getElementById('entry-img').getAttribute('src') || '')");
    check("locked: no journal content left in the DOM", !lockedDom.includes("CANARY") && !lockedDom.includes("Broken window"), lockedDom.slice(0, 80));

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
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "unlocked again");
    check("entries survive lock/unlock", (await c.evalJs("document.querySelectorAll('#timeline li').length")) === 2);

    // --------------------------------------------------- reload persists
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'lock'"), "lock after reload");
    await c.evalJs(`(() => {
      document.getElementById("lock-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("lock-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 2"), "entries after reload");
    check("reload: vault persists and reopens", true);

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

    const errs = await c.evalJs("(__magpieErrors || []).slice(0, 8)");
    check("no page errors across the whole run", errs.length === 0, JSON.stringify(errs));
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
