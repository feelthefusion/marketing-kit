# Mobile client reference — Expo app + mobile web / PWA

Server side: `app-server.ts`. Every snippet below posts to routes on the app's own domain; nothing
goes to a third party. Replace `acme.com`, `com.acme.app` and `TEAMID`.

## 1. Expo app config (`app.json` / `app.config.ts`)

```jsonc
{
  "expo": {
    "scheme": "acme",
    "ios": {
      "bundleIdentifier": "com.acme.app",
      "associatedDomains": ["applinks:acme.com", "webcredentials:acme.com"],
      "infoPlist": {
        "AttributionCopyEndpoint": "https://acme.com",               // AdAttributionKit postback copies
        "NSAdvertisingAttributionReportEndpoint": "https://acme.com" // SKAdNetwork postback copies
      }
    },
    "android": {
      "package": "com.acme.app",
      "intentFilters": [{
        "action": "VIEW", "autoVerify": true, "category": ["BROWSABLE", "DEFAULT"],
        "data": [{ "scheme": "https", "host": "acme.com", "pathPrefix": "/r" },
                 { "scheme": "https", "host": "acme.com", "pathPrefix": "/a" }]
      }]
    },
    "plugins": ["expo-router", "expo-notifications", "expo-secure-store"]
  }
}
```

Packages (all Expo SDK): `npx expo install expo-notifications expo-application expo-store-review expo-secure-store expo-crypto expo-clipboard expo-linking expo-device`.
Universal links / app links need a dev or production build (not Expo Go). Verify with
`https://acme.com/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
serving 200 + `application/json`, no redirect.

## 2. Install id + events (same collector as the website)

```ts
// lib/mk.ts
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as Application from "expo-application";
import { Platform } from "react-native";

const API = "https://acme.com";
let installId: string | null = null, sessionId = Crypto.randomUUID(), lastAt = Date.now();

export async function getInstallId() {
  installId ??= (await SecureStore.getItemAsync("mk_install_id")) ?? null;
  if (!installId) { installId = Crypto.randomUUID(); await SecureStore.setItemAsync("mk_install_id", installId); }
  return installId;
}
export async function track(name: string, properties: Record<string, unknown> = {}, screen = "/") {
  if (Date.now() - lastAt > 30 * 60_000) sessionId = Crypto.randomUUID();       // 30-min idle = new session
  lastAt = Date.now();
  await fetch(`${API}/api/t`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    name, properties, client: "app", anon_id: await getInstallId(), session_id: sessionId,
    path: screen, referrer: null, occurred_at: new Date().toISOString(),
    ctx: { platform: Platform.OS, app_version: Application.nativeApplicationVersion },
  }) }).catch(() => {});
}
```

At login call your server's login route, which runs `stitchInstall(db, contactId, installId)`, the
app equivalent of `stitchAnon()`.

## 3. First open: keep the creator's credit through the install

```ts
// app/_layout.tsx (once, on first launch)
import * as Linking from "expo-linking";
import * as Clipboard from "expo-clipboard";

