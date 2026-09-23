---
name: growth-optimizer
description: "Use when the marketing should learn and improve from the app's own sales: churn and CLV prediction, partner/creator quality scores, creator prospect fit, always-on experiments (Thompson-sampling bandits) for offers, rewards, commission plans and copy, retraining as orders grow, and turning scores into segments, audiences and decisions. Also for `mkt-optimize`."
---

# Growth Optimizer (learns from your orders, gets sharper as you grow)

Everything learns from first-party data in your Postgres and writes plain rows back
(`crm_scores`, `crm_arms`), so every other skill can simply JOIN them. Models grow with the data
and never ship a guess: each one must beat a transparent baseline on a period it never saw, or
the baseline is what gets written.

## What it produces

| Score (`crm_scores.model`) | Subject | Baseline → model | Used for |
|---|---|---|---|
| `churn_90d` | contact | recency deciles → gradient boosting (gated on AUC) | win-back before lapse, ad exclusions |
| `clv` | contact | spend run-rate → Poisson gradient boosting (gated on deviance) | VIP tiers, value lookalikes, bid caps |
| `partner_quality` | partner | empirical-Bayes value per order × pace | who gets higher tiers, Partnership Ads |
| `prospect_fit` | prospect | engaged reach → model on signed partners' outcomes (≥ 15) | which creators to recruit next |

Arms (`crm_arms`) — always-on experiments: `references/bandit.ts` — `choose()` (sticky per
subject, Thompson sampling, value-weighted: a $120 offer converting 4% beats a $50 offer at 5%)
and `reward()` at order.paid (learns instantly). Use for welcome offers, reward sizes,
commission plans for new creators, subject lines, landing variants.

## Run

```bash
mkt-optimize                 # train + score now (reads the project's DB URL)
mkt-optimize --if-due        # only when enough new orders arrived (≥ 50 or 10%)
mkt-optimize --report        # last runs with validation metrics
```

It's a `uv` script (`scripts/optimize.py`, deps pinned inline), so it always runs the kit's
current version. For 24/7 learning on Railway: apply `references/optimizer.sql` (a NOTIFY trigger
on new orders) and deploy `uv run optimize.py --listen` as a service. It wakes on orders, not a
clock. Optional role for it in the same file. Nothing needs setting up before you have sales.

## Growth stages (what to expect)

- **< 300 orders**: baselines only (still useful: recency-calibrated churn, run-rate CLV);
  bandits already work from the first visitor.
- **300+ orders and 2× the horizon of history**: gradient-boosted churn/CLV switch on when they
  win on held-out time. `mkt-optimize --report` shows model vs baseline every run.
- **15+ signed creators with results**: prospect_fit learns your ideal creator profile.
- **Beyond that** (tens of thousands of customers): consider pymc-marketing (Bayesian CLV,
  media-mix models) — same `crm_scores` output contract, so nothing downstream changes.

## Turning scores into money (the loop)

1. Segments (growth-data): `join crm_scores` — at-risk VIPs (`churn_90d > 0.6 and clv > $200`),
   rising stars, dormant high-value.
2. Offers: bandit picks the offer per segment; loyalty-engine awards; lifecycle-engine sends.
3. Partners: raise tiers for top `partner_quality`, seed the top `prospect_fit`.
4. Ads (meta-ads): value lookalikes from top `clv`, exclude low churn-risk loyal members.
5. Measure lift vs holdout, `mkt-ledger save` the result — the ledger is the long-term memory,
   the models are the short-term one.

## Works with →
- **partner-program** · **loyalty-engine** · **meta-ads** — consume the scores and arms.
- **growth-data** — scores are plain rows to JOIN into cohorts.
- **playbook-ledger** — save each learned lesson so it survives model retrains.
