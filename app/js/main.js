// Boot and flow. One rule above all: no screen shows journal content while
// the vault is locked, and locking is the default response to anything
// surprising (hidden too long, wrong state, errors).

import * as vault from "./vault.js";
import { buildExport } from "./export.js";
import { isWrapper, wrapperVersion, shareOut, saveOut, canCapture, capturePhoto, onCaptured, sharedTokens, onShared, ExportUnavailableError } from "./platform.js";
import { isBundled } from "./env.js";
import { setLocale, resolveLocale, translateDom, t, LOCALE_CHOICES } from "./i18n.js";

const VERSION = "0.4.3";

globalThis.__magpieErrors = [];
window.addEventListener("error", (ev) => __magpieErrors.push(String(ev.message)));
window.addEventListener("unhandledrejection", (ev) => __magpieErrors.push(String(ev.reason)));
document.addEventListener("securitypolicyviolation", (ev) =>
  __magpieErrors.push(`csp: ${ev.violatedDirective} ${ev.blockedURI}`),
);

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
const announce = (msg) => {
  $("sr-live").textContent = msg;
};

// ------------------------------------------------------------------ state

const SCREENS = ["setup", "lock", "timeline", "add", "entry", "export"];
const OPEN_SCREENS = new Set(["timeline", "add", "entry", "export"]);

// Files shared or captured before there was an unlocked vault to put them
// in; consumed one per new entry.
let pendingShared = [];
let pendingAttach = null;
let exportBlob = null;
let exportState = null;
let entryUrls = [];

// An attachment is read, sealed, and base64-encoded whole in memory, so a very
// large file exhausts RAM and the OS kills the app before it lands. Refuse it up
// front, by File.size, before anything reads it into memory.
const MAX_ATTACH_MB = 50;
const MAX_ATTACH_BYTES = MAX_ATTACH_MB * 1024 * 1024;
// The last-rendered, already-decrypted rows: search filters this in memory
// only, never re-touches the vault, and is thrown away on lock.
let currentRows = [];
let justSealedSeq = null;

const app = {
  get state() {
    return {
      screen: SCREENS.find((s) => !$(`screen-${s}`).hidden) || "none",
      locked: vault.isLocked(),
      wrapper: isWrapper(),
      pendingShared: pendingShared.length,
      version: VERSION,
    };
  },
  vault,
};
globalThis.__magpieApi = app;

function show(name) {
  // Fail closed: an open screen without an open vault becomes the lock
  // screen, whatever asked for it.
  if (OPEN_SCREENS.has(name) && vault.isLocked()) name = "lock";
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  window.scrollTo(0, 0);
  if (name === "lock") $("lock-pass").focus({ preventScroll: true });
  else if (name === "add") $("add-title").focus({ preventScroll: true });
  else if (name === "timeline") $("btn-add").focus({ preventScroll: true });
  else if (name === "entry") $("entry-title").focus({ preventScroll: true });
  else if (name === "export") $("export-title").focus({ preventScroll: true });
}

function releaseEntryUrls() {
  for (const u of entryUrls) URL.revokeObjectURL(u);
  entryUrls = [];
}

function lockNow(message) {
  vault.lock();
  releaseEntryUrls();
  exportBlob = null;
  exportState = null;
  pendingAttach = null;
  currentRows = [];
  $("timeline").textContent = "";
  $("entry-note").textContent = "";
  $("entry-title").textContent = "";
  $("entry-img").removeAttribute("src");
  $("entry-file").textContent = "";
  $("entry-meta").textContent = "";
  $("entry-hash").textContent = "";
  $("export-head").textContent = "";
  const reminder = $("export-reminder");
  if (reminder) reminder.textContent = "";
  const anchorLine = $("anchor-line");
  if (anchorLine) anchorLine.textContent = "";
  const search = $("search-timeline");
  if (search) search.value = "";
  const noMatch = $("search-no-match");
  if (noMatch) noMatch.hidden = true;
  $("add-form").reset();
  $("attach-name").textContent = "";
  $("attach-name").hidden = true;
  $("sr-live").textContent = "";
  show("lock");
  if (message) toast(message);
}

// ------------------------------------------------------------- timeline

const fmtTs = (iso) => new Date(iso).toLocaleString();

