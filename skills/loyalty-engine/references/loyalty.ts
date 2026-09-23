// =============================================================================
// Loyalty — points, tiers, rewards, store credit. Pattern, not a drop-in.
//
//   settleLoyalty(db)                 after order.paid / refund: loyalty.sql 2–3 (earn · claw back)
//   awardAction(db, contact, key, pts) review, UGC post, birthday, profile… — once per key
//   redeem(db, contact, rewardId)     points → reward (store credit or perk), balance-checked
//   spendCredit(tx, contact, order, ¢) at checkout, inside the order transaction
//   status(db, contact)               tier, points, credit, distance to next tier (for UI + messages)
//
// Balances are sums over append-only ledgers; every write takes a row lock on the contact so two
// concurrent redemptions can't overspend. Tiers are a view (rolling 12-month spend) — never stale.
// =============================================================================
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const SQL_DIR = process.env.MKT_SQL_DIR ?? join(process.cwd(), "sql");
const POINTS_PER_DOLLAR = Number(process.env.LOYALTY_POINTS_PER_DOLLAR ?? 1);

let earn: string[] | null = null;
function earnStatements(): string[] {
  if (earn) return earn;
  const src = readFileSync(join(SQL_DIR, "loyalty.sql"), "utf8");
  const body = src.slice(src.indexOf("-- 2. EARN"), src.indexOf("-- 4. EXPIRE"))
    .replaceAll(":points_per_dollar", String(POINTS_PER_DOLLAR))
    .replace(/case when :'expiry_days'[\s\S]*?end/, process.env.LOYALTY_EXPIRY_DAYS
      ? `r.occurred_at + make_interval(days => ${Number(process.env.LOYALTY_EXPIRY_DAYS)})` : "null::timestamptz");
  const parsed = body.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  earn = parsed;
  return parsed;
}
export async function settleLoyalty(db: Db | Tx) {
  for (const s of earnStatements()) await db.execute(sql.raw(s));
}

const lock = (tx: Tx, contactId: string) => tx.execute(sql`select 1 from crm_contacts where id = ${contactId} for update`);
const pointsOf = async (tx: Tx, contactId: string) =>
  Number((await tx.execute<{ p: number }>(sql`select coalesce(sum(points), 0)::int as p from crm_loyalty_ledger where contact_id = ${contactId}`)).rows[0].p);
const creditOf = async (tx: Tx, contactId: string) =>
  Number((await tx.execute<{ c: number }>(sql`select coalesce(sum(amount_cents), 0)::bigint as c from crm_store_credit where contact_id = ${contactId}`)).rows[0].c);

export async function awardAction(db: Db, contactId: string, actionKey: string, points: number) {
  const { rowCount } = await db.execute(sql`
    insert into crm_loyalty_ledger (contact_id, points, kind, ref) values (${contactId}, ${points}, 'earn_action', ${actionKey})
    on conflict (contact_id, kind, ref) do nothing`);
  return (rowCount ?? 0) > 0;   // false = already awarded for this key
}

export async function redeem(db: Db, contactId: string, rewardId: string) {
  return db.transaction(async (tx) => {
    await lock(tx, contactId);
    const { rows: [w] } = await tx.execute<{ cost_points: number; credit_cents: number | null; min_tier_rank: number; perk: unknown }>(sql`
      select cost_points, credit_cents, min_tier_rank, perk from crm_loyalty_rewards where id = ${rewardId} and active`);
    if (!w) return { ok: false as const, reason: "no_such_reward" };
    const { rows: [st] } = await tx.execute<{ tier_rank: number | null }>(sql`
      select tier_rank from crm_loyalty_status where contact_id = ${contactId}`);
    if ((st?.tier_rank ?? 0) < w.min_tier_rank) return { ok: false as const, reason: "tier_too_low" };
    if ((await pointsOf(tx, contactId)) < w.cost_points) return { ok: false as const, reason: "not_enough_points" };
    const redemption = randomUUID();
    await tx.execute(sql`insert into crm_loyalty_ledger (contact_id, points, kind, ref)
                         values (${contactId}, ${-w.cost_points}, 'redeem', ${redemption})`);
    if (w.credit_cents) await tx.execute(sql`insert into crm_store_credit (contact_id, amount_cents, kind, ref)
                                             values (${contactId}, ${w.credit_cents}, 'reward', ${redemption})`);
    await tx.execute(sql`insert into crm_events (contact_id, name, source, properties, occurred_at)
                         values (${contactId}, 'loyalty.redeemed', 'app', ${JSON.stringify({ reward_id: rewardId, redemption })}::jsonb, now())`);
    return { ok: true as const, redemption, creditCents: w.credit_cents ?? 0, perk: w.perk };
  });
}

// Inside the checkout transaction, before the order row is written as paid.
export async function spendCredit(tx: Tx, contactId: string, orderId: string, cents: number) {
  await lock(tx, contactId);
  const use = Math.min(cents, await creditOf(tx, contactId));
  if (use <= 0) return 0;
  await tx.execute(sql`insert into crm_store_credit (contact_id, amount_cents, kind, ref)
                       values (${contactId}, ${-use}, 'order_spend', ${orderId}) on conflict (kind, ref) do nothing`);
  return use;   // subtract from the amount to charge
}

export async function status(db: Db, contactId: string) {
  const { rows: [s] } = await db.execute(sql`select * from crm_loyalty_status where contact_id = ${contactId}`);
  return s ?? null;
}
