// Wrapper-mode contract: web-only sections gone, shared-in tokens queue
// into new entries after unlock, and the export leaves through the bridge.
//
// Run from the repo root:  node test/e2e_wrapper.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8952;
const CDP_PORT = 9352;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const PASS = "correct horse magpie staple";

const fails = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    fails.push(name);
  }
}

const BRIDGE_STUB = `window.MagpieNative = {
  platform: () => "android",
  version: () => "e2e",
  sharedTokens: () => JSON.stringify(["e2etoken"]),
  canCapture: () => true,
  capturePhoto: () => { window.__captureAsked = true; },
  // The chunked hand-off: __outStatus decides what the "system" reports back.
  beginOut: (name, mime, mode) => {
    const id = "out" + (window.__outN = (window.__outN || 0) + 1);
    (window.__outs = window.__outs || {})[id] = { name, mime, mode, parts: [], maxChunk: 0 };
    return id;
  },
  appendOut: (id, b64) => {
    const out = window.__outs[id];
    out.maxChunk = Math.max(out.maxChunk, b64.length);
    out.parts.push(atob(b64));
    return true;
  },
  abortOut: (id) => { delete window.__outs[id]; },
  finishOut: (id) => {
    const out = window.__outs[id];
    const bytes = out.parts.join("");
    const record = { size: bytes.length, mime: out.mime, name: out.name, magic: bytes.slice(0, 2), maxChunk: out.maxChunk };
    const status = window.__outStatus || "ok";
    if (status === "ok") window[out.mode === "share" ? "__shared" : "__saved"] = record;
    setTimeout(() => window.__magpieOutDone(id, status), 50);
  },
};`;

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
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

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), "magpie-wrap-e2e-"));
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
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE_STUB });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "setup screen");

    check("wrapper: web-only sections removed", (await c.evalJs("document.querySelectorAll('.web-only').length")) === 0);
    check("wrapper: author credit revealed", !(await c.evalJs("document.getElementById('about-site').hidden")));
    check(
      "wrapper: author credit links to the author, not the repo",
      (await c.evalJs("document.querySelector('#about-site a').href")) === "https://github.com/munzzyy",
    );
    check("wrapper: shared token queued while locked", (await c.evalJs("__magpieApi.state.pendingShared")) === 1);

    await c.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add' && !document.getElementById('attach-name').hidden"), "shared file lands on add screen");
    check("share-in: attachment prefilled after unlock", true);
    const sharedLine = await c.evalJs("document.getElementById('attach-name').textContent");
    check("share-in: the shared file keeps its own name", sharedLine === "Attached: lease.pdf (2 KB)", sharedLine);
    check("wrapper: camera button offered", await c.evalJs("!document.getElementById('btn-camera').hidden"));

    await c.evalJs(`(() => {
      document.getElementById("add-title").value = "Shared evidence";
      document.getElementById("add-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 1"), "shared entry chained");
    const chainedName = await c.evalJs("__magpieApi.vault.listEntries().then((rows) => rows[0].entry.file.name)", true);
    check("share-in: the chained entry carries the original name", chainedName === "lease.pdf", chainedName);

    await c.evalJs("document.getElementById('btn-export').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'export'"), "export screen");

    // A save the system reports failed, or one backed out of, must not count as exported.
    await c.evalJs("window.__outStatus = 'failed'; document.getElementById('btn-export-save').click(); 'ok'");
    const failToast = await waitFor(
      () => c.evalJs("(t => /Could not hand off/.test(t) && t)(document.getElementById('toast').textContent)"),
      "hand-off failure toast",
    );
    check("share-out: a failed save says so", failToast === "Could not hand off the export.", failToast);
    await c.evalJs("window.__outStatus = 'cancelled'; document.getElementById('btn-export-save').click(); 'ok'");
    await waitFor(() => c.evalJs("Object.keys(window.__outs).length === 2"), "the cancelled save handed off");
    await sleep(300);
    check(
      "share-out: neither one anchors the record",
      (await c.evalJs("__magpieApi.vault.getAnchor().then((a) => a === null)", true)) === true &&
        (await c.evalJs("document.getElementById('anchor-line').textContent")).startsWith("Not yet anchored"),
    );
    await c.evalJs("window.__outStatus = 'ok'; 'ok'");
    await c.evalJs("document.getElementById('btn-export-share').click(); 'ok'");
    await waitFor(() => c.evalJs("!!window.__shared"), "export handed to bridge");
    const out = await c.evalJs("window.__shared");
    check("share-out: zip reaches the bridge", out.size > 1000 && out.magic === "PK" && out.mime === "application/zip" && /^magpie-export-[a-z2-9]{4}\.zip$/.test(out.name), JSON.stringify(out));
    check("share-out: no chunk over 1 MiB of base64", out.maxChunk > 0 && out.maxChunk <= 1024 * 1024, String(out.maxChunk));
    const anchored = await waitFor(() => c.evalJs("__magpieApi.vault.getAnchor()", true), "anchor after the share");
    check("share-out: a confirmed hand-off anchors the record", anchored.count === 1 && anchored.method === "export", JSON.stringify(anchored));

    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "back on the timeline");

    // The wrapper answers a shared file over the cap with 413 before reading it.
    await c.evalJs("__magpieShared(['big']); 'ok'");
    const bigToast = await waitFor(
      () => c.evalJs("(t => /too big|Could not read/.test(t) && t)(document.getElementById('toast').textContent)"),
      "too-big toast",
    );
    check("share-in: an oversized share is refused as too big", /is too big to attach; the limit is 50 MB\./.test(bigToast) && !bigToast.includes("Could not read"), bigToast);
    check("share-in: and named", bigToast.startsWith("kitchen leak.mp4 is too big"), bigToast);
    check("share-in: and nothing is staged or chained", (await c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 1")) === true);

    // No name, or one that does not decode, falls back to shared.<ext> from the type.
    for (const [token, want] of [["noname", "shared.pdf"], ["badname", "shared.pdf"], ["accented", "contrato d\u00eda 1.pdf"]]) {
      await c.evalJs(`__magpieShared([${JSON.stringify(token)}]); 'ok'`);
      await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add' && !document.getElementById('attach-name').hidden"), `${token} staged`);
      const line = await c.evalJs("document.getElementById('attach-name').textContent");
      check(`share-in: ${token} is attached as ${want}`, line === `Attached: ${want} (2 KB)`, line);
      await c.evalJs("document.getElementById('btn-add-cancel').click(); 'ok'");
      await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline again");
    }

    // No target: a main-frame https tap is what shouldOverrideUrlLoading hands to the browser.
    await c.evalJs("document.querySelector('#screen-timeline details.danger').open = true; 'ok'");
    const about = await c.evalJs(`(() => {
      const a = document.querySelector('#about-app a');
      const r = a.getBoundingClientRect();
      return { href: a.href, target: a.getAttribute('target'), shown: r.width > 0 && r.height > 0 };
    })()`);
    check(
      "wrapper: Settings carries the author credit, linked to the profile",
      about.href === "https://github.com/munzzyy" && about.target === null && about.shown,
      JSON.stringify(about),
    );
    await c.evalJs("document.querySelector('#screen-timeline details.danger').open = false; 'ok'");

    const TOPBAR_FIT = `(() => {
      const vw = document.documentElement.clientWidth;
      const kids = [...document.querySelector('#screen-timeline .topbar').children];
      const out = kids.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < 0 || r.right > vw); }).map((e) => e.id || e.tagName);
      const mids = ['btn-verify', 'btn-export', 'btn-lock'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.top + r.height / 2; });
      const badge = document.getElementById('chain-badge');
      const cs = getComputedStyle(badge);
      const lines = Math.round((badge.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
      return { vw, sw: document.documentElement.scrollWidth, out, buttonsOneRow: Math.max(...mids) - Math.min(...mids) < 4, badgeLines: lines, verify: document.getElementById('btn-verify').textContent };
    })()`;
    // Below 390px the buttons may wrap: widths follow the system font, which differs per machine.
    const fitAt = async (width, verifyLabel) => {
      await c.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await sleep(250);
      const m = await c.evalJs(TOPBAR_FIT);
      check(
        `layout: timeline topbar fits at ${width}px ("${verifyLabel}")`,
        m.verify === verifyLabel && m.sw <= m.vw && m.out.length === 0 && (width < 390 || m.buttonsOneRow) && m.badgeLines === 1,
        JSON.stringify(m),
      );
    };
    await fitAt(390, "Verify");
    await fitAt(360, "Verify");
    // Spanish has the widest button labels.
    await c.evalJs(`(() => { const p = document.getElementById('locale-pick'); p.value = 'es'; p.dispatchEvent(new Event('change')); })()`);
    await fitAt(390, "Verificar");
    await fitAt(360, "Verificar");

    const errs = await c.evalJs("(__magpieErrors || []).slice(0, 5)");
    const planted = "export-save: Error: the export did not reach the system: failed";
    check("console clean apart from the planted failed save", errs.length === 1 && errs[0] === planted, JSON.stringify(errs));
    c.close();
  } finally {
    chromium.kill();
    server.kill();
    await sleep(400);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
  if (fails.length) {
    console.log("FAILS:", fails.join("; "));
    process.exit(1);
  }
  console.log("E2E WRAPPER PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
