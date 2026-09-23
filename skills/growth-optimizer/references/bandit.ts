// =============================================================================
// bandit.ts — always-on experiments that shift traffic to what earns, as it earns.
// Thompson sampling over crm_arms, sticky per subject (a customer or partner always gets the same
// arm), value-weighted (an arm that converts less but at 3× the order value can still win).
//
//   choose(db, "welcome-offer", contactId)   → { armId, spec }  e.g. spec = { discountBps: 1500 }
//   reward(db, "welcome-offer", contactId, cents)                call at order.paid (learns instantly)
//
// Use it for: welcome offers, loyalty reward sizes, commission plans offered to new creators,
// subject lines, landing variants, creator briefs. Arms are rows: add one any time, set
// active=false to retire. optimize.py reconciles counts from revenue if a reward call was missed.
// =============================================================================
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
export type Arm = { arm_id: string; spec: unknown; pulls: number; successes: number; reward_cents: number };

// ---- pure sampling (exported for tests) ----------------------------------------------------
function gauss(rng: () => number) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gamma(k: number, rng: () => number): number {        // Marsaglia–Tsang
  if (k < 1) return gamma(k + 1, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = gauss(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const beta = (a: number, b: number, rng = Math.random) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)); };

export function thompsonPick(arms: Arm[], rng = Math.random): Arm {
  // Expected value per pull = P(convert) × value-per-conversion. Value uses a shrunk mean so a
  // single big order can't hijack an arm: prior = the pooled mean, weight 3 conversions.
  const tot = arms.reduce((a, r) => ({ s: a.s + Number(r.successes), c: a.c + Number(r.reward_cents) }), { s: 0, c: 0 });
  const pooled = tot.s ? tot.c / tot.s : 1;
  let best = arms[0], bestV = -Infinity;
  for (const r of arms) {
    const p = beta(1 + Number(r.successes), 1 + Number(r.pulls) - Number(r.successes), rng);
    const value = (3 * pooled + Number(r.reward_cents)) / (3 + Number(r.successes));
    const v = p * value;
    if (v > bestV) { bestV = v; best = r; }
  }
  return best;
}

// ---- DB wrappers -----------------------------------------------------------------------------
export async function choose(db: Db, experimentId: string, subjectId: string) {
  return db.transaction(async (tx) => {
    const prior = await tx.execute<{ arm_id: string; spec: unknown }>(sql`
      select p.arm_id, a.spec from crm_arm_pulls p join crm_arms a using (experiment_id, arm_id)
      where p.experiment_id = ${experimentId} and p.subject_id = ${subjectId}`);
    if (prior.rows[0]) return { armId: prior.rows[0].arm_id, spec: prior.rows[0].spec, sticky: true };
    const { rows } = await tx.execute<Arm>(sql`
      select arm_id, spec, pulls, successes, reward_cents from crm_arms
      where experiment_id = ${experimentId} and active for update`);
    if (!rows.length) return null;
    const pick = thompsonPick(rows);
    const ins = await tx.execute(sql`
      insert into crm_arm_pulls (experiment_id, arm_id, subject_id) values (${experimentId}, ${pick.arm_id}, ${subjectId})
      on conflict do nothing`);
    if ((ins.rowCount ?? 0) > 0)
      await tx.execute(sql`update crm_arms set pulls = pulls + 1, updated_at = now()
                           where experiment_id = ${experimentId} and arm_id = ${pick.arm_id}`);
    return { armId: pick.arm_id, spec: pick.spec, sticky: false };
  });
}

export async function reward(db: Db, experimentId: string, subjectId: string, cents: number) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ arm_id: string; first: boolean }>(sql`
      update crm_arm_pulls set reward_cents = reward_cents + ${cents}, rewarded_at = now(),
             rewarded = true
      where experiment_id = ${experimentId} and subject_id = ${subjectId}
      returning arm_id, (reward_cents = ${cents}) as first`);
    const r = rows[0];
    if (!r) return false;
    await tx.execute(sql`update crm_arms set reward_cents = reward_cents + ${cents},
                           successes = successes + ${r.first ? 1 : 0}, updated_at = now()
                         where experiment_id = ${experimentId} and arm_id = ${r.arm_id}`);
    return true;
  });
}
