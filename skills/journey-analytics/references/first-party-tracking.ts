// =============================================================================
// Marketing Kit — first-party tracking. crm_events is the ONLY analytics store.
// marketing-kit:collector   ← keep this marker; mkt-doctor looks for it.
//
// Four pieces, on your own domain and your own Postgres:
//   A. lib/track.ts        client: anon, session and event ids, UTMs + click ids, page context → /api/t
//   B. app/api/t/route.ts  collector: validate, drop bots and forged server facts, derive device,
//                          browser and place ON THE SERVER, store a retried beacon once
//   C. lib/stitch.ts       at signup/login: link the browser's history to the contact, set first touch
//   D. lib/vitals.ts       real-user Core Web Vitals per page and device
//
// One brain: browser events (this collector), server facts (source 'app', written by the code that
// performs them) and provider webhooks (resend, telnyx) all land in crm_events next to orders and
// messages. Dashboards are queries over it: analytics.sql §D has the standard traffic set (visitors,
// visits, views, bounce, duration, pages, sources, devices, places, right now, daily trend), and an
// app's own admin analytics screen is built on the same definitions. No third-party script, no
// second analytics database to reconcile.
//
// MOBILE IS FIRST-CLASS: device, os, browser and in-app browser (Instagram/TikTok webviews, where
// creator traffic lands) are derived on YOUR server from the user agent, so every report splits by
// device with no SDK. The Expo app posts to the same collector with client:"app".
//
// Private by construction: no IP stored; referrers keep origin + path only; query strings drop
// token-like keys and anything holding an @; server-derived keys are written LAST, so a page can
// never claim a device, browser or country.
// =============================================================================
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
type Db = NodePgDatabase<Record<string, never>>;

// ─── A. lib/track.ts (client; the file starts with "use client") ─────────────
const AID = "mk_aid", SID = "mk_sid", SID_TS = "mk_sid_ts", IDLE_MS = 30 * 60 * 1000;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CLICK_KEYS = ["fbclid", "ttclid", "gclid", "msclkid", "ref"] as const;   // ref = creator / affiliate code
const NOT_FUNNEL = /^\/(admin|api)(\/|$)/;                                    // staff screens would skew funnels