async function renderTimeline() {
  const rows = await vault.listEntries();
  currentRows = rows;
  const list = $("timeline");
  list.textContent = "";
  $("timeline-empty").hidden = rows.length > 0;
  const searchRow = $("search-row");
  if (searchRow) searchRow.hidden = rows.length === 0;
  for (const { entry, hash } of rows.slice().reverse()) {
    const li = document.createElement("li");
    li.dataset.seq = entry.seq;
    if (entry.seq === justSealedSeq) li.classList.add("tl-seal");
    const dot = document.createElement("span");
    dot.className = "tl-dot";
    dot.setAttribute("aria-hidden", "true");
    const btn = document.createElement("button");
    btn.type = "button";
    const title = document.createElement("span");
    title.className = "tl-title";
    title.textContent = entry.title;
    const meta = document.createElement("span");
    meta.className = "tl-meta";
    const kind = entry.file ? (entry.file.mime.startsWith("image/") ? t("photo") : t("file")) : t("note");
    const metaText = document.createElement("span");
    metaText.textContent = `#${entry.seq} · ${kind} · ${fmtTs(entry.ts)}`;
    const metaHash = document.createElement("code");
    metaHash.className = "tl-hash";
    metaHash.textContent = hash.slice(0, 12);
    meta.append(metaText, metaHash);
    btn.append(title, document.createElement("br"), meta);
    btn.addEventListener("click", () => openEntry(entry, hash));
    li.append(dot, btn);
    list.append(li);
  }
  justSealedSeq = null;
  applySearchFilter();
  await refreshBadge(rows.length);
  await updateAnchorStatus(rows.length);
}

// Filters the timeline's own DOM against the entries already decrypted for
// this render: no re-fetch from the vault, no index kept anywhere but this
// module's memory, and nothing here ever reaches storage. currentRows (and
// this filter) are wiped on lock along with everything else in lockNow().
function applySearchFilter() {
  const input = $("search-timeline");
  const q = (input?.value || "").trim().toLowerCase();
  const bySeq = new Map(currentRows.map((r) => [r.entry.seq, r.entry]));
  let visible = 0;
  for (const li of $("timeline").querySelectorAll("li")) {
    const entry = bySeq.get(Number(li.dataset.seq));
    const hit = !q || (entry && (entry.title.toLowerCase().includes(q) || entry.note.toLowerCase().includes(q)));
    li.hidden = !hit;
    if (hit) visible++;
  }
  const noMatch = $("search-no-match");
  if (noMatch) noMatch.hidden = !(q && visible === 0 && currentRows.length > 0);
}

async function refreshBadge(count) {
  const badge = $("chain-badge");
  if (count === 0) {
    badge.className = "chain-badge";
    badge.textContent = "";
    return;
  }
  // A full recompute on every paint is honest and cheap at journal scale;
  // if it ever slows down, the Verify button stays the source of truth.
  const res = await vault.verify();
  badge.className = `chain-badge ${res.ok ? "ok" : "bad"}`;
  badge.textContent = !res.ok
    ? t("CHAIN BROKEN at entry {seq}", { seq: res.badSeq ?? "?" })
    : res.timeWarning
      ? t("{count} entries, chain intact (entry {seq}'s time is earlier than the one before it)", { count, seq: res.timeWarning })
      : t("{count} entries, chain intact", { count });
}

async function openEntry(entry, hash) {
  releaseEntryUrls();
  $("entry-title").textContent = entry.title;
  $("entry-meta").textContent = `#${entry.seq} · ${fmtTs(entry.ts)}`;
  $("entry-note").textContent = entry.note;
  const img = $("entry-img");
  const fileLine = $("entry-file");
  img.hidden = true;
  fileLine.hidden = true;
  if (entry.file) {
    const bytes = await vault.getFile(entry.seq);
    if (bytes && entry.file.mime.startsWith("image/")) {
      const url = URL.createObjectURL(new Blob([bytes], { type: entry.file.mime }));
      entryUrls.push(url);
      img.src = url;
      img.alt = entry.title;
      img.hidden = false;
    } else if (entry.file) {
      fileLine.textContent = `${entry.file.name} (${Math.max(1, Math.round(entry.file.size / 1024))} KB) · sha256 ${entry.file.sha256.slice(0, 16)}`;
      fileLine.hidden = false;
    }
  }
  $("entry-hash").textContent = hash;
  show("entry");
}

