// Opt-in, and not part of npm run e2e: chains six attachments just under the
// 50 MB cap (about 294 MB), saves a sealed backup through the real button,
// and restores that file in a second, empty browser profile. It writes
// about 1 GB to test/fixtures while it runs and removes it afterwards.
//
// Run from the repo root:  node test/e2e_big.mjs
// MAGPIE_BIG_FILES=3 node test/e2e_big.mjs changes how many files it chains.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8953;
const CDP_A = 9353;
const CDP_B = 9354;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const PASS = "a big journal needs a backup";
const FILES = Number(process.env.MAGPIE_BIG_FILES || 6);
const FILE_BYTES = 49 * 1024 * 1024;

const fails = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    fails.push(name);
  }
}

async function waitFor(fn, desc, timeout = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      // A page stuck in a long task never answers, so each try gets only the time that is left.
      last = await Promise.race([fn(), sleep(timeout - (Date.now() - t0))]);
      if (last) return last;
    } catch (err) {
      if (err.crash) throw err;
      last = String(err);
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${desc}; last: ${JSON.stringify(last)}`);
}

const crashError = () => Object.assign(new Error("the renderer crashed"), { crash: true });

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const state = { crashed: false };
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Inspector.targetCrashed") {
      state.crashed = true;
      // A dead page never answers, so anything still waiting on it would hang the run.
      for (const { reject } of pending.values()) reject(crashError());
      pending.clear();
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (state.crashed) return reject(crashError());
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.result.exceptionDetails)}`);
    return r.result?.result?.value;
  };
  return {
    state,
    send,
    evalJs,
    open: new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    }),
    close: () => ws.close(),
  };
}

async function browser(port, profile) {
  const proc = spawn(
    "chromium",
    ["--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=" + profile, "--no-sandbox", "--disable-gpu", "about:blank"],
    { stdio: "ignore" },
  );
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok), "devtools up");
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const c = connect(tab.webSocketDebuggerUrl);
  await c.open;
  for (const domain of ["Page", "Runtime", "DOM", "Inspector"]) await c.send(`${domain}.enable`);
  await c.send("Page.navigate", { url: BASE + "/" });
  return { proc, c };
}

async function main() {
  const work = path.join(ROOT, "test", "fixtures");
  mkdirSync(work, { recursive: true });
  const scratch = mkdtempSync(path.join(work, "big-"));
  const downloads = path.join(scratch, "downloads");
  mkdirSync(downloads);
  const server = spawn("node", [path.join(ROOT, "test", "serve_local.mjs"), String(HTTP_PORT)], { stdio: "ignore" });
  const procs = [];
  const run = async () => {
    await waitFor(() => fetch(`${BASE}/index.html`).then((r) => r.ok), "server up");

    // ------------------------------------------- profile A: chain and back up
    const a = await browser(CDP_A, path.join(scratch, "profile-a"));
    procs.push(a.proc);
    await waitFor(() => a.c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "setup screen");
    await a.c.evalJs(`(() => {
      document.getElementById("setup-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-pass2").value = ${JSON.stringify(PASS)};
      document.getElementById("setup-form").requestSubmit();
    })()`);
    await waitFor(() => a.c.evalJs("__magpieApi.state.screen === 'timeline'"), "timeline after setup");
    let t0 = Date.now();
    for (let i = 1; i <= FILES; i++) {
      await a.c.evalJs(
        `__magpieApi.vault.addEntry({ type: "file", title: "Video ${i}", note: "", fileBytes: new Uint8Array(${FILE_BYTES}).fill(${i}), fileName: "video-${i}.mp4", fileMime: "video/mp4" }).then(() => true)`,
        true,
      );
    }
    console.log(`  ..   chained ${FILES} x 49 MiB in ${Date.now() - t0} ms`);

    await a.c.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    t0 = Date.now();
    await a.c.evalJs("document.getElementById('btn-backup').click(); 'ok'");
    const backupFile = await waitFor(
      () => {
        if (a.c.state.crashed) throw crashError();
        const done = readdirSync(downloads).filter((n) => n.endsWith(".magpiebackup"));
        return done.length === 1 && path.join(downloads, done[0]);
      },
      "the sealed backup download",
      300000,
    ).catch((err) => {
      console.log(`  ..   ${err.message}`);
      return null;
    });
    check("backup: the renderer survives sealing the backup", !a.c.state.crashed);
    check("backup: a file is saved", !!backupFile);
    if (!backupFile) return;
    const size = statSync(backupFile).size;
    console.log(`  ..   ${path.basename(backupFile)}: ${size} bytes in ${Date.now() - t0} ms`);
    check("backup: it carries every attachment", size > FILES * FILE_BYTES, String(size));
    const toast = await a.c.evalJs("document.getElementById('toast').textContent");
    check("backup: the page says it downloaded", toast.startsWith("Sealed backup downloaded."), toast);
    a.c.close();
    a.proc.kill();

    // ------------------------------------------- profile B: restore it fresh
    const b = await browser(CDP_B, path.join(scratch, "profile-b"));
    procs.push(b.proc);
    await waitFor(() => b.c.evalJs("!!window.__magpieApi && __magpieApi.state.screen === 'setup'"), "setup screen in profile B");
    const { root } = (await b.c.send("DOM.getDocument")).result;
    const input = (await b.c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#restore-file" })).result;
    await b.c.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [backupFile] });
    t0 = Date.now();
    await b.c.evalJs(`(() => {
      document.getElementById("restore-pass").value = ${JSON.stringify(PASS)};
      document.getElementById("restore-form").requestSubmit();
    })()`);
    await waitFor(
      () => {
        if (b.c.state.crashed) throw crashError();
        return b.c.evalJs("__magpieApi.state.screen === 'timeline' || !document.getElementById('restore-error').hidden");
      },
      "the restore to finish",
      300000,
    ).catch((err) => console.log(`  ..   ${err.message}`));
    console.log(`  ..   restore took ${Date.now() - t0} ms`);
    check("restore: the renderer survives", !b.c.state.crashed);
    if (b.c.state.crashed) return;
    check("restore: no refusal", await b.c.evalJs("document.getElementById('restore-error').hidden"), await b.c.evalJs("document.getElementById('restore-error').textContent"));
    const res = await b.c.evalJs("__magpieApi.vault.verify()", true);
    check(`restore: the chain verifies with all ${FILES} entries`, res?.ok === true && res.count === FILES, JSON.stringify(res));
    const last = await b.c.evalJs(
      `__magpieApi.vault.getFile(${FILES}).then((f) => f && { n: f.length, first: f[0], end: f[f.length - 1] })`,
      true,
    );
    check("restore: the last attachment comes back whole", last?.n === FILE_BYTES && last.first === FILES && last.end === FILES, JSON.stringify(last));
    b.c.close();
  };
  try {
    await run();
  } finally {
    for (const p of procs) p.kill();
    server.kill();
    await sleep(600);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (fails.length) {
    console.log("FAILS:", fails.join("; "));
    process.exit(1);
  }
  console.log("E2E BIG PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
