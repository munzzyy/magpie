// Captures the fastlane store screenshots at 780x1688 (390x844 at 2x, wrapper
// mode): a made-up repair dispute on the timeline, the export screen, and the
// photo entry. Entries, photo, and dates are all invented.
//
// Run from the repo root:  node tools/shots-store.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8953;
const CDP_PORT = 9353;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const OUT = path.join(ROOT, "fastlane", "metadata", "android", "en-US", "images", "phoneScreenshots");
const PASS = "correct horse magpie staple";

const BRIDGE_STUB = `window.MagpieNative = {
  platform: () => "android",
  version: () => "0.4.3",
  sharedTokens: () => "[]",
  canCapture: () => false,
  capturePhoto: () => {},
  shareFile: () => {},
  saveFile: () => {},
};`;

// The vault stamps entries with new Date(), so the page gets a settable clock.
const CLOCK_STUB = `(() => {
  const Real = Date;
  let fixed = null;
  class PinnedDate extends Real {
    constructor(...args) {
      if (args.length === 0 && fixed !== null) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed !== null ? fixed : Real.now();
    }
  }
  window.Date = PinnedDate;
  window.__setClock = (iso) => { fixed = Real.parse(iso); };
})();`;

const ENTRIES = [
  {
    at: "2026-03-02T07:58:12Z",
    title: "Bathroom ceiling leak reported",
    note: "Water dripping from the ceiling over the tub, about a cup an hour. Called the building office at 7:52 and left a voicemail. Bucket under it for now.",
  },
  {
    at: "2026-03-02T08:06:40Z",
    title: "Photo: stain over the tub",
    note: "Stain is about a foot across and the ceiling feels soft in the middle.",
    photo: "IMG_0412.jpg",
  },
  {
    at: "2026-03-04T18:21:05Z",
    title: "Follow-up email to the office",
    note: "Emailed the building office asking for a plumber this week. Mentioned the voicemail and attached the photo.",
  },
  {
    at: "2026-03-11T19:40:33Z",
    title: "No reply, stain has spread",
    note: "Nine days since the first report and nobody has come by. The stain now reaches the light fixture and the drip is faster after showers upstairs.",
  },
  {
    at: "2026-03-16T12:15:48Z",
    title: "Second notice, certified mail",
    note: "Mailed a written repair request, certified with return receipt. Receipt is in the folder with the lease.",
  },
];

// Seeded, so every run draws the same bytes and gets the same chain head.
const DRAW_PHOTO = `(async (name) => {
  let seed = 412;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const W = 1600, H = 1200;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");

  const base = g.createLinearGradient(0, 0, W * 0.35, H);
  base.addColorStop(0, "#eeede8");
  base.addColorStop(1, "#cdcbc3");
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  const wall = g.createLinearGradient(0, H * 0.8, 0, H);
  wall.addColorStop(0, "#b3bbb6");
  wall.addColorStop(1, "#98a09b");
  g.fillStyle = wall;
  g.beginPath();
  g.moveTo(0, H * 0.87); g.lineTo(W, H * 0.81); g.lineTo(W, H); g.lineTo(0, H);
  g.fill();

  const fx = W * 0.82, fy = H * 0.17;
  g.save();
  g.filter = "blur(18px)";
  g.fillStyle = "rgba(255, 253, 244, 0.85)";
  g.beginPath(); g.ellipse(fx, fy, 190, 150, -0.15, 0, Math.PI * 2); g.fill();
  g.restore();
  const dome = g.createRadialGradient(fx - 20, fy - 15, 5, fx, fy, 100);
  dome.addColorStop(0, "#ffffff");
  dome.addColorStop(0.7, "#f4f2ea");
  dome.addColorStop(1, "#d9d6cc");
  g.save();
  g.filter = "blur(1.2px)";
  g.fillStyle = dome;
  g.beginPath(); g.ellipse(fx, fy, 100, 78, -0.15, 0, Math.PI * 2); g.fill();
  g.restore();

  const harm = (n) => Array.from({ length: n }, (_, k) => ({ k: k + 2, a: (0.16 / (k + 1)) * (0.6 + rnd()), p: rnd() * 6.283 }));
  const ripple = (n) => Array.from({ length: n }, (_, k) => ({ k: k + 9, a: 0.012 + rnd() * 0.014, p: rnd() * 6.283 }));
  const outer = [...harm(6), ...ripple(10)], inner = [...harm(5), ...ripple(8)];
  const tide = harm(3);
  const radius = (h, th) => 1 + h.reduce((s, { k, a, p }) => s + a * Math.sin(k * th + p), 0);
  const cx = W * 0.43, cy = H * 0.45, R = 360;
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dx = (x - cx) / R, dy = (y - cy) / (R * 0.8);
      const th = Math.atan2(dy, dx);
      const dist = Math.hypot(dx, dy);
      const t = dist / radius(outer, th);
      const u = dist / (0.6 * radius(inner, th));
      const blot = 0.5 + 0.25 * Math.sin(x / 57 + ph[0]) * Math.sin(y / 43 + ph[1]) + 0.25 * Math.sin((x + y) / 91 + ph[2]);
      let a = 0;
      if (t < 1) a += (0.1 + 0.1 * t) * (0.7 + 0.6 * blot);
      const edge = Math.max(0.25, radius(tide, th) - 0.55);
      a += 0.42 * edge * Math.exp(-(((t - 0.975) / (0.016 + 0.014 * edge)) ** 2));
      a += 0.1 * Math.exp(-(((t - 1.05) / 0.05) ** 2));
      a += 0.12 * edge * Math.exp(-(((u - 0.97) / 0.03) ** 2));
      if (u < 1) a += 0.05;
      a = Math.min(a, 0.6);
      d[i] = d[i] * (1 - a) + 148 * a;
      d[i + 1] = d[i + 1] * (1 - a) + 104 * a;
      d[i + 2] = d[i + 2] * (1 - a) + 52 * a;
      const n = (rnd() - 0.5) * 12;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
  }
  g.putImageData(img, 0, 0);

  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  vig.addColorStop(0, "rgba(0, 0, 0, 0)");
  vig.addColorStop(1, "rgba(0, 0, 0, 0.3)");
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);

  const jpeg = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.88));
  const dt = new DataTransfer();
  dt.items.add(new File([jpeg], name, { type: "image/jpeg" }));
  const input = document.getElementById("attach-input");
  input.files = dt.files;
  input.dispatchEvent(new Event("change"));
  return jpeg.size;
})`;

