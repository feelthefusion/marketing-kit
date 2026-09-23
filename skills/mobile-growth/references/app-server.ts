// =============================================================================
// Marketing Kit — mobile server routes (mobile-growth). Web-standard Request/Response + Drizzle.
// marketing-kit:mobile   ← keep this marker; mkt-doctor looks for it.
//
// Works in Next route handlers as-is; in Express/Vite servers wrap with a Request adapter (or call
// the plain functions — every one takes db + plain values).
//
//   A. /.well-known/apple-app-site-association + /.well-known/assetlinks.json
//        → universal links / app links: a creator's /r/<code> opens the APP when installed
//   B. storeLinks()   web → store handoff that carries the creator code THROUGH the install
//        (Android: Play install referrer = exact · iOS: smart app banner app-argument + claim)
//   C. POST /api/app/devices   registerDevice(): install_id, platform, push token (Expo / Web Push)
//   D. POST /api/app/claim     claimInstall(): first open → which link/code/referrer brought it
//   E. refForCheckout()        the same "code|ms" value the web mk_ref cookie holds → attributeOrder()
//   F. appleAdsAttribution()   AdServices token → Apple Ads campaign/ad group/keyword (24h token)
//   G. POST /.well-known/appattribution/report-attribution/  (AdAttributionKit copies)
//      POST /.well-known/skadnetwork/report-attribution/     (SKAdNetwork copies)
//   H. inbox() / engaged()     in-app inbox + push/in-app open + click facts
//   I. reviewMoment()          spend Apple's 3-per-365-days review prompts on peak moments only
// =============================================================================
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const CODE = /^[a-z0-9_-]{2,40}$/i;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ---- A. association files (serve at the exact paths, no redirects, application/json) --------
// MKT_IOS_APP_IDS=TEAMID.com.acme.app[,…] · MKT_ANDROID_PACKAGE=com.acme.app
// MKT_ANDROID_SHA256=AB:CD:… (Play Console → App integrity → app signing key; add the upload key too)
// App side: Expo app.json → ios.associatedDomains ["applinks:acme.com"] + android.intentFilters
// (autoVerify, https, acme.com, pathPrefix /r and /a) — app-client.md has the exact block.
export function appleAppSiteAssociation(): Response {
  const appIDs = list(process.env.MKT_IOS_APP_IDS);
  return json({
    applinks: { details: [{ appIDs, components: [
      { "/": "/r/*", comment: "creator + partner short links open the app when it is installed" },
      { "/": "/a/*", comment: "app deep links used by push, email, SMS and WhatsApp" },
      ...list(process.env.MKT_APP_LINK_PATHS).map((p) => ({ "/": p })),
    ] }] },
    webcredentials: { apps: appIDs },                     // shared passwords between site and app
  }, 200, { "cache-control": "public, max-age=3600" });
}
export function assetLinks(): Response {
  const pkg = process.env.MKT_ANDROID_PACKAGE;
  return json(pkg ? [{ relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: list(process.env.MKT_ANDROID_SHA256) } }] : [],
    200, { "cache-control": "public, max-age=3600" });
}

