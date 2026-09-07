// Host environment: which wrapper, if any, the page is running inside.
// Android injects globalThis.MagpieNative before the page ever runs. The
// iOS wrapper injects no bridge object of its own; the only signal it gives
// the page is the magpie: scheme the app is served on, plus (once the
// export bridge below is wired) a "save" message handler.
//
// UI behavior (marketing landing, browser-install hints, "Download the
// APK") reads isBundled(): true for the Android bridge OR the iOS scheme,
// because both mean "this is the app, not a browser tab". Capabilities stay
// per feature: isWrapper() alone still gates the things only Android can
// do (camera capture, share-in tokens), and iosSaveBridge() alone gates
// the export hand-off.

export const isWrapper = () => !!globalThis.MagpieNative;

export const isIOSWrapped = () => globalThis.location?.protocol === "magpie:";

export const isBundled = () => isWrapper() || isIOSWrapped();

// The iOS export bridge: a WKScriptMessageHandler named "save", registered
// only once ios/Sources/ViewController.swift wires it up. Gated on BOTH the
// message handler AND the scheme, so a page loaded some other way (a stray
// http mirror, a devtools tab pointed at the wrong origin) cannot pose as
// the wrapper just because something happens to be named window.webkit.
export const iosSaveBridge = () =>
  isIOSWrapped() ? (globalThis.webkit?.messageHandlers?.save ?? null) : null;
