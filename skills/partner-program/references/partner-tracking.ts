// =============================================================================
// Partner tracking — creators, influencers, affiliates, customer referrers. Next.js App Router,
// Drizzle + pg. Pattern, not a drop-in: adapt the table/column names to the app.
//
//   A. client   captureRef()            ?ref=CODE on any URL → first-party cookie + partner.clicked
//   B. route    app/r/[code]/route.ts   short links: yoursite.com/r/maya → destination?ref=maya
//   C. checkout previewCode(code)       server-authoritative discount for a typed code
//   D. order    attributeOrder(tx, o)   at order.paid, IN THE SAME TRANSACTION as the order write
//   E. money    settle(db)              runs partner.sql 1–3 (accrue · claw back · approve)
//
// Attribution rules (all per-plan in crm_commission_plans, none hard-coded here):
//   1. a typed code wins over any cookie ("code"; "code+link" if the cookie agrees)
//   2. else the last ?ref cookie inside the plan's cookie_days ("link")
//   3. else a repeat order from a customer a partner brought in, inside the plan's
//      recurring_months ("recurring")
//   A partner buying through their own code is not attributed (that's paying yourself).
// =============================================================================
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const REF_COOKIE = "mk_ref";

// ---- A. client ----------------------------------------------------------------------------
// Call once on page load, next to track() from first-party-tracking.ts.
export function captureRef(track: (name: string, p: Record<string, unknown>) => void) {
  const code = new URLSearchParams(location.search).get("ref");
  if (!code || !/^[a-z0-9_-]{2,40}$/i.test(code)) return;
  const v = `${code.toLowerCase()}|${Date.now()}`;
  // 400 days = the browser max; each plan's cookie_days decides what still counts at order time.
  document.cookie = `${REF_COOKIE}=${encodeURIComponent(v)}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`;
  track("partner.clicked", { code: code.toLowerCase() });
}

// ---- B. short link route: app/r/[code]/route.ts --------------------------------------------
export async function shortLink(db: Db, code: string, req: Request): Promise<Response> {
  const c = code.toLowerCase();
  const { rows } = await db.execute<{ destination: string | null }>(sql`
    select destination from crm_partner_codes where code = ${c} and active`);
  const dest = new URL(rows[0]?.destination ?? "/", req.url);
  if (rows.length) dest.searchParams.set("ref", c);   // captureRef() on the landing page logs the click
  return Response.redirect(dest, 302);
}

// ---- C. checkout preview ------------------------------------------------------------------
export async function previewCode(db: Db, code: string) {
  const { rows } = await db.execute<{ partner_id: string; discount_bps: number }>(sql`
    select pc.partner_id, coalesce(pc.discount_bps, p.customer_discount_bps) as discount_bps
    from crm_partner_codes pc
    join crm_partners pa on pa.id = pc.partner_id and pa.status = 'active'
    join crm_commission_plans p on p.id = pa.plan_id and p.active
    where pc.code = ${code.toLowerCase()} and pc.active`);
  return rows[0] ?? null;   // null → not a partner code (maybe a normal promo code)
}

// ---- D. attribution at order.paid ---------------------------------------------------------
export type PaidOrder = {
  id: string;               // the app's own order id (== crm_revenue.id)
  contactId: string;
  netCents: number;         // after discount, before tax/shipping
  typedCode?: string | null;
  refCookie?: string | null; // raw mk_ref cookie from the checkout request
  paidAt: Date;
};

