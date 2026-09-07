# Magpie on iOS

The `ios/` directory is a native wrapper around the exact same `app/` the
website and the Android APK ship: a WKWebView serving the bundle on the fixed
origin `magpie://localhost`, with no networking code of its own.

## Build it

You need a Mac with Xcode 15 or newer. The Xcode project is generated, not
checked in:

```
brew install xcodegen
cd ios
xcodegen generate
open Magpie.xcodeproj
```

Before you press run: in Xcode's Signing & Capabilities tab, sign in with
your Apple ID under Accounts, then pick your personal team for the Magpie
target. If the bundle id `io.github.munzzyy.magpie` is already claimed by
someone else's team, change it to anything unique, since a free account
cannot reuse another team's id. Pick your device and press run. The first
launch fails with an untrusted-developer error; go to Settings > General >
VPN & Device Management on the phone and trust the certificate, then launch
again. With a free Apple ID, Xcode signs a personal build that runs on your
own device for 7 days at a time (after that, re-run from Xcode; your journal
is untouched, only the signature needs refreshing). App Store or TestFlight
distribution needs a paid developer account, and Magpie is not published
there today.

CI builds the wrapper for the iOS simulator on every push and fails if a
permission prompt or an App Transport Security exception ever appears in the
built Info.plist. What CI cannot do is run it on physical hardware: it never
launches the app, so `crypto.subtle` on `magpie://localhost`, IndexedDB
persistence, the export bridge, VoiceOver reaching every control, and
Dynamic Type actually resizing the page are all verified by a person on a
real device, not by the pipeline. Do that pass after any change that
touches `ios/Sources` or the parts of `app/` it depends on.

## What is different from Android, honestly

- **The network guarantee is weaker.** The Android manifest ships with no
  INTERNET permission at all, so the OS itself refuses every connection
  Magpie could ever try to make. iOS has no such permission. What holds the
  line here is the Content-Security-Policy the page itself carries (nothing
  but `'self'` is loadable) plus a wrapper that contains no networking code
  of its own. That is "no code paths plus CSP", not an OS-level guarantee:
  the CSP governs the page's own fetches and does not reach WebRTC, and
  Magpie ships no WebRTC code either, which is what actually closes that
  gap. Same practical behavior as Android, enforced one layer higher up.
- **No native camera shortcut, and no share-sheet intake.** Android's
  MagpieBridge lets the journal call straight into the system camera app and
  receive files shared in from other apps over one-shot tokens. The iOS
  wrapper injects no such bridge, so the page's own feature detection
  (`platform.js`) sees no `MagpieNative` and falls back to what a plain
  browser gets: the camera button hides, and evidence comes in only through
  the standard file picker, which still offers the system camera as one of
  its options. There is no way to hand a photo or file to Magpie from
  another app's share sheet on iOS, in the wrapper or the installed web app:
  Safari does not support Web Share Target for installed web apps the way
  Android's intent system does. Open Magpie first and attach from there.
- **Export goes through a small native bridge, not a bare download link.**
  Android's `shareFile`/`saveFile` hand bytes to `MagpieBridge`, which opens
  the system share sheet or writes to Downloads directly. WKWebView cannot
  turn a `blob:` download link into a file on its own, so the iOS wrapper
  registers a `WKScriptMessageHandler` named `save`: the page posts the
  export's bytes, name, and MIME type to it, and the native side writes a
  temp file and opens `UIActivityViewController`, the same sheet that offers
  Mail, Files, AirDrop, and anything else installed. `platform.js` only
  trusts that bridge when both the message handler exists AND the page is
  running on the `magpie:` scheme, so a page loaded some other way cannot
  fake it. If a build ever ships without the bridge, export fails loudly
  with a plain error, never a silent no-op or a false "Downloaded" toast.
  Verified by hand on a device: the share sheet opens with the zip attached
  and "Save to Files" succeeds.
- **App-switcher privacy works differently.** Android sets FLAG_SECURE on the
  window because the screen holds an evidence journal; the iOS wrapper
  covers the window with a blur shield the moment the app leaves the
  foreground, so the switcher thumbnails the shield, not the journal.
  FLAG_SECURE also blocks screenshots and screen recording outright; iOS has
  no equivalent API, and the shield does nothing against either. Screenshots
  of an unlocked journal remain possible on iOS the same way they are on any
  other app.
- **Backups work differently.** Android disables backups entirely
  (`allowBackup="false"`), so there is never a second copy of the vault
  sitting in a device or cloud backup. iOS backs up an app's container by
  default; the wrapper opts the WebKit storage directory (where the vault's
  IndexedDB lives) out of both iCloud and local backups at launch, which
  gets to the same place Android's manifest flag does, just via a directory
  attribute instead of a manifest switch.
- **Text size tracks the system live.** Both wrappers scale the page by the
  OS text-size setting on launch. The iOS wrapper also re-applies it
  whenever Dynamic Type changes while the app is running (`ViewController`
  observes `UIContentSizeCategory.didChangeNotification`), so a size change
  made mid-session takes effect without relaunching. What Dynamic Type and
  the page's own responsive CSS have NOT been verified against is VoiceOver
  reaching every control on a physical device; that is a manual check, not
  an automated one, until an on-device UI test exists.

## The no-install alternative

Safari on iOS can install the web app directly from wherever it is hosted:
open the site, tap Share, then "Add to Home Screen". That copy runs offline
after the first load (over https only) and gets updates from the site when
you are online. As of this writing Magpie has no hosted copy of `app/`, so
this path is not usable yet; the wrapper above is the only way to run Magpie
on an iPhone today. Once a hosted copy exists: the installed icon and a
Safari tab pointed at the same URL get separate storage containers, so a
journal started in one will not appear in the other, and deleting the
Home Screen icon deletes that copy's journal the same way uninstalling the
Android app does. Web Share Target intake does not work for installed web
apps in Safari either, so the "open Magpie first and attach from there"
limit above applies on the PWA path too, not just the native wrapper.

## One rule for maintainers

`magpie://localhost` is the storage origin. Renaming the scheme or the host
orphans every user's saved journal with no migration path. Never change it.