async function waitFor(fn, desc, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timeout: ${desc}`);
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
  return { send, evalJs, open: new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "magpie-shots-"));
  const server = spawn("node", [path.join(ROOT, "test", "serve_local.mjs"), String(HTTP_PORT)], { stdio: "ignore" });
  const chromium = spawn(
    "chromium",
    ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + profile, "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=2", "about:blank"],
    { stdio: "ignore" },
  );
  try {
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        fetch(`${BASE}/index.html`).then((r) => r.ok).catch(() => false),
        fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false),
      ]);
      return a && b;
    }, "server + devtools");

    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
    const tab = await res.json();
    const c = connect(tab.webSocketDebuggerUrl);
    await c.open;
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE_STUB });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK_STUB });
    await c.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await c.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(() => c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "setup");

    // A toast, sideways scroll, or page error fails the run instead of shipping.
    const shot = async (name) => {
      await waitFor(() => c.evalJs("!document.getElementById('toast').classList.contains('show')"), "toast gone");
      await sleep(600);
      const bad = await c.evalJs(`(() => {
        const out = [];
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push("horizontal scroll");
        if (getComputedStyle(document.getElementById('toast')).visibility !== 'hidden') out.push("toast visible");
        if (__magpieErrors.length) out.push("errors: " + __magpieErrors.join("; "));
        return out;
      })()`);
      if (bad.length) throw new Error(`${name}: ${bad.join(", ")}`);
      const s = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, "base64"));
      console.log(`wrote ${name}`);
    };

    await c.evalJs(`__setClock("2026-03-02T07:55:00Z")`);
    await c.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline");

    for (const [i, e] of ENTRIES.entries()) {
      await c.evalJs("document.getElementById('btn-add').click(); 'ok'");
      await waitFor(() => c.evalJs("__magpieApi.state.screen === 'add'"), "add screen");
      if (e.photo) {
        await c.evalJs(`${DRAW_PHOTO}(${JSON.stringify(e.photo)})`, true);
        await waitFor(() => c.evalJs("!document.getElementById('attach-name').hidden"), "photo attached");
      }
      await c.evalJs(`__setClock(${JSON.stringify(e.at)})`);
      await c.evalJs(`(() => {
        document.getElementById("add-title").value = ${JSON.stringify(e.title)};
        document.getElementById("add-note").value = ${JSON.stringify(e.note)};
        document.getElementById("add-form").requestSubmit();
      })()`);
      await waitFor(
        () => c.evalJs(`__magpieApi.state.screen === 'timeline' && document.querySelectorAll('#timeline li').length === ${i + 1}`),
        `entry ${i + 1} chained`,
      );
    }

    await c.evalJs(`__setClock("2026-03-16T12:20:00Z")`);
    await c.evalJs("document.getElementById('btn-export').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'export'"), "export");
    await c.evalJs("document.getElementById('btn-export-share').click(); 'ok'");
    await waitFor(() => c.evalJs("document.getElementById('anchor-line').textContent.startsWith('Pinned through entry 5')"), "anchored");
    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "back to timeline");
    await waitFor(
      () => c.evalJs(`document.getElementById('chain-badge').textContent === "${ENTRIES.length} entries, chain intact"`),
      "badge",
    );
    await c.evalJs("document.activeElement.blur(); 'ok'");
    await shot("1.png");

    await c.evalJs("document.getElementById('btn-export').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'export' && /^[0-9a-f]{64}$/.test(document.getElementById('export-head').textContent)"), "export");
    await c.evalJs("document.activeElement.blur(); 'ok'");
    await shot("2.png");

    await c.evalJs("document.getElementById('btn-export-back').click(); 'ok'");
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline again");
    const photoSeq = ENTRIES.findIndex((e) => e.photo) + 1;
    await c.evalJs(`document.querySelector('#timeline li[data-seq="${photoSeq}"] button').click(); 'ok'`);
    await waitFor(() => c.evalJs("__magpieApi.state.screen === 'entry' && document.getElementById('entry-img').complete && !document.getElementById('entry-img').hidden"), "photo entry");
    await c.evalJs("document.activeElement.blur(); 'ok'");
    await shot("3.png");
  } finally {
    chromium.kill();
    server.kill();
    await sleep(400);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
  console.log("store screenshots done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