// ---- B. web → store handoff ---------------------------------------------------------------
// Render on mobile landing pages (the page captureRef() ran on). webAnonId = the visitor's mk_aid,
// so the app's first open stitches the whole web journey (creator video → landing → store → app).
// ppid = an App Store custom product page per creator/campaign (Apple lets you run up to 70).
export function storeLinks(o: { code?: string | null; webAnonId?: string | null; utm?: Record<string, string>; ppid?: string; appArgument?: string }) {
  const q = new URLSearchParams();
  if (o.code) q.set("mk_ref", o.code.toLowerCase());
  if (o.webAnonId) q.set("mk_click", o.webAnonId);
  for (const [k, v] of Object.entries(o.utm ?? {})) q.set(k, v);
  const pkg = process.env.MKT_ANDROID_PACKAGE, appId = process.env.MKT_IOS_APP_STORE_ID;   // numeric App Store id
  const android = pkg ? `https://play.google.com/store/apps/details?id=${pkg}${q.toString() ? `&referrer=${encodeURIComponent(q.toString())}` : ""}` : null;
  const ios = appId ? `https://apps.apple.com/app/id${appId}${o.ppid ? `?ppid=${o.ppid}` : ""}` : null;
  // Safari smart app banner: installed → "Open" hands app-argument (this URL, ref intact) to the app.
  const smartBanner = appId ? `<meta name="apple-itunes-app" content="app-id=${appId}${o.appArgument ? `, app-argument=${o.appArgument}` : ""}">` : null;
  // iOS has no install referrer: the landing page's store button also copies this to the clipboard
  // (a user gesture), and the app's first open may read it (iOS asks permission to paste).
  const clipboard = o.code ? `mkref:${o.code.toLowerCase()}:${o.webAnonId ?? ""}` : null;
  return { ios, android, smartBanner, clipboard };
}

// ---- C. device registration (app launch, permission change, token refresh, web push subscribe)
// contactId comes from the app's OWN session on the server — never from the request body.
export type DeviceIn = {
  install_id: string; platform: "ios" | "android" | "web";
  push?: { kind: "expo" | "webpush"; token?: string; keys?: { p256dh: string; auth: string }; status?: "granted" | "denied" | "unknown" };
  app_version?: string; os_version?: string; locale?: string; timezone?: string;
};
export async function registerDevice(db: Db, contactId: string | null, b: DeviceIn) {
  const installId = str(b?.install_id, 64);
  const platform = ["ios", "android", "web"].includes(b?.platform) ? b.platform : null;
  if (!installId || !platform) return { ok: false as const, error: "install_id + platform required" };
  const kind = b.push?.kind === "expo" || b.push?.kind === "webpush" ? b.push.kind : null;
  const token = kind ? str(b.push?.token, 2000) : null;
  const keys = kind === "webpush" && b.push?.keys?.p256dh && b.push?.keys?.auth ? { p256dh: b.push.keys.p256dh, auth: b.push.keys.auth } : null;
  const status = b.push?.status === "denied" ? "denied" : token ? "granted" : "unknown";
  // Reinstalls / device restores move a token to a new install: the newest install owns it.
  if (token) await db.execute(sql`update crm_devices set push_token = null, push_status = 'revoked'
    where push_token = ${token} and install_id <> ${installId}`);
  const { rows } = await db.execute<{ id: string }>(sql`
    insert into crm_devices (contact_id, install_id, platform, push_kind, push_token, push_keys, push_status,
                             app_version, os_version, locale, timezone)
    values (${contactId}, ${installId}, ${platform}, ${kind}, ${token}, ${keys ? JSON.stringify(keys) : null}::jsonb, ${status},
            ${str(b.app_version, 40)}, ${str(b.os_version, 40)}, ${str(b.locale, 35)}, ${str(b.timezone, 64)})
    on conflict (install_id) do update set
      contact_id  = coalesce(excluded.contact_id, crm_devices.contact_id),
      push_kind   = coalesce(excluded.push_kind, crm_devices.push_kind),
      push_token  = case when excluded.push_status = 'denied' then null else coalesce(excluded.push_token, crm_devices.push_token) end,
      push_keys   = coalesce(excluded.push_keys, crm_devices.push_keys),
      push_status = case when excluded.push_status = 'unknown' then crm_devices.push_status else excluded.push_status end,
      app_version = coalesce(excluded.app_version, crm_devices.app_version),
      os_version  = coalesce(excluded.os_version, crm_devices.os_version),
      locale      = coalesce(excluded.locale, crm_devices.locale),
      timezone    = coalesce(excluded.timezone, crm_devices.timezone),
      last_seen_at = now()
    returning id`);
  if (contactId) await stitchInstall(db, contactId, installId);
  return { ok: true as const, deviceId: rows[0].id, pushStatus: status };
}