// ------------------------------------------------------------------- add

function setPendingAttach(bytes, name, mime) {
  if (bytes.length > MAX_ATTACH_BYTES) {
    toast(t("{name} is too big to attach; the limit is {mb} MB.", { name, mb: MAX_ATTACH_MB }));
    return;
  }
  pendingAttach = { bytes, name, mime };
  const line = $("attach-name");
  line.textContent = t("Attached: {name} ({kb} KB)", {
    name,
    kb: Math.max(1, Math.round(bytes.length / 1024)),
  });
  line.hidden = false;
  announce(line.textContent);
}

async function saveEntry(ev) {
  ev.preventDefault();
  const title = $("add-title").value.trim();
  if (!title) return;
  try {
    const { entry } = await vault.addEntry({
      type: pendingAttach ? (pendingAttach.mime.startsWith("image/") ? "photo" : "file") : "note",
      title,
      note: $("add-note").value,
      fileBytes: pendingAttach?.bytes ?? null,
      fileName: pendingAttach?.name,
      fileMime: pendingAttach?.mime,
    });
    $("add-form").reset();
    $("attach-name").hidden = true;
    pendingAttach = null;
    announce(t("Entry {seq} chained", { seq: entry.seq }));
    if (pendingShared.length) {
      await nextSharedIntoAdd();
    } else {
      justSealedSeq = entry.seq;
      await renderTimeline();
      show("timeline");
    }
  } catch (err) {
    __magpieErrors.push(`save: ${err}`);
    if (err instanceof vault.LockedError) lockNow();
    else toast(t("Could not save the entry."));
  }
}

// Queue items are wrapper tokens (strings) or web share-target payloads
// ({ bytes, mime, name }); either way, one pending file per new entry.
async function nextSharedIntoAdd() {
  const item = pendingShared.shift();
  try {
    let bytes;
    let mime;
    let name;
    if (typeof item === "string") {
      const res = await fetch(`/shared/${item}`);
      if (!res.ok) throw new Error(String(res.status));
      bytes = new Uint8Array(await res.arrayBuffer());
      mime = res.headers.get("content-type") || "application/octet-stream";
    } else {
      ({ bytes, mime, name } = item);
    }
    if (!name) {
      const ext = mime.startsWith("image/") ? mime.split("/")[1].replace("jpeg", "jpg") : "bin";
      name = `shared.${ext}`;
    }
    show("add");
    setPendingAttach(bytes, name, mime);
    if (pendingShared.length) {
      toast(t("{count} more shared file(s) waiting; each becomes its own entry.", { count: pendingShared.length }));
    }
  } catch (err) {
    __magpieErrors.push(`shared: ${err}`);
    toast(t("Could not read the shared file."));
    show("timeline");
  }
}

// ---------------------------------------------------------------- export

async function openExport() {
  try {
    const { zip, head, count } = await buildExport();
    exportBlob = new Blob([zip], { type: "application/zip" });
    exportState = { head, count };
    $("export-head").textContent = head;
    show("export");
  } catch (err) {
    __magpieErrors.push(`export: ${err}`);
    if (err instanceof vault.LockedError) lockNow();
    else toast(t("Could not build the export."));
  }
}

// Export nudge: a plain, non-nagging line, never a popup. It only reads what
// shareOut/saveOut already reported succeeding; there is no way to know a
// share sheet's own outcome, so "exported" means "handed to the platform",
// the same honesty the toast copy carries. The anchor record it writes into
// lives inside the sealed vault, never plaintext localStorage: a device
// backup or a stolen browser profile used to leak roughly how long this
// journal had been in use, and now that leak is closed.
async function markExported() {
  if (!exportState) return;
  try {
    await vault.setAnchor({ head: exportState.head, count: exportState.count, method: "export", ts: Date.now() });
  } catch (err) {
    __magpieErrors.push(`anchor: ${err}`);
  }
  await updateAnchorStatus(exportState.count);
}

