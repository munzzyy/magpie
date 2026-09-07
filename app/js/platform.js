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

async function postToIOS(bridge, blob, name) {
  bridge.postMessage({
    name,
    mime: blob.type || "application/octet-stream",
    b64: toBase64(new Uint8Array(await blob.arrayBuffer())),
  });
}

export async function shareOut(blob, name) {
  if (native()) {
    native().shareFile(toBase64(new Uint8Array(await blob.arrayBuffer())), blob.type, name);
    return true;
  }
  const bridge = iosSaveBridge();
  if (bridge) {
    await postToIOS(bridge, blob, name);
    return true;
  }
  if (isIOSWrapped()) return false;
  if (navigator.canShare) {
    const file = new File([blob], name, { type: blob.type });
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

export async function saveOut(blob, name) {
  if (native()) {
    native().saveFile(toBase64(new Uint8Array(await blob.arrayBuffer())), blob.type, name);
    return "native";
  }
  const bridge = iosSaveBridge();
  if (bridge) {
    await postToIOS(bridge, blob, name);
    return "ios-share";
  }
  if (isIOSWrapped()) throw new ExportUnavailableError();
  const url = URL.createObjectURL(blob);
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