// Login in the app = the web's stitchAnon(): the install's events AND the web visit that led to
// the store (click_id) become the contact's history.
export async function stitchInstall(db: Db, contactId: string, installId: string) {
  await db.execute(sql`update crm_devices set contact_id = ${contactId}::uuid where install_id = ${installId}`);
  await db.execute(sql`update crm_events set contact_id = ${contactId}::uuid
    where contact_id is null and (anon_id = ${installId} or anon_id in (
      select click_id from crm_app_installs where install_id = ${installId} and click_id is not null))`);
}

// ---- D. install claim (call once on first open; safe to repeat) -----------------------------
// Deterministic first: app_link (the /r/<code> URL that opened the app) > install_referrer (Android
// Play) > code (typed at signup/checkout) > clipboard (iOS paste of storeLinks().clipboard).
export type ClaimIn = { install_id: string; platform: "ios" | "android"; url?: string; referrer?: string; code?: string; clipboard?: string };
const RANK: Record<string, number> = { app_link: 1, install_referrer: 2, code: 3, clipboard: 4 };
export async function claimInstall(db: Db, b: ClaimIn) {
  const installId = str(b?.install_id, 64);
  if (!installId) return { ok: false as const, error: "install_id required" };
  const found: { source: string; code: string | null; click: string | null; utm: Record<string, string>; raw: Record<string, unknown> }[] = [];
  if (b.url) try {
    const u = new URL(b.url);
    const m = u.pathname.match(/^\/r\/([^/]+)/);
    const code = m?.[1] ?? u.searchParams.get("ref");
    found.push({ source: "app_link", code, click: u.searchParams.get("mk_click"), utm: utmOf(u.searchParams), raw: { url: b.url } });
  } catch { /* not a URL */ }
  if (b.referrer) {
    const q = new URLSearchParams(b.referrer);
    found.push({ source: "install_referrer", code: q.get("mk_ref"), click: q.get("mk_click"), utm: utmOf(q), raw: { referrer: b.referrer } });
  }
  if (b.code) found.push({ source: "code", code: b.code, click: null, utm: {}, raw: {} });
  const clip = b.clipboard?.match(/^mkref:([a-z0-9_-]{2,40}):([0-9a-f-]{36})?$/i);
  if (clip) found.push({ source: "clipboard", code: clip[1], click: clip[2] ?? null, utm: {}, raw: {} });

  for (const f of found) {
    const code = f.code && CODE.test(f.code) && (await activeCode(db, f.code)) ? f.code.toLowerCase() : null;
    if (!code && !Object.keys(f.utm).length) continue;           // nothing attributable in this source
    await db.execute(sql`insert into crm_app_installs (install_id, source, partner_code, click_id, campaign, raw, dedupe_key)
      values (${installId}, ${f.source}, ${code}, ${f.click}, ${JSON.stringify(f.utm)}::jsonb, ${JSON.stringify(f.raw)}::jsonb, ${`${installId}:${f.source}`})
      on conflict (dedupe_key) do nothing`);
    if (code) await db.execute(sql`insert into crm_events (name, source, anon_id, properties, dedupe_key, occurred_at)
      values ('partner.clicked', 'mobile_app', ${installId}, ${JSON.stringify({ code, via: f.source, platform: b.platform })}::jsonb,
              ${`claim:${installId}:${f.source}`}, now()) on conflict do nothing`);
  }
  return { ok: true as const, ref: await refForCheckout(db, installId) };   // app keeps it in SecureStore
}
const utmOf = (q: URLSearchParams) => Object.fromEntries([...q].filter(([k]) => k.startsWith("utm_")).map(([k, v]) => [k, v.slice(0, 200)]));
async function activeCode(db: Db, code: string) {
  const { rows } = await db.execute(sql`select 1 from crm_partner_codes where code = ${code.toLowerCase()} and active`);
  return rows.length > 0;
}