// Drives both the "pinned through entry N" line on the timeline and the
// export nudge in Settings, from the one sealed anchor record.
async function updateAnchorStatus(liveCount) {
  const line = $("anchor-line");
  const reminder = $("export-reminder");
  let anchor = null;
  try {
    anchor = await vault.getAnchor();
  } catch {
    if (line) line.textContent = "";
    if (reminder) reminder.textContent = "";
    return;
  }
  if (!anchor) {
    if (line) line.textContent = liveCount ? t("Not yet anchored. Export and share the head hash to pin the record.") : "";
    if (reminder) reminder.textContent = liveCount ? t("You have not exported this journal yet. Keep a copy somewhere safe.") : "";
    return;
  }
  if (line) {
    line.textContent =
      anchor.count >= liveCount
        ? t("Pinned through entry {n}.", { n: anchor.count })
        : t("Pinned through entry {n}. {more} added since.", { n: anchor.count, more: liveCount - anchor.count });
  }
  if (reminder) {
    const days = Math.floor((Date.now() - anchor.ts) / 86400000);
    reminder.textContent = days <= 0 ? t("Exported today.") : t("{days} day(s) since your last export.", { days });
  }
}

// The bridge exists but declined (a stale wrapper build) or something in
// the hand-off itself failed. Either way the user must be told plainly;
// never a silent no-op, never a fake success toast.
function reportExportFailure(err) {
  toast(
    err instanceof ExportUnavailableError
      ? t("This build of Magpie cannot get the export out of the app. Update it and try again.")
      : t("Could not hand off the export."),
    6000,
  );
}

const randomTag = () => {
  const raw = crypto.getRandomValues(new Uint8Array(4));
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let tag = "";
  for (const b of raw) tag += alphabet[b % alphabet.length];
  return tag;
};
const exportName = () => `magpie-export-${randomTag()}.zip`;
const backupName = () => `magpie-backup-${randomTag()}.magpiebackup`;

function restoreMessage(code) {
  switch (code) {
    case "already-set-up":
      return t("A journal already exists on this device. Delete it first, then restore.");
    case "not-a-backup":
      return t("That file is not a Magpie sealed backup.");
    case "wrong-passphrase":
      return t("That passphrase does not open this backup.");
    case "corrupt":
      return t("This backup is damaged and cannot be restored.");
    case "chain-invalid":
      return t("This backup's chain does not verify. It may be tampered with, so it was refused.");
    default:
      return t("Could not restore this backup.");
  }
}

// ------------------------------------------------------------------ boot

