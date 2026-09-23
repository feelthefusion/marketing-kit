---
name: loyalty-engine
description: "Use when building, running, or optimizing a loyalty or rewards program in the app's own CRM: points per dollar, tiers on rolling 12-month spend, rewards and redemption, store credit, points for actions (reviews, UGC, birthdays, referrals), point expiry, tier-progress nudges, VIP perks, win-back with points balances."
---

# Loyalty Engine (points · tiers · rewards · store credit)

Repeat purchases are the cheapest revenue there is. The engine lives in the app's own Postgres:
append-only ledgers (points, store credit) with idempotency keys, tiers as a live view — never a
stale column, never a double-credit.

**Strategy upstream:** `churn-prevention`, `offers`, `marketing-psychology`, `referrals`,
`emails`, `sms`, `community-marketing`.

## Engine (tested: tests/run.sh "programs")

| Piece | File | What it does |
|---|---|---|
| Schema | growth-data `references/crm-schema.ts` | `crm_loyalty_tiers`, `crm_loyalty_ledger`, `crm_loyalty_rewards`, `crm_store_credit` |
| SQL | `references/loyalty.sql` | 1 tier view (`crm_loyalty_status`) · 2 earn per order at tier multiplier · 3 claw back refunds · 4 optional FIFO expiry · 5 tier-progress nudge audience |
| App | `references/loyalty.ts` | `settleLoyalty()` after order.paid/refund · `awardAction()` once per key · `redeem()` · `spendCredit()` at checkout · `status()` |

Knobs are psql vars / env: `points_per_dollar` (1), `expiry_days` (unset = points never expire).
Tiers and rewards are rows — change the program without a deploy.

## Techniques that work (in order of impact)

1. **Tiers on spend, shown as distance.** "You're $22 from Silver" beats any points balance.
   `loyalty.sql` §5 is the nudge audience (≤ $50 from next tier, or ≥ 500 points unspent) →
   lifecycle-engine SMS/email. Tier multipliers (1× / 1.25× / 1.5×) make the gap worth closing.
2. **Points for things that make more customers**: reviews with photos, UGC posts tagging you,
   referrals, birthday, profile completion — `awardAction(contact, "review:<sku>", 200)`.
   Each key pays once.
3. **Redeem into store credit, not discounts.** Credit brings them back to *spend* it, and
   costs you margin, not cash. `redeem()` → credit; `spendCredit()` at checkout.
4. **Make the first reward reachable fast** (first order + one action ≈ first reward).
   Programs die when the first reward is months away.
5. **Status perks > points**: early access to drops, free shipping, members-only bundles,
   a VIP line by SMS. Perks are `crm_loyalty_rewards.perk` / tier `perks`.
6. **Win-back with the balance**: "You have $14 in credit + 380 points" is the highest-
   converting win-back line — pair with growth-optimizer's `churn_90d` to hit people *before*
   they lapse.
7. **Expiry as a lever, not a trap.** Off by default. If you turn it on, message 14 days
   before points expire — urgency, not loss.
8. **Referral = loyalty.** Referring customers are `customer` partners with `store_credit`
   payout (skill partner-program); their friends' orders earn them credit automatically.

## Measure

Repeat rate and time-to-second-order by tier, redemption rate, credit liability
(`sum(crm_store_credit)`), revenue of members vs non-members with a holdout on
nudges (lifecycle-engine). growth-optimizer learns which reward sizes actually move repeat
spend (bandit experiments on reward size).

## Setup later (optional)

Nothing third-party: the whole engine is your DB + your app. Messages go out through the
Resend/Telnyx setup you already have.

## Works with →
- **partner-program** — store-credit payouts land in the same `crm_store_credit` ledger.
- **growth-optimizer** — churn/CLV scores pick who gets which reward; bandits size rewards.
- **lifecycle-engine** — tier-up, points-expiring, reward-unlocked and win-back sends.