function anonId(): string {
  let id = localStorage.getItem(AID);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(AID, id); }
  document.cookie = `${AID}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`; // server reads it at login
  return id;
}
function sessionId(): string {
  const now = Date.now(), last = Number(sessionStorage.getItem(SID_TS) || 0);
  let id = sessionStorage.getItem(SID);
  if (!id || now - last > IDLE_MS) { id = crypto.randomUUID(); sessionStorage.setItem(SID, id); }
  sessionStorage.setItem(SID_TS, String(now));
  return id;
}
function browserContext(): Record<string, unknown> {
  const nav = navigator as Navigator & { standalone?: boolean; connection?: { effectiveType?: string } };
  return {
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    standalone: matchMedia("(display-mode: standalone)").matches || nav.standalone === true, // installed PWA
    net: nav.connection?.effectiveType ?? null, lang: navigator.language,
    screen: `${screen.width}x${screen.height}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    host: location.hostname, title: document.title, query: location.search.slice(1, 1000), // sanitized server-side
  };
}
function fromUrl<K extends string>(keys: readonly K[]): Partial<Record<K, string>> {
  const q = new URLSearchParams(location.search), out: Partial<Record<K, string>> = {};
  for (const k of keys) { const v = q.get(k); if (v) out[k] = v.slice(0, 200); }
  return out;
}

/** track("page.viewed") on every route change; track("cart.added", { sku, qty }) etc.
 *  Names: object.action, snake_case — the names reports, cohorts and triggers use. */
export function track(name: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || NOT_FUNNEL.test(location.pathname)) return;
  const body = JSON.stringify({
    name, properties, event_id: crypto.randomUUID(),   // the collector stores a retried beacon once
    anon_id: anonId(), session_id: sessionId(),
    path: location.pathname, referrer: document.referrer || null, ...fromUrl(UTM_KEYS),
    click_id: fromUrl(CLICK_KEYS), ctx: browserContext(), occurred_at: new Date().toISOString(),
  });
  if (!navigator.sendBeacon?.("/api/t", new Blob([body], { type: "application/json" })))
    fetch("/api/t", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
}
// Page views: call track("page.viewed") from a small client component that watches the route
// (Next: usePathname()/useSearchParams() in app/layout.tsx · React Router: useLocation()).
// Store events: product.viewed { sku } · cart.added { sku, qty } · checkout.started { value_cents }.
// Orders are server facts (order.paid, source 'app') — never browser events.

// ─── B. app/api/t/route.ts (collector) ───────────────────────────────────────
//   import { db } from "@/db";  import { getContactIdFromSession } from "@/lib/auth";
//   export const POST = (req: Request) => collect(db, req, () => getContactIdFromSession(req));
// Put the route behind the app's rate limiter (per anon_id + per IP) so bots can't flood the table.

const Event = z.object({
  name: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/).max(64),   // object.action
  properties: z.record(z.string(), z.unknown()).default({}),
  event_id: z.string().uuid().optional(),                       // the browser's id for this event
  anon_id: z.string().uuid(), session_id: z.string().uuid(),
  path: z.string().max(500), referrer: z.string().max(500).nullable().optional(),
  utm_source: z.string().max(200).optional(), utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(), utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  click_id: z.record(z.string(), z.string().max(300)).optional(), // fbclid | ttclid | gclid | msclkid | ref
  ctx: z.record(z.string(), z.unknown()).optional(),             // page context (web) · platform, app_version (app)
  client: z.enum(["web", "app"]).default("web"),                 // "app" = the Expo app (install_id as anon_id)
  occurred_at: z.string().datetime(),
});
const Body = z.union([Event, z.array(Event).min(1).max(20)]);

/** Names only the server writes (source 'app'). A page must not forge a sale, a signup or a message
 *  event: conversions, funnels and campaign triggers read them. Extend with the app's own. */
export const SERVER_ONLY = /^(order|payment|refund|subscription|signup|account|message|ai)\./;
export const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|httpclient/i;

// In-app browsers matter: creator traffic from Instagram/TikTok opens in their webviews, where
// cookies are per-app and Apple/Google Pay may be missing — reports split on it.
const INAPP: [RegExp, string][] = [[/Instagram/i, "instagram"], [/musical_ly|Bytedance|TikTok/i, "tiktok"],
  [/FBAN|FBAV|FB_IAB/i, "facebook"], [/Snapchat/i, "snapchat"], [/Pinterest/i, "pinterest"], [/Twitter|X-Client/i, "x"],
  [/LinkedInApp/i, "linkedin"], [/Line\//i, "line"], [/; wv\)/, "android_webview"]];
export function deviceContext(ua: string) {
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const os = /iPhone|iPad|iPod/.test(ua) || ipad ? "ios" : /Android/.test(ua) ? "android" : /CrOS/.test(ua) ? "chromeos"
    : /Windows/.test(ua) ? "windows" : /Mac OS X/.test(ua) ? "macos" : /Linux/.test(ua) ? "linux" : "other";
  const device = ipad || (/Android/.test(ua) && !/Mobile/.test(ua)) || /Tablet/.test(ua) ? "tablet"
    : /Mobi|iPhone|iPod|Android/.test(ua) ? "mobile" : "desktop";
  return { device, os, inapp: INAPP.find(([re]) => re.test(ua))?.[1] ?? null };
}
// Order matters: Edge, Opera and Samsung also say "Chrome"; every iOS browser also says "Safari".
const BROWSERS: [RegExp, string][] = [[/EdgA?\/(\d+)/, "edge"], [/OPR\/(\d+)/, "opera"], [/SamsungBrowser\/(\d+)/, "samsung"],
  [/CriOS\/(\d+)/, "chrome"], [/FxiOS\/(\d+)/, "firefox"], [/Firefox\/(\d+)/, "firefox"], [/Chrome\/(\d+)/, "chrome"],
  [/Version\/(\d+)[\d.]* (Mobile\/\S+ )?Safari/, "safari"]];
export function browserOf(ua: string) {
  for (const [re, browser] of BROWSERS) { const m = re.exec(ua); if (m) return { browser, browser_version: m[1] }; }
  return { browser: "other", browser_version: null };
}

/* What the page says about itself — whitelisted and shape-checked, never trusted as-is. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
const TZ_RE = /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2})$/;
const SCREEN_RE = /^\d{2,5}x\d{2,5}$/;
const NETWORKS = new Set(["4g", "3g", "2g", "slow-2g"]);
const SECRETISH = /token|key|secret|pass|auth|sig|code|session|email|phone|otp|jwt/i;
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || undefined : undefined;
const num = (v: unknown, min: number, max: number, digits = 0) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10 ** digits) / 10 ** digits : undefined;
const lang = (v: unknown) => (typeof v === "string" && LANG_RE.test(v.trim()) ? v.trim() : undefined);
const host = (v: unknown) => {
  const h = typeof v === "string" ? v.trim().toLowerCase().replace(/:\d+$/, "") : "";
  return h.length <= 253 && HOST_RE.test(h) ? h : undefined;
};

/** Query string minus anything that could be a credential or a person (tokens, codes, emails). */
export function sanitizeQuery(q: unknown): string | undefined {
  if (typeof q !== "string" || !q) return undefined;
  const out = new URLSearchParams(); let n = 0;
  for (const [k, v] of new URLSearchParams(q)) {
    if (n >= 20) break;
    if (SECRETISH.test(k) || v.includes("@") || v.length > 200) continue;
    out.append(k.slice(0, 64), v); n++;
  }
  return out.toString().slice(0, 500) || undefined;
}

/** The page context the collector keeps: known keys with valid values only. */
export function cleanContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  const c = ctx ?? {}, out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
  set("vw", num(c.vw, 0, 20_000)); set("vh", num(c.vh, 0, 20_000)); set("dpr", num(c.dpr, 0, 10, 2));
  set("standalone", typeof c.standalone === "boolean" ? c.standalone : undefined);
  set("net", typeof c.net === "string" && NETWORKS.has(c.net) ? c.net : undefined);
  set("language", lang(c.lang));
  set("screen", typeof c.screen === "string" && SCREEN_RE.test(c.screen) ? c.screen : undefined);
  set("tz", typeof c.tz === "string" && c.tz.length <= 64 && TZ_RE.test(c.tz) ? c.tz : undefined);
  set("hostname", host(c.host)); set("title", text(c.title, 120)); set("query", sanitizeQuery(c.query));
  return out;
}

/** Where a link came from: origin + path, never its query or fragment (tokens, emails). */
export function cleanReferrer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ["http:", "https:", "android-app:"].includes(u.protocol) ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 500) : null;
  } catch { return null; }
}
/** The referring site (lowercase, no www.), or null when the link came from this site itself. */
export function referrerHost(referrer: string | null, ownHost: string | null | undefined): string | null {
  if (!referrer) return null;
  let h: string;
  try { h = new URL(referrer).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  const own = (ownHost ?? "").replace(/^www\./, "");
  return !h || (own && (h === own || h.endsWith(`.${own}`))) ? null : h;
}
const clickIds = (ids: Record<string, string> | undefined) => {
  const out: Record<string, string> = {};
  for (const k of CLICK_KEYS) { const v = ids?.[k]?.trim(); if (v) out[k] = v; }   // known names only
  return out;
};
const bounded = (p: Record<string, unknown>) =>   // 50 keys, strings of 500 characters
  Object.fromEntries(Object.entries(p).slice(0, 50).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 500) : v]));
/** Client clocks: future or more than a day old becomes now. */
const clampTime = (iso: string) => {
  const t = new Date(iso).getTime(), now = Date.now();
  return t > now + 60_000 || t < now - 86_400_000 ? new Date() : new Date(t);
};
/** First tag of Accept-Language ("en-US,en;q=0.9" → "en-US"). */
export const acceptLanguage = (h: string | null) => lang(h?.split(",")[0]?.split(";")[0]) ?? null;

/** Place from the edge in front of the app — no IP is stored or looked up. Cloudflare always sends
 *  the country; region/city need its "Add visitor location headers" managed transform. Trust these
 *  headers only behind that edge (strip them at your proxy otherwise). */
export function edgeGeo(h: Headers) {
  const first = (names: string[]) => { for (const n of names) { const v = h.get(n)?.trim(); if (v) return v; } return null; };
  const c = first(["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country"])?.toUpperCase() ?? null;
  let city: string | null = null;
  try { city = decodeURIComponent(first(["x-vercel-ip-city", "cloudfront-viewer-city", "cf-ipcity"]) ?? "").slice(0, 80) || null; } catch { city = null; }
  return {
    country: c && /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null,   // XX unknown · T1 Tor
    region: first(["x-vercel-ip-country-region", "cloudfront-viewer-country-region", "cf-region-code"])?.slice(0, 16) ?? null,
    city,
  };
}
function appDevice(ctx: Record<string, unknown> | undefined) {
  const p = typeof ctx?.platform === "string" ? ctx.platform.toLowerCase() : "";
  return { device: "mobile", os: p === "ios" || p === "android" ? p : "other", inapp: null, browser: null,
           browser_version: null, app_version: text(ctx?.app_version, 32) ?? null };
}
const requestHost = (req: Request) =>
  host((req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host).split(",")[0]) ?? null;
function sameSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).hostname.toLowerCase() === requestHost(req); } catch { return false; }
}

/** POST /api/t. Always answers 204 — a bad beacon never breaks the page. */
export async function collect(db: Db, req: Request, contactOf: () => Promise<string | null> = async () => null): Promise<Response> {
  const done = () => new Response(null, { status: 204 });
  try {
    if (!sameSite(req) || BOT.test(req.headers.get("user-agent") ?? "")) return done();
    const raw = await req.text();
    if (raw.length > 32_000) return new Response(null, { status: 413 });
    let json: unknown;
    try { json = JSON.parse(raw || "null"); } catch { return done(); }
    const parsed = Body.safeParse(json);
    if (!parsed.success) return done();
    const events = (Array.isArray(parsed.data) ? parsed.data : [parsed.data]).filter((e) => !SERVER_ONLY.test(e.name));
    if (!events.length) return done();
    const contactId = await contactOf().catch(() => null);
    const ua = req.headers.get("user-agent") ?? "";
    const web = { ...deviceContext(ua), ...browserOf(ua) };
    const geo = edgeGeo(req.headers), own = requestHost(req), headerLang = acceptLanguage(req.headers.get("accept-language"));
    const rows = events.map((e) => {
      const { name, anon_id, session_id, properties, occurred_at, ctx, client, click_id, referrer, event_id, ...rest } = e;
      const page = client === "app" ? {} : cleanContext(ctx);
      const ref = cleanReferrer(referrer), hostname = (page.hostname as string | undefined) ?? own;
      const props = {
        ...bounded(properties), ...rest, referrer: ref, ...clickIds(click_id), ...page,
        language: (page.language as string | undefined) ?? headerLang, hostname,
        // Server-derived keys LAST: the page can never claim a device, browser or country.
        ...(client === "app" ? appDevice(ctx) : web), ...geo, referrer_host: referrerHost(ref, hostname),
      };
      return sql`(${contactId}::uuid, ${name}, ${client === "app" ? "mobile_app" : "web"}, ${anon_id}, ${session_id},
        ${JSON.stringify(props)}::jsonb, ${clampTime(occurred_at).toISOString()}::timestamptz, ${event_id ? `evt:${event_id}` : null})`;
    });
    // (source, dedupe_key) is unique: a retried beacon is one row, and the rest of its batch still lands.
    await db.execute(sql`insert into crm_events (contact_id, name, source, anon_id, session_id, properties, occurred_at, dedupe_key)
      values ${sql.join(rows, sql`, `)} on conflict do nothing`);
  } catch (err) {
    console.warn("crm collector insert failed", err);
  }
  return done();
}

// ─── C. lib/stitch.ts (server; call right after signup AND login) ────────────
/** Link everything this browser did before login to the contact, and set first touch once. */
export async function stitchAnon(db: Db, contactId: string, anonIdCookie: string | undefined) {
  if (!anonIdCookie) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into crm_identities (contact_id, kind, value) values (${contactId}::uuid, 'anon_id', ${anonIdCookie})
      on conflict (kind, value) do nothing`);
    await tx.execute(sql`
      update crm_events set contact_id = ${contactId}::uuid
      where anon_id = ${anonIdCookie} and contact_id is null`);
    // first_touch = earliest event from this browser (UTMs, referring site, landing page), set once
    await tx.execute(sql`
      update crm_contacts c set first_touch = jsonb_strip_nulls(jsonb_build_object(
          'utm_source', e.properties->>'utm_source', 'utm_medium', e.properties->>'utm_medium',
          'utm_campaign', e.properties->>'utm_campaign', 'referrer', e.properties->>'referrer',
          'referrer_host', e.properties->>'referrer_host', 'landing_page', e.properties->>'path',
          'anon_id', e.anon_id, 'at', e.occurred_at))
      from (select * from crm_events where anon_id = ${anonIdCookie} order by occurred_at limit 1) e
      where c.id = ${contactId}::uuid and c.first_touch is null`);
  });
}
// Server-side facts (order paid, plan changed, limit hit) are inserted with source: "app" by the
// code that performs them — never inferred from page views, and never accepted from the browser
// (SERVER_ONLY above).

// ─── D. lib/vitals.ts (client; import once in the root layout) ─────────────
// Google's own `web-vitals` library, reported into crm_events — real users on real phones, split
// by device and page (mobile-growth → mobile.sql §3). Mobile-first indexing ranks the MOBILE
// experience, so these numbers are SEO numbers too. Good = LCP ≤2.5s · INP ≤200ms · CLS ≤0.1.
//   import { onCLS, onINP, onLCP } from "web-vitals";
//   const report = (m: { name: string; value: number; rating: string; navigationType: string }) =>
//     track("web.vital", { metric: m.name, value: Math.round(m.name === "CLS" ? m.value * 1000 : m.value), rating: m.rating, nav: m.navigationType });
//   onLCP(report); onINP(report); onCLS(report);        // CLS stored ×1000 (integer)
