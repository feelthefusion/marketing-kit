// =============================================================================
// Marketing Kit — first-party tracking (replaces GA4/PostHog). Next.js App Router + Drizzle.
// marketing-kit:collector   ← keep this marker; mkt-doctor looks for it.
//
// Three pieces, all on your own domain and your own Postgres:
//   A. lib/track.ts          client helper: anon id, session id, UTMs, sendBeacon → /api/t
//   B. app/api/t/route.ts    collector: validate, drop bots, attach the logged-in contact, insert
//   C. lib/stitch.ts         at signup/login: link the anon id's history to the contact
//   D. lib/vitals.ts         real-user Core Web Vitals (LCP/INP/CLS) per page, per device class
//
// MOBILE IS FIRST-CLASS: every event carries device context (device, os, in-app browser, PWA
// standalone, viewport) derived on YOUR server from the user agent — so every report splits
// mobile vs desktop and Instagram/TikTok in-app browsers (where creator traffic lands) with no
// SDK. The Expo app posts to the same collector with client:"app" (mobile-growth/app-client.md).
//
// Why this and not a SaaS tag: events arrive on your domain (ad blockers rarely drop them), land
// in crm_events next to orders and messages (one SQL join, no sync), and triggers read them
// directly. Umami (core) is the human dashboard; this table is what the engine acts on.
// Defaults: no IP column (add `ip`/geo columns to crm_events if you want them — your call).
// =============================================================================

// ─── A. lib/track.ts (client) ───────────────────────────────────────────────
"use client";
const AID = "mk_aid", SID = "mk_sid", SID_TS = "mk_sid_ts", IDLE_MS = 30 * 60 * 1000;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

function anonId(): string {
  let id = localStorage.getItem(AID);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(AID, id); }
  document.cookie = `${AID}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`; // server can read it at login
  return id;
}
function sessionId(): string {
  const now = Date.now(), last = Number(sessionStorage.getItem(SID_TS) || 0);
  let id = sessionStorage.getItem(SID);
  if (!id || now - last > IDLE_MS) { id = crypto.randomUUID(); sessionStorage.setItem(SID, id); }
  sessionStorage.setItem(SID_TS, String(now));
  return id;
}
function viewport(): Record<string, unknown> {
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
  return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, standalone,     // standalone = installed PWA
           net: (navigator as any).connection?.effectiveType ?? null };              // 4g | 3g | … (Chromium)
}
function utms(): Record<string, string> {
  const q = new URLSearchParams(location.search), out: Record<string, string> = {};
  for (const k of UTM_KEYS) { const v = q.get(k); if (v) out[k] = v.slice(0, 200); }
  return out;
}

/** track("page.viewed") on route change; track("pricing.cta_clicked", { plan: "pro" }) etc.
 *  Names: object.action, snake_case — the same names cohort SQL and triggers use. */
export function track(name: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({
    name, properties,
    anon_id: anonId(), session_id: sessionId(),
    path: location.pathname, referrer: document.referrer || null, ...utms(),
    ctx: viewport(), occurred_at: new Date().toISOString(),
  });
  if (!navigator.sendBeacon?.("/api/t", new Blob([body], { type: "application/json" })))
    fetch("/api/t", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
}
// Page views: call track("page.viewed") from a small client component that watches
// usePathname()/useSearchParams() in app/layout.tsx.

// ─── B. app/api/t/route.ts (collector) ──────────────────────────────────────
import { z } from "zod";
import { db } from "@/db";                       // the app's Drizzle client
import { crmEvents } from "@/db/schema";        // from growth-data/references/crm-schema.ts
import { getContactIdFromSession } from "@/lib/auth"; // the app's own session → crm_contacts.id | null

const Event = z.object({
  name: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/).max(64),   // object.action
  properties: z.record(z.unknown()).default({}),
  anon_id: z.string().uuid(), session_id: z.string().uuid(),
  path: z.string().max(500), referrer: z.string().max(500).nullable(),
  utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(),
  utm_content: z.string().optional(), utm_term: z.string().optional(),
  ctx: z.record(z.unknown()).optional(),                          // viewport / standalone / net (web) · app version (app)
  client: z.enum(["web", "app"]).default("web"),                  // "app" = the Expo app (install_id as anon_id)
  occurred_at: z.string().datetime(),
});