// ---- E. checkout: the app's equivalent of the web mk_ref cookie ------------------------------
// Pass the result as attributeOrder({ refCookie }) (partner-program) — same "code|ms" format, same
// window rules, and a typed code still beats a link. Prefer the value the app sends (x-mk-ref
// header, kept in SecureStore after claimInstall); this server lookup is the fallback.
export async function refForCheckout(db: Db, installId: string | null, contactId?: string | null): Promise<string | null> {
  const { rows } = await db.execute<{ code: string; ms: string }>(sql`
    select i.partner_code as code, (extract(epoch from i.claimed_at) * 1000)::bigint::text as ms
    from crm_app_installs i
    where i.partner_code is not null and i.source <> 'code'
      and (i.install_id = ${installId} or i.install_id in (select install_id from crm_devices where contact_id = ${contactId ?? null}::uuid))
    order by case i.source when 'app_link' then 1 when 'install_referrer' then 2 else 3 end, i.claimed_at desc
    limit 1`);
  return rows[0] ? `${rows[0].code}|${rows[0].ms}` : null;
}

// ---- F. Apple Ads attribution (AdServices) --------------------------------------------------
// The app gets a token from AAAttribution.attributionToken() (valid 24h) and posts it here once.
// Apple: POST text/plain to api-adservices.apple.com/api/v1/; a 404 means "not ready yet" → retry
// (Apple suggests ~5s apart, up to 3 times). attribution:false = organic / not Apple Ads.
export async function appleAdsAttribution(db: Db, installId: string, token: string) {
  const url = process.env.APPLE_ADSERVICES_URL ?? "https://api-adservices.apple.com/api/v1/";
  const waitMs = Number(process.env.APPLE_ADSERVICES_RETRY_MS ?? 5000);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: token });
    if (res.status === 200) {
      const a: any = await res.json();
      if (!a.attribution) return { ok: true as const, attributed: false };
      const campaign = { orgId: a.orgId, campaignId: a.campaignId, adGroupId: a.adGroupId, keywordId: a.keywordId, adId: a.adId,
                         conversionType: a.conversionType, claimType: a.claimType, countryOrRegion: a.countryOrRegion };
      await db.execute(sql`insert into crm_app_installs (install_id, source, campaign, raw, dedupe_key)
        values (${installId}, 'apple_ads', ${JSON.stringify(campaign)}::jsonb, ${JSON.stringify(a)}::jsonb, ${`${installId}:apple_ads`})
        on conflict (dedupe_key) do nothing`);
      return { ok: true as const, attributed: true, campaign };
    }
    if (res.status === 404 && attempt < 3) { await new Promise((r) => setTimeout(r, waitMs)); continue; }
    return { ok: false as const, status: res.status };                 // 400 = bad token · 500 = retry later
  }
  return { ok: false as const, status: 404 };
}

// ---- G. AdAttributionKit / SKAdNetwork postback copies ---------------------------------------
// Info.plist: AttributionCopyEndpoint (AdAttributionKit) / NSAdvertisingAttributionReportEndpoint
// (SKAdNetwork) = "https://acme.com". Apple POSTs the winning postback's copy to
//   /.well-known/appattribution/report-attribution/   and   /.well-known/skadnetwork/report-attribution/
// Aggregate by design (no install_id, no user). Stored raw + deduped; the signed payload
// (JWS / signature fields) is kept so it can be verified against Apple's public key before use.
export async function attributionCopy(db: Db, kind: "adattributionkit" | "skadnetwork", req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 64_000) return new Response(null, { status: 413 });
  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  const pick = (...k: string[]) => k.map((x) => body[x]).find((v) => v !== undefined) ?? null;
  const campaign = {
    source: pick("source-identifier", "source-domain", "campaign-id"),
    publisher: pick("publisher-item-identifier", "source-app-id"),
    conversion: pick("conversion-value", "fine-conversion-value"),
    coarse: pick("coarse-conversion-value"),
    sequence: pick("postback-sequence-index"),
    didWin: pick("did-win"),
    network: pick("ad-network-id"),
  };
  await db.execute(sql`insert into crm_app_installs (install_id, source, campaign, raw, dedupe_key)
    values (null, ${kind}, ${JSON.stringify(campaign)}::jsonb, ${raw}::jsonb, ${createHash("sha256").update(raw).digest("hex")})
    on conflict (dedupe_key) do nothing`);
  return new Response(null, { status: 200 });
}

