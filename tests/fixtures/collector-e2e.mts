// Collector E2E (journey-analytics → first-party-tracking.ts B + C) on real Postgres built from the
// kit's own schema. Proves: retry dedupe, server-derived device/browser/place beat what the page
// claims, forged server facts refused, cross-site and bots dropped, referrer/query stripped of
// secrets, app client, clock clamp, sign-in stitching, and the §D dashboard definitions.
import pg from "pg";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
const m = await import("./ref/first-party-tracking.ts");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows;
let fails = 0;
const check = (label: string, cond: boolean, got?: unknown) => {
  if (cond) console.log("OK", label); else { fails++; console.log("FAIL", label, JSON.stringify(got)); }
};
const IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const u = (n: number) => `5f0c8a1e-3b2d-4c5e-9f00-${String(n).padStart(12, "0")}`;
const ev = (over: Record<string, unknown> = {}) => ({
  name: "page.viewed", anon_id: u(1), session_id: u(101), event_id: u(9001),
  path: "/products/serum", referrer: "https://l.instagram.com/?u=https%3A%2F%2Fshop.test%2F&e=secret-token#frag",
  utm_source: "instagram", utm_campaign: "fall-drop", click_id: { fbclid: "fb.1.abc", evil: "x" },
  ctx: { vw: 390, vh: 844, dpr: 3, lang: "en-US", screen: "390x844", tz: "America/Los_Angeles", host: "shop.test",
         title: "Serum\u0000 30 mL", query: "utm_source=instagram&token=abc123&email=a%40b.c&color=blue" },
  properties: { device: "desktop", country: "FR", browser: "netscape", sku: "SER-30" },   // the page lies
  client: "web", occurred_at: new Date().toISOString(), ...over,
});
const post = (body: unknown, h: Record<string, string> = {}, raw?: string) => m.collect(db, new Request("https://shop.test/api/t", {
  method: "POST", body: raw ?? JSON.stringify(body),
  headers: { "content-type": "application/json", "user-agent": IG, origin: "https://shop.test", "cf-ipcountry": "US",
             "accept-language": "de-DE,de;q=0.9", ...h },
}));
const count = async (where = "true") => Number((await q(`select count(*) n from crm_events where ${where}`))[0].n);

const r1 = await post(ev());
check("beacon answers 204", r1.status === 204, r1.status);
await post(ev());                                                     // the browser retries the same beacon
check("retried beacon (same event_id) stored once", (await count()) === 1, await count());
const [row] = await q("select * from crm_events limit 1");
const p = row.properties;
check("server-derived device beats the page (mobile/ios/instagram)", p.device === "mobile" && p.os === "ios" && p.inapp === "instagram", p);
check("server-derived country + browser beat the page", p.country === "US" && p.browser !== "netscape", { c: p.country, b: p.browser });
check("referrer keeps origin + path only", p.referrer === "https://l.instagram.com/", p.referrer);
check("referrer_host = the referring site", p.referrer_host === "l.instagram.com", p.referrer_host);
check("query drops token + email keys, keeps the rest", p.query === "utm_source=instagram&color=blue", p.query);
check("known click ids only", p.fbclid === "fb.1.abc" && !("evil" in p), p);
check("title control characters stripped", p.title === "Serum  30 mL", p.title);
check("page language wins over Accept-Language", p.language === "en-US", p.language);
check("utm + page props kept", p.utm_campaign === "fall-drop" && p.sku === "SER-30" && p.path === "/products/serum", p);
check("dedupe key + source", row.dedupe_key === `evt:${u(9001)}` && row.source === "web", row);