// Device context from the UA, server-side (one place, same rules for every report).
// In-app browsers matter: creator traffic from Instagram/TikTok opens inside their webviews,
// where cookies are per-app and Apple/Google Pay may be missing — journey-analytics splits on it.
const INAPP: [RegExp, string][] = [[/Instagram/i, "instagram"], [/musical_ly|Bytedance|TikTok/i, "tiktok"],
  [/FBAN|FBAV|FB_IAB/i, "facebook"], [/Snapchat/i, "snapchat"], [/Pinterest/i, "pinterest"], [/Twitter|X-Client/i, "x"],
  [/LinkedInApp/i, "linkedin"], [/Line\//i, "line"], [/; wv\)/, "android_webview"]];
export function deviceContext(ua: string) {
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const os = /iPhone|iPad|iPod/.test(ua) || ipad ? "ios" : /Android/.test(ua) ? "android"
    : /Windows/.test(ua) ? "windows" : /Mac OS X/.test(ua) ? "macos" : /Linux|CrOS/.test(ua) ? "linux" : "other";
  const device = ipad || (/Android/.test(ua) && !/Mobile/.test(ua)) || /Tablet/.test(ua) ? "tablet"
    : /Mobi|iPhone|iPod|Android/.test(ua) ? "mobile" : "desktop";
  const inapp = INAPP.find(([re]) => re.test(ua))?.[1] ?? null;
  return { device, os, inapp };
}
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests/i;

export async function POST(req: Request) {
  // Same-site only: the site's own pages post here; everything else is noise.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) return new Response(null, { status: 204 });
  if (BOT.test(req.headers.get("user-agent") || "")) return new Response(null, { status: 204 });
  const raw = await req.text();
  if (raw.length > 8_000) return new Response(null, { status: 413 });

  const parsed = Event.safeParse(JSON.parse(raw || "{}"));
  if (!parsed.success) return new Response(null, { status: 204 });   // never break the page
  const e = parsed.data;

  // Clamp client clocks: future or >1 day old timestamps become "now".
  const t = new Date(e.occurred_at), now = Date.now();
  const occurredAt = t.getTime() > now + 60_000 || t.getTime() < now - 86_400_000 ? new Date() : t;

  const contactId = await getContactIdFromSession(req).catch(() => null);
  const { name, anon_id, session_id, properties, occurred_at, ctx: view, client, ...rest } = e;
  const device = client === "app"
    ? { device: "mobile", os: String(view?.platform ?? "other"), inapp: null, app_version: view?.app_version ?? null }
    : { ...deviceContext(req.headers.get("user-agent") || ""), ...(view ?? {}) };
  await db.insert(crmEvents).values({
    contactId, name, source: client === "app" ? "mobile_app" : "web", anonId: anon_id, sessionId: session_id,
    properties: { ...properties, ...rest, ...device },  // path, referrer, utm_*, device, os, inapp, vw… queryable as JSON
    occurredAt,
  });
  return new Response(null, { status: 204 });
}
// Rate limiting: put the route behind the app's existing limiter (per anon_id + per IP) so bots
// can't flood the table.

// ─── C. lib/stitch.ts (server; call right after signup AND login) ────────────
import { sql } from "drizzle-orm";
/** Link everything this browser did before login to the contact, and set first touch once. */
export async function stitchAnon(contactId: string, anonIdCookie: string | undefined) {
  if (!anonIdCookie) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into crm_identities (contact_id, kind, value) values (${contactId}, 'anon_id', ${anonIdCookie})
      on conflict (kind, value) do nothing`);
    await tx.execute(sql`
      update crm_events set contact_id = ${contactId}
      where anon_id = ${anonIdCookie} and contact_id is null`);
    // first_touch = earliest event from this browser (UTMs + referrer + landing page), set once
    await tx.execute(sql`
      update crm_contacts c set first_touch = jsonb_strip_nulls(jsonb_build_object(
          'utm_source', e.properties->>'utm_source', 'utm_medium', e.properties->>'utm_medium',
          'utm_campaign', e.properties->>'utm_campaign', 'referrer', e.properties->>'referrer',
          'landing_page', e.properties->>'path', 'anon_id', e.anon_id, 'at', e.occurred_at))
      from (select * from crm_events where anon_id = ${anonIdCookie} order by occurred_at limit 1) e
      where c.id = ${contactId} and c.first_touch is null`);
  });
}
// Also on the client after login: window.umami?.identify(contact.id)  (links the Umami dashboard).
// Server-side facts (order paid, plan changed, limit hit) are inserted with source: "app" by the
// code that performs them — never inferred from page views.

// ─── D. lib/vitals.ts (client; import once in app/layout.tsx) ──────────────
// Google's own `web-vitals` library, reported into crm_events — real users on real phones, split
// by device and page (mobile-growth → mobile.sql §3). Mobile-first indexing ranks the MOBILE
// experience, so these numbers are SEO numbers too. Good = LCP ≤2.5s · INP ≤200ms · CLS ≤0.1.
//   import { onCLS, onINP, onLCP } from "web-vitals";
//   const report = (m: { name: string; value: number; rating: string; navigationType: string }) =>
//     track("web.vital", { metric: m.name, value: Math.round(m.name === "CLS" ? m.value * 1000 : m.value), rating: m.rating, nav: m.navigationType });
//   onLCP(report); onINP(report); onCLS(report);        // CLS stored ×1000 (integer)
