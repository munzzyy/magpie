// The seam between the page and the wrappers. Same contract as the sibling
// apps: bytes out through a bridge, shared-in content streamed over
// one-shot asset-origin tokens, and no network anywhere because neither
// wrapper has a permission or a networking code path to open one.

import { isWrapper, isIOSWrapped, iosSaveBridge } from "./env.js";

const native = () => globalThis.MagpieNative;

export { isWrapper };

export const wrapperVersion = () => {
  try {
    return native()?.version() || "";
  } catch {
    return "";
  }
};

function toBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Thrown when the page is running on the magpie: scheme (a real iOS
// wrapper build) but the "save" message handler is missing: a stale build
// that shipped without the bridge, or one built from a tree where it broke.
// Callers must surface this as a loud failure. It is never a silent no-op
// and never a fake success toast.
export class ExportUnavailableError extends Error {
  constructor() {
    super("export cannot leave the app in this build");
  }
}

// Android takes an export in slices: 768 KiB of bytes is exactly 1 MiB of
// base64, the most MagpieBridge.appendOut accepts in one call.
export const OUT_CHUNK_BYTES = 768 * 1024;

export class HandOffError extends Error {
  constructor(why) {
    super(`the export did not reach the system: ${why}`);
  }
}

const outWaiting = new Map();
globalThis.__magpieOutDone = (id, status) => {
  const resolve = outWaiting.get(String(id));
  outWaiting.delete(String(id));
  if (resolve) resolve(String(status));
};

// An export is a Blob or bytes. Android slices bytes in place: WebView caps Blob storage, and a second export-sized Blob came back unreadable.
const sizeOf = (data) => (data instanceof Blob ? data.size : data.length);
const asBlob = (data, type) => (data instanceof Blob ? data : new Blob([data], { type }));
const bytesOf = async (data, at = 0, end = sizeOf(data)) =>
  data instanceof Blob ? new Uint8Array(await data.slice(at, end).arrayBuffer()) : data.subarray(at, end);

// Resolves "ok" or "cancelled" once the wrapper says the file landed or the
// user backed out of the picker; anything else rejects.
async function handOff(data, name, type, mode) {
  const bridge = native();
  const id = bridge.beginOut(name, type, mode);
  if (!id) throw new HandOffError("refused");
  try {
    for (let at = 0; at < sizeOf(data); at += OUT_CHUNK_BYTES) {
      if (!bridge.appendOut(id, toBase64(await bytesOf(data, at, at + OUT_CHUNK_BYTES)))) throw new HandOffError("write failed");
    }
  } catch (err) {
    try {
      bridge.abortOut(id);
    } catch {}
    throw err;
  }
  const status = await new Promise((resolve) => {
    outWaiting.set(id, resolve);
    bridge.finishOut(id);
  });
  if (status !== "ok" && status !== "cancelled") throw new HandOffError(status);
  return status;
}

async function postToIOS(bridge, data, name, type) {
  bridge.postMessage({ name, mime: type, b64: toBase64(await bytesOf(data)) });
}

export async function shareOut(data, name, type = data.type || "application/octet-stream") {
  if (native()) {
    await handOff(data, name, type, "share");
    return true;
  }
  const bridge = iosSaveBridge();
  if (bridge) {
    await postToIOS(bridge, data, name, type);
    return true;
  }
  if (isIOSWrapped()) return false;
  if (navigator.canShare) {
    const file = new File([data], name, { type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (err) {
        if (err?.name === "AbortError") return true;
      }
    }
  }
  return false;
}

// "native" and "ios-share" mean the file was handed off, "cancelled" that the
// user backed out of Android 9's save picker, "download" a browser download.
export async function saveOut(data, name, type = data.type || "application/octet-stream") {
  if (native()) {
    return (await handOff(data, name, type, "save")) === "ok" ? "native" : "cancelled";
  }
  const bridge = iosSaveBridge();
  if (bridge) {
    await postToIOS(bridge, data, name, type);
    return "ios-share";
  }
  if (isIOSWrapped()) throw new ExportUnavailableError();
  const url = URL.createObjectURL(asBlob(data, type));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "download";
}

// The system camera app takes the picture (no camera permission needed);
// the result comes back as a one-shot token on __magpieCaptured.
export function canCapture() {
  try {
    return !!native()?.canCapture();
  } catch {
    return false;
  }
}

export function capturePhoto() {
  native()?.capturePhoto();
}

export function onCaptured(cb) {
  globalThis.__magpieCaptured = (token) => cb(String(token || ""));
}

export function sharedTokens() {
  try {
    const native_ = native();
    if (!native_) return [];
    const parsed = JSON.parse(native_.sharedTokens() || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}

export function onShared(cb) {
  globalThis.__magpieShared = (payload) => {
    const tokens = Array.isArray(payload) ? payload : payload ? [String(payload)] : [];
    cb(tokens.filter((x) => typeof x === "string" && x));
  };
}