// ---- H. in-app inbox + engagement facts --------------------------------------------------------
// in_app messages are outbox rows (lifecycle-engine sends nothing for them — the row IS the item).
export async function inbox(db: Db, contactId: string, limit = 50) {
  const { rows } = await db.execute(sql`
    select id, subject as title, body, payload, sent_at, first_opened_at is not null as seen
    from crm_messages where contact_id = ${contactId}::uuid and channel = 'in_app'
      and status in ('sent', 'delivered', 'opened', 'clicked')
    order by sent_at desc limit ${limit}`);
  return rows;
}
// App calls this when a push or in-app message is opened/clicked (push data carries message_id).
export async function engaged(db: Db, contactId: string, messageId: string, action: "opened" | "clicked") {
  const upd = action === "opened"
    ? sql`update crm_messages set first_opened_at = coalesce(first_opened_at, now()),
            status = case when status in ('sent','delivered') then 'opened'::crm_message_status else status end
          where id = ${messageId}::uuid and contact_id = ${contactId}::uuid returning channel, campaign_id`
    : sql`update crm_messages set first_clicked_at = coalesce(first_clicked_at, now()), first_opened_at = coalesce(first_opened_at, now()),
            status = 'clicked'::crm_message_status
          where id = ${messageId}::uuid and contact_id = ${contactId}::uuid returning channel, campaign_id`;
  const { rows } = await db.execute<{ channel: string; campaign_id: string | null }>(upd);
  if (!rows.length) return false;
  await db.execute(sql`insert into crm_events (contact_id, name, source, properties, dedupe_key, occurred_at)
    values (${contactId}::uuid, ${`${rows[0].channel}.${action}`}, 'mobile_app',
            ${JSON.stringify({ message_id: messageId, campaign_id: rows[0].campaign_id })}::jsonb, ${`${messageId}:${action}`}, now())
    on conflict do nothing`);
  return true;
}

// ---- I. review prompts: ask only at peak moments ---------------------------------------------
// iOS shows the system prompt at most 3 times in 365 days (and only if the person hasn't rated
// the current version); Android's in-app review has its own undisclosed quota. Those are the
// platform's limits — the kit's job is to spend them on the best moments, not to add its own cap.
// PEAK = events that mean "this just went well". The app calls reviewMoment() right after one and,
// if true, runs StoreReview.requestReview() then posts app.review_prompted.
const PEAK = list(process.env.MKT_REVIEW_PEAK_EVENTS ?? "order.delivered,loyalty.tier_up,nps.promoter,reward.redeemed,streak.milestone");
export async function reviewMoment(db: Db, contactId: string, installId: string, appVersion: string) {
  const { rows } = await db.execute<{ peak: boolean; asked_version: boolean; asks_365: number; complaint: boolean }>(sql`
    select
      exists (select 1 from crm_events where contact_id = ${contactId}::uuid and occurred_at > now() - interval '10 minutes'
              and name = any(string_to_array(${PEAK.join(",")}, ','))) as peak,
      exists (select 1 from crm_events where anon_id = ${installId} and name = 'app.review_prompted'
              and properties->>'app_version' = ${appVersion}) as asked_version,
      (select count(*)::int from crm_events where anon_id = ${installId} and name = 'app.review_prompted'
              and occurred_at > now() - interval '365 days') as asks_365,
      exists (select 1 from crm_events where contact_id = ${contactId}::uuid and occurred_at > now() - interval '14 days'
              and name in ('support.ticket_opened', 'order.refunded', 'nps.detractor')) as complaint`);
  const r = rows[0];
  return Boolean(r.peak && !r.asked_version && r.asks_365 < 3 && !r.complaint);
}
