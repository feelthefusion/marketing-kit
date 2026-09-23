---
name: mobile-growth
description: "Use when the work touches MOBILE — the mobile website or the native app: mobile-first pages/CRO, mobile checkout, Core Web Vitals on phones, PWA install + Web Push, Instagram/TikTok in-app browsers, universal links / app links, creator links that survive an app install, install attribution (Play install referrer, Apple Ads, AdAttributionKit), push notifications, in-app messages/inbox, WhatsApp, app review prompts, web→app handoff, QR codes."
---

# Mobile Growth: mobile web and native app, one brain

Most traffic, and nearly all creator traffic, is a phone. This skill makes mobile the default in
every other skill, not a side project. Two lanes share one data model:

| Lane | What ships | Where it lives |
|---|---|---|
| **Mobile web** (every site) | Device context on every event: `device`, `os`, `inapp`, `standalone`, `vw`. Real-user Core Web Vitals. PWA + Web Push. Mobile-first page rules. Smart app banner. Tap-to-text/WhatsApp. | `journey-analytics/references/first-party-tracking.ts` (collector + vitals), `references/app-client.md` §7 |
| **Native app** (Expo apps) | install_id = event anon_id. Universal/app links. Install claim that keeps the creator's credit. Expo Push. In-app inbox. Review moments. Apple Ads + AdAttributionKit copies. | `references/app-server.ts` (routes), `references/app-client.md` §1–6 |
| **Both** | Reports split by device/app/in-app browser. Push, WhatsApp and in-app are outbox channels next to email and SMS. | `references/mobile.sql`, `lifecycle-engine/references/outbox-worker.ts` |

## Ownership (who does what, so nothing competes)

- **This skill owns** mobile plumbing on your own stack: the device and install tables, association
  files, install claims, push registration, the in-app inbox, review moments, mobile reports and mobile page rules.
- **Strategy comes from upstream skills.** This skill applies their output to your stack; it doesn't re-derive it.
  - `aso`: store listing strategy and keywords.
  - `asc-*`: App Store Connect execution through Apple's API.
  - `custom-product-pages`, `in-app-events`, `app-store-featured`, `ab-test-store-listing`: App Store surfaces.
  - `apple-search-ads` + `asc-apple-ads`: Apple Ads.
  - `ua-campaign`: paid app installs.
  - `rating-prompt-strategy` + `review-management`: ratings.
  - `paywall-optimization`: StoreKit and app paywalls. `paywalls` stays web-only.
  - `subscription-lifecycle`: app subscription states.
  - `web-to-app-funnel`: web to app. `onboarding`: activation.
  - `cro` / `signup` / `popups`: page and form strategy. This skill adds the mobile rules in `app-client.md` §7.
- **Sending** is always `lifecycle-engine`: one outbox for email, SMS, WhatsApp, push and in-app.
- **Creator credit** is always `partner-program`: `claimInstall()` writes the same `partner.clicked` event
  and `code|ms` value a web click does, so `attributeOrder()` needs no mobile branch.
- **Scores/arms** are always `growth-optimizer`. Push vs SMS vs WhatsApp is a bandit arm like any other variant.

## Build order (each step is useful on its own)

1. **Device context everywhere (web, today).** Deploy the collector update in `first-party-tracking.ts`
   (device/os/inapp from the UA plus `ctx` from the client) and add `web-vitals` (section D). Run
   `mobile.sql` §1–5. Every other skill's reports can now split mobile vs desktop.
2. **Mobile page rules** (`app-client.md` §7) on landing pages, checkout and forms. Take the mobile p75
   LCP/INP/CLS from `mobile.sql` §3–4 before and after.
3. **Links that open the app.**
   - Serve `appleAppSiteAssociation()` and `assetLinks()` at `/.well-known/…`.
   - Add `associatedDomains` and `intentFilters` in the Expo config (`app-client.md` §1).
   - `/r/<code>` now opens the app when it's installed and the mobile page when it isn't.
