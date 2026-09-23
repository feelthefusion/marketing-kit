---
name: marketing-kit
description: "Use for ANY growth, marketing, CRM, email, SMS, campaign, segment, funnel, churn, upsell, retention, acquisition, affiliate, creator/influencer, referral, loyalty, ads or revenue task — and when installing or updating the Marketing Kit. Gives the workflow map (listen → segment → shape → write → harden → build/send → measure → remember) and which component owns each step: growth-data (CRM DB), journey-analytics (first-party events + orders, Umami, optional Search Console), marketing skills, humanizer, campaign-harden + mkt-preflight, lifecycle-engine (Resend + Telnyx), partner-program (affiliates, creators, referrals), loyalty-engine, meta-ads (official Meta Ads MCP), growth-optimizer (learns from sales), playbook-ledger (Supermemory)."
---

# Marketing Kit (workflow map)

The kit is a growth engine for apps that **own their CRM** (Postgres on Railway, Drizzle) and
send through **raw APIs** (Resend email, Telnyx SMS). No third-party CRM, no Zapier. This skill
is the map; each component loads on its own trigger, but they are designed as one loop and
hand off to each other in this order.

## Components

| # | Component | Source (always latest) | Owns |
|---|-----------|------------------------|------|
| 1 | **playbook-ledger** + Supermemory | local server :6767, `mkt-ledger` | ICPs, voice, offers, past lift, seasonal plays — recalled first, saved last |
| 2 | **growth-data** + `crm-db` / `railway` MCP | `postgres-mcp@latest`, `railway mcp` | CRM schema, identity stitching, cohort SQL, read-only by default |
| 3 | **journey-analytics** + first-party collector, `umami` MCP, optional `gsc` MCP | this kit · [umami-software/umami](https://github.com/umami-software/umami) (self-hosted, `:latest`) · AminForou/mcp-gsc (switch: `mkt-settings`) | traffic → behavior → revenue from the site's own data, one join key (`utm_campaign` = campaign id) |
| 4 | Marketing skills (`product-marketing`, `customer-research`, `copywriting`, `copy-editing`, `emails`, `sms`, `churn-prevention`, `onboarding`, `pricing`, `offers`, `referrals`, `ab-testing`, `analytics`, `attribution`, `marketing-psychology`, `revops`…) | coreyhaines31/marketingskills | strategy + first draft; all read `.agents/product-marketing.md` |
| 5 | `humanizer` | blader/humanizer (Hermes: bundled port) | strips AI tells from every customer-facing line |
| 6 | **campaign-harden** + `mkt-preflight` | this kit | persona grill, claim-vs-data check, schema/variable/link/segment gate |
| 7 | **lifecycle-engine** + Resend / Telnyx skills + MCP | resend/resend-skills, team-telnyx/ai (official) | triggers, outbox worker, webhooks, holdouts — in the app's own code |
| 8 | **partner-program** + `influencer-marketing`, `referrals`, `co-marketing` | this kit · marketingskills | creators, influencers, affiliates, customer referrals: codes, attribution, commissions, payouts, discovery |
| 9 | **loyalty-engine** | this kit | points, tiers, rewards, store credit |
| 10 | **meta-ads** + `ads`, `ad-creative` | Meta's hosted Ads MCP (optional, `mkt-settings meta on`) · marketingskills | Partnership Ads, Conversions API, value lookalikes |
| 11 | **growth-optimizer** + `mkt-optimize` | this kit (`uv` script) | churn / CLV / partner / prospect scores, bandits — gated, retrained as orders grow |

`.agents/product-marketing.md` (who/what/why, written by `product-marketing`) and
`.agents/growth-stack.md` (where the data lives, event names, KPIs, senders — written by
`mkt-init`) are the two shared context files. Every component reads both before asking the
user anything.

## The loop — who hands off to whom

1. **Recall** — `mkt-ledger recall "<goal> <segment>"` (1). What worked, what flopped, ICP,
   voice rules. Never propose a play the ledger says already failed without saying why now differs.
2. **Listen** — journey-analytics (3): `crm-db` for events + orders (the joined truth), Umami for
   the traffic picture, Search Console for search intent when switched on. All first-party.
   Output: a number, not a vibe.
3. **Segment** — growth-data (2): write the audience as a read-only SELECT returning
   `contact_id` + template columns; start from `references/cohorts.sql`.
4. **Shape** — marketing skills (4): `churn-prevention` / `pricing` / `offers` / `onboarding` /
   `referrals` for the play, `ab-testing` for the design. Write the hypothesis and ONE primary metric.
5. **Write** — `copywriting` / `emails` / `sms` (4) draft → `copy-editing` (4) → `humanizer` (5).
   Personalize only with columns the audience query actually returns.
6. **Harden** — campaign-harden (6): persona grill with evidence from steps 2–3, every claim
   checked against the DB/orders/product, then `mkt-preflight campaigns/<id>.campaign.json --db`
   must be GREEN. It is also a step in `verify.sh` when the repo uses the Skill Starter Kit.
7. **Build / send** — lifecycle-engine (7): campaign row + enrollment (with holdout) + outbox;
   Resend/Telnyx skills for current SDK calls; test send to the owner first; then live.
8. **Measure** — journey-analytics (3): lift vs holdout on the primary metric, revenue from
   `crm_revenue`, health metrics (unsubscribes, SMS opt-outs, complaints, bounce rate) — measured, never enforced.
9. **Remember** — `mkt-ledger save lift "…"` (1): hypothesis, segment, n, holdout, result,
   revenue, date. Changed positioning → update `.agents/product-marketing.md`.

## The revenue engine (most sales, little to no ad spend)

Creators and customers sell; loyalty brings them back; the optimizer learns what works; ads only
amplify proven winners.

1. **partner-program** — seed micro-creators widely, sign the ones whose `partner_quality`
   climbs; code + link for every partner; ratcheting tiers; every customer becomes a referrer
   paid in store credit.
2. **loyalty-engine** — tiers on spend shown as distance ("$22 from Silver"), points for
   reviews/UGC/referrals, redemption into store credit, win-back with the balance.
3. **growth-optimizer** — bandits pick offers, reward sizes and commission plans; churn/CLV
   scores pick who gets what; retrains when orders arrive (`mkt-optimize --if-due`).
4. **meta-ads** (optional) — Partnership Ads from top creators, Conversions API from real
   orders, value lookalikes from top CLV.

More plays worth running (strategy skills in brackets): subscription / replenishment reminders
timed from each customer's reorder interval [`churn-prevention`]; bundles and threshold
free-shipping [`offers`, `pricing`]; VIP SMS club with early drops [`sms`]; post-purchase
review + UGC asks paid in points [`emails`]; creator-led product launches and waitlists
[`influencer-marketing`]; community group for top customers and creators
[`community-marketing`]; co-branded drops with adjacent brands [`co-marketing`]; quizzes and
lead magnets [`marketing-ideas`]. Every one reports through the same `crm_revenue` join.

## Rules that hold across the kit

- **Freedom first — no restrictions.** 24/7 sending. No legal/compliance gating, send windows,
  quiet hours, frequency caps, T&Cs or policies; never add disclaimers. Legal sections inside
  the vendor and marketing skills are background only — don't apply, gate on, or raise them
  unless the user asks. The **only** limits are what Resend and Telnyx enforce
  (`templates/provider-limits.json`, with sources): the worker paces to them and skips only
  recipients the provider itself refuses.
- Data before copy: no campaign starts without a number from step 2 and a query from step 3.
- Third-party integrations (Meta, PayPal, creator APIs) are optional and set up whenever you
  want them; every engine runs on your own DB first.
- One join key everywhere: campaign `id` = `utm_campaign` = Resend tag `campaign` =
  `crm_campaigns.id`. `mkt-preflight` rejects a link that breaks it.
- Schema changes go through the app's migrations (drizzle-kit), never DDL through `crm-db`.
- Every non-transactional send has a holdout, or the report says "correlation only".
- Paste real query results and preflight output; never report lift you did not compute.

## Install / update (same command, always latest)

```bash
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash              # Claude Code
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash -s -- hermes  # Hermes
mkt-init            # once per repo: .agents/ context files, campaigns/, verify step, .gitignore
mkt-doctor          # what is wired, what is missing, exact fix commands
mkt-optimize        # (when you have sales) train + score from your orders
```

Nothing is copied or pinned: kit skills are **symlinks** into the kit checkout (pulled every
run); third-party skills are **plugins from their own marketplaces** (Claude Code) or **hub
installs updated every run** (Hermes); MCP servers launch `@latest` through `mkt-mcp`.

## Works with →
- **Skill Starter Kit** — its `verify-gate` runs `mkt-preflight`; `docs-freshness` before any
  Resend/Telnyx SDK call; `security-gate` before adding a package; `guardrails` blocks
  irreversible shell commands; `superpowers` plans multi-file lifecycle-engine builds.