await post([ev({ event_id: u(9002), path: "/cart" }), ev({ name: "order.paid", event_id: u(9003), properties: { total_cents: 999999 } })]);
check("forged order.paid refused, rest of the batch lands", (await count("name='order.paid'")) === 0 && (await count("properties->>'path'='/cart'")) === 1);
await post(ev({ event_id: u(9004) }), { origin: "https://evil.test" });
check("cross-site post dropped", (await count(`dedupe_key='evt:${u(9004)}'`)) === 0);
await post(ev({ event_id: u(9005) }), { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
check("bot dropped", (await count(`dedupe_key='evt:${u(9005)}'`)) === 0);
const bad = await post(null, {}, "{not json");
check("malformed body → 204, no throw", bad.status === 204);
await post(ev({ event_id: u(9006), occurred_at: "2000-01-01T00:00:00Z" }));
check("ancient client clock clamped to now", (await count(`dedupe_key='evt:${u(9006)}' and occurred_at > now() - interval '1 minute'`)) === 1);
await post(ev({ event_id: u(9007), client: "app", anon_id: u(2), ctx: { platform: "ios", app_version: "2.1.0" } }));
const [app] = await q(`select source, properties from crm_events where dedupe_key='evt:${u(9007)}'`);
check("app client → mobile_app, ios, app_version", app?.source === "mobile_app" && app.properties.os === "ios" && app.properties.app_version === "2.1.0", app);
await post(ev({ event_id: u(9008) }), { "user-agent": SAFARI });
const [sf] = await q(`select properties from crm_events where dedupe_key='evt:${u(9008)}'`);
check("Safari detected with major version", sf?.properties.browser === "safari" && sf.properties.browser_version === "18", sf?.properties);

// C. sign-in stitching
await q("insert into crm_contacts (id, email) values ($1, 'stitch@x.test')", [u(7001)]);
await m.stitchAnon(db, u(7001), u(1));
check("stitch links the browser's history to the contact", (await count(`anon_id='${u(1)}' and contact_id is null`)) === 0);
const [c] = await q("select first_touch from crm_contacts where id=$1", [u(7001)]);
check("first touch = instagram / fall-drop, set once", c.first_touch?.utm_source === "instagram" && c.first_touch?.referrer_host === "l.instagram.com", c.first_touch);

// §D dashboard definitions, on two known visits: A = 1 page view (a bounce); B = 2 views + a cart add over 90 s
await q("truncate crm_events");
const now = Date.now(), at = (s: number) => new Date(now - s * 1000).toISOString();
await post(ev({ event_id: u(1), anon_id: u(11), session_id: u(201), occurred_at: at(300), path: "/" }));
await post([ev({ event_id: u(2), anon_id: u(12), session_id: u(202), occurred_at: at(90), path: "/" }),
            ev({ event_id: u(3), anon_id: u(12), session_id: u(202), occurred_at: at(60), path: "/products/serum" }),
            ev({ event_id: u(4), anon_id: u(12), session_id: u(202), occurred_at: at(0), name: "cart.added", path: "/products/serum" })]);
const sqlFile = readFileSync(process.env.ANALYTICS_SQL!, "utf8");
const section = (tag: string) => { const s = sqlFile.slice(sqlFile.indexOf(`-- ${tag}.`)); return s.slice(0, s.search(/\n\s*\n/)); };
const [d1] = await q(section("D1"));
check("D1: 2 visitors, 2 visits, 3 views, 50% bounce, 45 s average visit",
  Number(d1.visitors) === 2 && Number(d1.visits) === 2 && Number(d1.views) === 3 && Number(d1.bounce_pct) === 50 && Number(d1.avg_duration_s) === 45, d1);
const d2 = await q(section("D2"));
check("D2: pages with views + entries", d2.some((r) => r.path === "/" && Number(r.views) === 2 && Number(r.entries) === 2), d2);
const d3 = await q(section("D3"));
check("D3: both visits from instagram", d3.length === 1 && d3[0].source === "instagram" && Number(d3[0].visits) === 2, d3);
const d4 = await q(section("D4"));
check("D4: device split", d4.length >= 1 && d4[0].device === "mobile", d4);
const d6 = await q(section("D6"));
check("D6: right now shows the active page", d6.some((r) => Number(r.visitors) >= 1), d6);

await pool.end();
process.exit(fails ? 1 : 0);
