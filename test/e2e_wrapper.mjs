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
  shareFile: (b64, mime, name) => { window.__shared = { size: b64.length, mime, name }; },
  saveFile: (b64, mime, name) => { window.__saved = { size: b64.length, mime, name }; },
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
    check("wrapper: camera button offered", await c.evalJs("!document.getElementById('btn-camera').hidden"));

    await c.evalJs(`(() => {
      document.getElementById("add-title").value = "Shared evidence";
      document.getElementById("add-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === 1"), "shared entry chained");

    await c.evalJs("document.getElementById('btn-export').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'export'"), "export screen");
    await c.evalJs("document.getElementById('btn-export-share').click(); 'ok'");
    await waitFor(() => c.evalJs("!!window.__shared"), "export handed to bridge");
    const out = await c.evalJs("window.__shared");
    check("share-out: zip reaches the bridge", out.size > 1000 && out.mime === "application/zip" && /^magpie-export-[a-z2-9]{4}\.zip$/.test(out.name), JSON.stringify(out));

    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "back on the timeline");

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
    const fitAt = async (width, verifyLabel) => {
      await c.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await sleep(250);
      const m = await c.evalJs(TOPBAR_FIT);
      check(
        `layout: timeline topbar fits at ${width}px ("${verifyLabel}")`,
        m.verify === verifyLabel && m.sw <= m.vw && m.out.length === 0 && m.buttonsOneRow && m.badgeLines === 1,
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
    check("console clean", errs.length === 0, JSON.stringify(errs));
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