export async function attributeOrder(tx: Tx, o: PaidOrder) {
  const prior = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from crm_revenue
    where contact_id = ${o.contactId} and id <> ${o.id} and kind <> 'refund' and occurred_at < ${o.paidAt}`);
  const newCustomer = prior.rows[0].n === 0;

  const partnerFor = async (code: string) => (await tx.execute<{ partner_id: string; contact_id: string; cookie_days: number }>(sql`
    select pa.id as partner_id, pa.contact_id, p.cookie_days
    from crm_partner_codes pc join crm_partners pa on pa.id = pc.partner_id and pa.status = 'active'
    join crm_commission_plans p on p.id = pa.plan_id and p.active
    where pc.code = ${code.toLowerCase()} and pc.active`)).rows[0];

  const [cookieCode, cookieTs] = decodeURIComponent(o.refCookie ?? "").split("|");
  const typed = o.typedCode ? await partnerFor(o.typedCode) : undefined;
  const linked = cookieCode ? await partnerFor(cookieCode) : undefined;
  const linkFresh = linked && Number(cookieTs) > o.paidAt.getTime() - linked.cookie_days * 86_400_000;

  let hit: { partnerId: string; partnerContact: string; code: string | null; method: string; touchAt: Date | null } | null = null;
  if (typed) {
    const agrees = linkFresh && linked!.partner_id === typed.partner_id;
    hit = { partnerId: typed.partner_id, partnerContact: typed.contact_id, code: o.typedCode!.toLowerCase(),
            method: agrees ? "code+link" : "code", touchAt: agrees ? new Date(Number(cookieTs)) : null };
  } else if (linkFresh) {
    hit = { partnerId: linked!.partner_id, partnerContact: linked!.contact_id, code: cookieCode,
            method: "link", touchAt: new Date(Number(cookieTs)) };
  } else if (!newCustomer) {
    const rec = (await tx.execute<{ partner_id: string; contact_id: string }>(sql`
      select a.partner_id, pa.contact_id
      from crm_attributions a join crm_partners pa on pa.id = a.partner_id and pa.status = 'active'
      join crm_commission_plans p on p.id = pa.plan_id
      where a.contact_id = ${o.contactId} and a.new_customer and p.recurring_months > 0
        and ${o.paidAt} < a.attributed_at + make_interval(months => p.recurring_months)
      order by a.attributed_at limit 1`)).rows[0];
    if (rec) hit = { partnerId: rec.partner_id, partnerContact: rec.contact_id, code: null, method: "recurring", touchAt: null };
  }
  if (!hit || hit.partnerContact === o.contactId) return null;   // no partner, or self-referral

  await tx.execute(sql`
    insert into crm_attributions (order_id, partner_id, code, method, contact_id, new_customer, net_cents, touch_at, attributed_at)
    values (${o.id}, ${hit.partnerId}, ${hit.code}, ${hit.method}, ${o.contactId}, ${newCustomer}, ${o.netCents}, ${hit.touchAt}, ${o.paidAt})
    on conflict (order_id) do nothing`);
  // Feed the learning loop: which partner/plan produced this sale (growth-optimizer rewards arms).
  await tx.execute(sql`
    insert into crm_events (contact_id, name, source, properties, occurred_at, dedupe_key)
    values (${o.contactId}, 'partner.order_attributed', 'app',
            ${JSON.stringify({ order_id: o.id, partner_id: hit.partnerId, method: hit.method, net_cents: o.netCents, new_customer: newCustomer })}::jsonb,
            ${o.paidAt}, ${"attr:" + o.id})
    on conflict do nothing`);
  return { ...hit, newCustomer };
}

// ---- E. settle: the money statements, straight from partner.sql (one source of truth) -------
// Copy partner.sql into the app (e.g. sql/partner.sql) and point SQL_DIR at it.
const SQL_DIR = process.env.MKT_SQL_DIR ?? join(process.cwd(), "sql");
let statements: string[] | null = null;
function settleStatements(): string[] {
  if (statements) return statements;
  const src = readFileSync(join(SQL_DIR, "partner.sql"), "utf8");
  const body = src.slice(src.indexOf("-- 1. ACCRUE"), src.indexOf("-- 4. PAYABLE"));
  const parsed = body.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  statements = parsed;
  return parsed;
}
// Call after every order.paid and every refund (after the crm_revenue row with parent_id exists).
export async function settle(db: Db | Tx) {
  for (const s of settleStatements()) await db.execute(sql.raw(s));
}