function wireEvents() {
  $("setup-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = $("setup-pass").value;
    const b = $("setup-pass2").value;
    if (a !== b) {
      toast(t("The two passphrases do not match."));
      return;
    }
    await vault.setup(a);
    $("setup-pass").value = "";
    $("setup-pass2").value = "";
    await renderTimeline();
    show("timeline");
    if (pendingShared.length) await nextSharedIntoAdd();
  });

  $("restore-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const file = $("restore-file").files[0];
    const pass = $("restore-pass").value;
    $("restore-error").hidden = true;
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { count } = await vault.restoreBackup(bytes, pass);
      $("restore-pass").value = "";
      $("restore-file").value = "";
      await renderTimeline();
      show("timeline");
      toast(t("Restored: {count} entry(ies).", { count }));
      if (pendingShared.length) await nextSharedIntoAdd();
    } catch (err) {
      __magpieErrors.push(`restore: ${err}`);
      const msg = err instanceof vault.RestoreBlockedError ? restoreMessage(err.code) : restoreMessage(null);
      $("restore-error").textContent = msg;
      $("restore-error").hidden = false;
      announce(msg);
    }
  });

  // Shake is purely decorative and additive: the screen-reader announcement
  // below is the actual failure signal and must fire every time regardless.
  function shakeLockForm() {
    const form = $("lock-form");
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
  }

  $("lock-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const ok = await vault.unlock($("lock-pass").value);
    $("lock-pass").value = "";
    $("lock-error").hidden = ok;
    if (!ok) {
      announce(t("That passphrase does not open this journal."));
      shakeLockForm();
      $("lock-pass").focus({ preventScroll: true });
      return;
    }
    await renderTimeline();
    show("timeline");
    if (pendingShared.length) await nextSharedIntoAdd();
  });

  $("btn-lock").addEventListener("click", () => lockNow());
  $("btn-add").addEventListener("click", () => show("add"));
  $("btn-add-cancel").addEventListener("click", () => {
    pendingAttach = null;
    $("add-form").reset();
    $("attach-name").hidden = true;
    show("timeline");
  });
  $("add-form").addEventListener("submit", saveEntry);

  $("btn-attach").addEventListener("click", () => $("attach-input").click());
  $("attach-input").addEventListener("change", async () => {
    const picked = [...$("attach-input").files];
    $("attach-input").value = "";
    if (!picked.length) return;
    const files = picked.filter((f) => f.size <= MAX_ATTACH_BYTES);
    if (files.length < picked.length) {
      const big = picked.find((f) => f.size > MAX_ATTACH_BYTES);
      toast(t("{name} is too big to attach; the limit is {mb} MB.", { name: big.name, mb: MAX_ATTACH_MB }));
    }
    if (!files.length) return;
    const [first, ...rest] = files;
    // One pick, N chained entries: the first file stages this entry like
    // always, and every other file joins the same queue a shared-in file
    // uses, so each becomes its own entry after this one is saved.
    for (const f of rest) {
      pendingShared.push({ bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type || "application/octet-stream", name: f.name });
    }
    setPendingAttach(new Uint8Array(await first.arrayBuffer()), first.name, first.type || "application/octet-stream");
    if (rest.length) {
      toast(t("{count} more shared file(s) waiting; each becomes its own entry.", { count: rest.length }));
    }
  });
  $("btn-camera").addEventListener("click", () => capturePhoto());

  $("search-timeline")?.addEventListener("input", applySearchFilter);

  $("btn-entry-back").addEventListener("click", () => {
    releaseEntryUrls();
    show("timeline");
  });
  $("btn-verify").addEventListener("click", async () => {
    const res = await vault.verify();
    toast(
      !res.ok
        ? t("CHAIN BROKEN at entry {seq}.", { seq: res.badSeq ?? "?" })
        : res.timeWarning
          ? t("Chain intact: {count} entries verify. Entry {seq}'s time is earlier than the one before it.", {
              count: res.count,
              seq: res.timeWarning,
            })
          : t("Chain intact: {count} entries verify.", { count: res.count }),
      6000,
    );
    await refreshBadge(res.count);
  });

  $("btn-export").addEventListener("click", openExport);
  $("btn-export-back").addEventListener("click", () => show("timeline"));
  $("btn-export-share").addEventListener("click", async () => {
    if (!exportBlob) return;
    try {
      const ok = await shareOut(exportBlob, exportName());
      if (ok) {
        await markExported();
        toast(t("Choose where to send it."));
        return;
      }
      const how = await saveOut(exportBlob, exportName());
      await markExported();
      toast(
        how === "download"
          ? t("Sharing is not available here, so it downloaded instead.")
          : t("Choose where to save it."),
      );
    } catch (err) {
      __magpieErrors.push(`export-share: ${err}`);
      reportExportFailure(err);
    }
  });
  $("btn-export-save").addEventListener("click", async () => {
    if (!exportBlob) return;
    try {
      const how = await saveOut(exportBlob, exportName());
      await markExported();
      if (how === "download") toast(t("Downloaded"));
      else if (how === "ios-share") toast(t("Choose where to save it."));
    } catch (err) {
      __magpieErrors.push(`export-save: ${err}`);
      reportExportFailure(err);
    }
  });
  $("btn-backup").addEventListener("click", async () => {
    try {
      const bytes = await vault.exportBackup();
      const blob = new Blob([bytes], { type: "application/json" });
      const how = await saveOut(blob, backupName());
      toast(
        how === "download"
          ? t("Sealed backup downloaded. It is safe to park anywhere; only your passphrase opens it.")
          : t("Choose where to save your sealed backup."),
      );
    } catch (err) {
      __magpieErrors.push(`backup: ${err}`);
      if (err instanceof vault.LockedError) lockNow();
      else reportExportFailure(err);
    }
  });
  $("btn-copy-head").addEventListener("click", () => {
    const head = $("export-head").textContent;
    navigator.clipboard?.writeText(head).then(
      () => toast(t("Head hash copied. Send it somewhere with a date.")),
      () => toast(head),
    );
  });

  $("wipe-confirm").addEventListener("input", () => {
    $("btn-wipe").disabled = $("wipe-confirm").value !== "DELETE";
  });
  $("btn-wipe").addEventListener("click", async () => {
    await vault.wipe();
    $("wipe-confirm").value = "";
    $("btn-wipe").disabled = true;
    pendingShared = [];
    lockNow(t("Everything is deleted."));
    show("setup");
  });

  // Hidden too long means locked, full stop.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    let limit = 60000;
    try {
      const v = Number(localStorage.getItem("magpie-autolock"));
      if (Number.isFinite(v)) limit = v * 1000;
    } catch {}
    if (!vault.isLocked() && hiddenAt && Date.now() - hiddenAt >= limit) {
      lockNow(t("Locked while you were away."));
    }
  });
  const autolock = $("autolock");
  try {
    autolock.value = localStorage.getItem("magpie-autolock") ?? "60";
  } catch {}
  autolock.addEventListener("change", () => {
    try {
      localStorage.setItem("magpie-autolock", autolock.value);
    } catch {}
  });
}

