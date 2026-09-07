// The seam between the page and the Android wrapper. Same contract as the
// sibling apps: bytes out through the bridge, shared-in content streamed
// over one-shot asset-origin tokens, and no network anywhere because the
// APK has no permission to open one.

const native = () => globalThis.MagpieNative;

export const isWrapper = () => !!native();

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

export async function shareOut(blob, name) {
  if (native()) {
    native().shareFile(toBase64(new Uint8Array(await blob.arrayBuffer())), blob.type, name);
    return true;
  }
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