4. **Install claim.** Call `claimOnFirstOpen()` on first launch and `stitchInstall()` at login. Checkout sends
   `x-mk-ref`, and the server falls back to `refForCheckout()` → `attributeOrder({ refCookie })`.
   - **Android:** the Play install referrer carries `mk_ref` and `mk_click` exactly (`storeLinks()` builds the URL).
   - **iOS:** has no install referrer. Two options:
     - Smart-banner `app-argument` or a universal link after install opens the app on the ref'd URL.
     - Optionally, the clipboard `mkref:` handoff.
   - A typed creator code still beats a link, on both platforms.
5. **Push.**
   - Ask after a value moment, behind a primer screen, then `registerDevice()`.
   - The outbox sends Expo Push (native) or Web Push (PWA/browser).
   - Receipts arrive about 15 minutes later. `DeviceNotRegistered` or a 404/410 revokes the token.
6. **In-app inbox** (`inbox()`, `engaged()`): lifecycle messages with `channel: "in_app"` show up
   in the app with no provider involved. Push and in-app opens/clicks become `crm_events`.
7. **Review moments.** Call `reviewMoment()` right after a PEAK event (order delivered, tier up, NPS promoter);
   if it says yes, the app calls `StoreReview.requestReview()`. The limit is Apple's own: 3 prompts in 365 days.
8. **Paid app installs (optional, later).**
   - Apple Ads: `appleAdsAttribution()` with the AdServices token, via the local Expo module in `app-client.md` §6.
   - AdAttributionKit / SKAdNetwork: the winning-postback copies land at `attributionCopy()`.
   - Campaigns themselves: `meta-ads` (app events through CAPI) and `apple-search-ads`/`asc-apple-ads`.

## Channels on mobile (all through the same outbox)

| Channel | When it wins | Provider facts (from the provider, nothing added) |
|---|---|---|
| push (Expo) | Installed app, opted in: fastest and free | ≤100 per request, 4096-byte payload, receipts after ~15 min, `DeviceNotRegistered` = stop |
| push (Web Push) | PWA or browser on Android/desktop; iPhone only when added to the Home Screen (iOS 16.4+) | 404/410 = subscription gone, 413 = too big, 429 = retry-after |
| in_app | Any signed-in app user; no permission needed | none (your own table) |
| sms (Telnyx) | No app / no push; highest reach | `provider-limits.json` → telnyx |
| whatsapp (Telnyx) | Markets where WhatsApp is the default inbox | Free-form only inside the 24h customer-service window, otherwise an approved template (`payload.template`); 40008 = template unusable |
| email (Resend) | Receipts, long form, no phone | `provider-limits.json` → resend |

Enqueue with `enqueueStep({ channel: "push", payload: (row) => ({ url: "https://acme.com/a/orders/123" }) … })`.
Push fans out to every device where the contact granted permission. Deep links use `/a/*` paths, so
the same URL opens the app when it's installed and the web page when it isn't.

## Setup (all optional, all later: skills are installed, nothing is required to start)

| App env (Railway variables on the app, not kit secrets) | Enables |
|---|---|
| `MKT_IOS_APP_IDS`, `MKT_IOS_APP_STORE_ID`, `MKT_ANDROID_PACKAGE`, `MKT_ANDROID_SHA256` | association files, store links, smart banner |
| `EXPO_ACCESS_TOKEN` | only if Expo "enhanced push security" is on |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (`npx web-push generate-vapid-keys` once) |
| `WHATSAPP_MPS` | pacing per WhatsApp number (default 80/s) |
| `MKT_REVIEW_PEAK_EVENTS` | which events count as review moments |

The worker needs **Node ≥ 22.12** once push is on (`expo-server-sdk` 7 requires it; Railway's Node 22 image is fine).

Schema: `crm_devices`, `crm_app_installs`, `crm_messages.payload` and the `push`/`whatsapp`/`in_app`
channels are in `growth-data/references/crm-schema.ts`. Migrate through the app's normal drizzle-kit flow.

## Works with →
`journey-analytics` (collector + vitals) · `lifecycle-engine` (sends every channel) · `partner-program`
(creator credit through installs) · `loyalty-engine` (peak moments, wallet-style perks) · `growth-optimizer`
(channel arms) · `meta-ads` (app events) · upstream `aso`, `asc-*`, `apple-search-ads`, `web-to-app-funnel`.