function buildLocalePicker() {
  const select = $("locale-pick");
  for (const { id, label } of LOCALE_CHOICES) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    select.append(opt);
  }
  let pref = "auto";
  try {
    pref = localStorage.getItem("magpie-locale") || "auto";
  } catch {}
  select.value = pref;
  select.addEventListener("change", () => {
    try {
      localStorage.setItem("magpie-locale", select.value);
    } catch {}
    setLocale(resolveLocale(select.value));
    translateDom();
  });
}

async function boot() {
  // One-time migration: the export nudge used to live in this plaintext
  // key before the anchor record moved inside the sealed vault. Nothing
  // writes it anymore; this just finishes clearing it off upgraded
  // installs so no plaintext usage-timing metadata lingers on disk.
  try {
    localStorage.removeItem("magpie-last-export");
  } catch {}

  let pref = "auto";
  try {
    pref = localStorage.getItem("magpie-locale") || "auto";
  } catch {}
  setLocale(resolveLocale(pref));
  translateDom();
  buildLocalePicker();

  // "Bundled" (Android bridge or the iOS scheme) strips the marketing
  // landing and browser-install copy: neither is a browser tab. Camera
  // capture stays gated on isWrapper() alone, since only Android's bridge
  // can hand the page a photo back from the system camera app.
  if (isBundled()) {
    for (const node of document.querySelectorAll(".web-only")) node.remove();
    $("btn-camera").hidden = !(isWrapper() && canCapture());
  } else if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  const ver = $("ver");
  if (ver) ver.textContent = `v${VERSION}${isWrapper() ? ` · app ${wrapperVersion()}` : ""}`;

  wireEvents();

  onShared((tokens) => {
    // Dedup defensively: an older wrapper may replay already-queued tokens.
    for (const token of tokens) {
      if (!pendingShared.includes(token)) pendingShared.push(token);
    }
    if (!vault.isLocked()) nextSharedIntoAdd();
    else toast(t("Unlock to attach the shared file."));
  });
  onCaptured(async (token) => {
    if (!token) return;
    // A capture that lands on a locked vault (aggressive autolock during
    // the camera trip) queues like a share; losing the photo is worse.
    if (vault.isLocked()) {
      pendingShared.push(token);
      toast(t("Unlock to attach your photo."));
      return;
    }
    try {
      const res = await fetch(`/shared/${token}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      show("add");
      setPendingAttach(bytes, "photo.jpg", res.headers.get("content-type") || "image/jpeg");
    } catch (err) {
      __magpieErrors.push(`capture: ${err}`);
    }
  });
  pendingShared.push(...sharedTokens());

  // Web share-target: the worker parked files for one pickup; every boot
  // purges the parking lot either way. Neither wrapper ever registers the
  // service worker that fills this cache, so bundled builds skip it.
  if ("caches" in globalThis && !isBundled()) {
    try {
      const cache = await caches.open("magpie-share");
      const isPickup = new URLSearchParams(location.search).has("share-target");
      for (const req of await cache.keys()) {
        if (isPickup) {
          const res = await cache.match(req);
          if (res) {
            pendingShared.push({
              bytes: new Uint8Array(await res.arrayBuffer()),
              mime: res.headers.get("content-type") || "application/octet-stream",
            });
          }
        }
        await cache.delete(req);
      }
      if (isPickup) history.replaceState(null, "", location.pathname);
    } catch (err) {
      __magpieErrors.push(`share-target: ${err}`);
    }
  }

  show((await vault.isSetUp()) ? "lock" : "setup");
}

boot();