export async function claimOnFirstOpen() {
  if (await SecureStore.getItemAsync("mk_claimed")) return;
  const body: Record<string, unknown> = { install_id: await getInstallId(), platform: Platform.OS };
  body.url = (await Linking.getInitialURL()) ?? undefined;                 // app opened by https://acme.com/r/maya
  if (Platform.OS === "android") body.referrer = await Application.getInstallReferrerAsync().catch(() => undefined);
  // iOS only, optional: read the "mkref:…" the landing page copied. iOS shows a paste prompt.
  if (Platform.OS === "ios" && (await Clipboard.hasStringAsync())) {
    const clip = await Clipboard.getStringAsync();
    if (clip.startsWith("mkref:")) body.clipboard = clip;
  }
  const r = await fetch(`${API}/api/app/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((x) => x.json()).catch(() => null);
  if (r?.ref) await SecureStore.setItemAsync("mk_ref", r.ref);             // send as x-mk-ref at checkout
  await SecureStore.setItemAsync("mk_claimed", "1");
}
```

Links opened later, while the app is running: the expo-router route `app/r/[code].tsx` posts the same
claim with `url`, then `router.replace("/")`. Checkout requests send
`x-mk-ref: await SecureStore.getItemAsync("mk_ref")`. The server passes it to
`attributeOrder({ refCookie })`, with `refForCheckout()` as the fallback.

## 4. Push: permission after value, token to your server, taps deep-link

```ts
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { router } from "expo-router";

// Ask AFTER a value moment (first order, first saved item), behind your own one-screen primer:
// iOS gives one system prompt; a "no" is permanent until Settings.
export async function enablePush() {
  const { status } = await Notifications.requestPermissionsAsync();
  const token = status === "granted"
    ? (await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig?.extra?.eas?.projectId })).data : undefined;
  await fetch(`${API}/api/app/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    install_id: await getInstallId(), platform: Platform.OS,
    push: { kind: "expo", token, status: status === "granted" ? "granted" : "denied" },
    app_version: Application.nativeApplicationVersion, locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }) });
}
Notifications.addNotificationResponseReceivedListener((resp) => {
  const d = resp.notification.request.content.data as { url?: string; message_id?: string };
  if (d.message_id) fetch(`${API}/api/app/engaged`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: d.message_id, action: "clicked" }) });
  if (d.url) router.push(d.url.replace("https://acme.com", "") as any);
});
```

Call `/api/app/devices` on every launch too (without `push`). That refreshes `last_seen_at` and the app version.

## 5. Review prompt at peak moments

```ts
import * as StoreReview from "expo-store-review";
export async function maybeAskForReview() {                    // call right after a PEAK event
  const ok = await fetch(`${API}/api/app/review-moment`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ install_id: await getInstallId(), app_version: Application.nativeApplicationVersion }) }).then((r) => r.json());
  if (ok?.ask && (await StoreReview.isAvailableAsync())) {
    await StoreReview.requestReview();
    await track("app.review_prompted", { app_version: Application.nativeApplicationVersion });
  }
}
```

## 6. Apple Ads attribution token (optional, iOS)

AdServices has no Expo package, so this uses a 10-line local Expo module (`npx create-expo-module --local adservices`):

```swift
import AdServices
import ExpoModulesCore
public class AdservicesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Adservices")
    AsyncFunction("token") { () -> String? in try? AAAttribution.attributionToken() }
  }
}
```
Post the token once to your route that calls `appleAdsAttribution(db, installId, token)`.

## 7. Mobile web + PWA (every site, not just apps)

**Manifest** (`/manifest.webmanifest`, linked from `<head>`): `name`, `short_name`, `start_url: "/?src=pwa"`,
`display: "standalone"`, `theme_color`, icons 192/512 plus a maskable icon. Also add `<meta name="apple-mobile-web-app-capable" content="yes">`.

**Web Push** (Chrome/Edge/Firefox on Android and desktop; iPhone/iPad only when the site is
added to the Home Screen, iOS/iPadOS 16.4+):

```ts
// client: after a value moment, from a user gesture
const reg = await navigator.serviceWorker.register("/sw.js");
const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY });
const j = sub.toJSON();
await fetch("/api/app/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  install_id: localStorage.getItem("mk_aid"), platform: "web",
  push: { kind: "webpush", token: j.endpoint, keys: j.keys, status: "granted" } }) });
```
```js
// public/sw.js
self.addEventListener("push", (e) => {
  const m = e.data.json();
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, data: m }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || "/"));
});
```
Generate VAPID keys once with `npx web-push generate-vapid-keys` and set them as the app's Railway variables `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT=mailto:…` (the public key also goes to the browser as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`).
On iOS Safari when not standalone (`navigator.standalone === false`), show a one-line "Add to Home Screen to get alerts" coach instead of a subscribe button.

**Mobile-first page rules** (ship these on every landing page, checkout and form):
- One primary CTA per screen, in a sticky bottom bar in the thumb zone. Tap targets at least 44×44 pt (Apple HIG) or 48×48 dp (Material).
- Inputs at least 16px (iOS zooms on smaller fonts). Use `type="tel" autocomplete="tel"`, `inputmode="numeric"`, `autocomplete="one-time-code"` for SMS codes, and `autocomplete="email"`, `name`, `postal-code` and `cc-*`.
- Wallet pay first on mobile: Apple Pay / Google Pay through the processor the app already uses (Payment Request API). Guest checkout. Address autocomplete.
- Tap-to-text and tap-to-chat CTAs: `sms:+1XXXXXXXXXX?&body=JOIN` (Telnyx number) and `https://wa.me/1XXXXXXXXXX?text=Hi`.
- Pop-ups on mobile: bottom sheets or inline, never full-screen on entry. Google demotes intrusive interstitials on mobile pages.
- Instagram/TikTok in-app browsers (`inapp` in every event): wallet pay can be missing there. Show an "Open in browser" hint on checkout when `inapp` is set and mobile.sql §2 shows the gap.
- Performance budget: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75 on mobile (mobile.sql §3–4). Use `next/image` or responsive `srcset`, and avoid layout shift from late banners.
- Smart app banner (`storeLinks().smartBanner`) on pages where the app is the better experience. Creator links (`/r/<code>`) open the app when it's installed and fall back to the mobile page otherwise.
- QR codes for creators, packaging and print: `partnerQr()` (partner-program) serves `/r/<code>/qr` as SVG or `?format=png`. It encodes the same `/r/<code>` link tagged `utm_source=qr`, so it works on the web, in the app and through both stores, and scans report separately from taps.
