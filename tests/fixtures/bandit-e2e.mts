// Bandit E2E: pure Thompson convergence + DB choose/reward (sticky, instant learning).
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
const { thompsonPick, beta, choose, reward } = await import("./ref/bandit.ts");
const ok = (n: string, c: boolean, x: unknown = "") => console.log(`${c ? "OK" : "FAIL"} ${n}${c ? "" : " " + JSON.stringify(x)}`);

// deterministic RNG (mulberry32)
let seed = 7; const rng = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const m = Array.from({ length: 4000 }, () => beta(3, 7, rng)).reduce((a, b) => a + b) / 4000;
ok("Beta(3,7) sampler mean ≈ 0.30", Math.abs(m - 0.3) < 0.01, m);

// 3 offers: conversion 2% / 5% / 4%, order value $50 / $50 / $120  → expected $1.00 / $2.50 / $4.80 per pull
const truth = [{ id: "a", p: 0.02, v: 5000 }, { id: "b", p: 0.05, v: 5000 }, { id: "c", p: 0.04, v: 12000 }];
const arms = truth.map((t) => ({ arm_id: t.id, spec: {}, pulls: 0, successes: 0, reward_cents: 0 }));
const late: Record<string, number> = { a: 0, b: 0, c: 0 };
for (let i = 0; i < 6000; i++) {
  const a = thompsonPick(arms, rng); const t = truth.find((x) => x.id === a.arm_id)!;
  a.pulls++; if (rng() < t.p) { a.successes++; a.reward_cents += t.v; }
  if (i >= 4000) late[a.arm_id]++;
}
ok("value-weighted: the lower-converting $120 offer wins most traffic (last 2,000 pulls ≥ 70%)", late.c / 2000 >= 0.7, late);
ok("the best converter by rate alone is NOT what wins (b < c)", late.b < late.c, late);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const db = drizzle(pool);
await pool.query(`insert into crm_arms (experiment_id, arm_id, spec) values ('welcome','ten','{"discountBps":1000}'),('welcome','twenty','{"discountBps":2000}') on conflict do nothing`);
const c1 = await choose(db, "welcome", "cust-1"); const c2 = await choose(db, "welcome", "cust-1");
ok("choose is sticky per subject", c1?.armId === c2?.armId && c2?.sticky === true, { c1, c2 });
await reward(db, "welcome", "cust-1", 8000); await reward(db, "welcome", "cust-1", 2000);
const { rows: [a] } = await pool.query(`select pulls, successes, reward_cents from crm_arms where experiment_id='welcome' and arm_id=$1`, [c1!.armId]);
ok("reward learns instantly: 1 pull, 1 success (repeat order ≠ 2nd success), $100 value", Number(a.pulls) === 1 && Number(a.successes) === 1 && Number(a.reward_cents) === 10000, a);
ok("reward for a subject never assigned is a no-op", (await reward(db, "welcome", "nobody", 500)) === false);
await pool.end();
