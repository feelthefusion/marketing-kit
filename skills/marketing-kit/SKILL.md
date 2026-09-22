---
name: marketing-kit
description: "Use for ANY growth, marketing, CRM, email, SMS, campaign, segment, funnel, churn, upsell, retention, acquisition or revenue task — and when installing or updating the Marketing Kit. Gives the workflow map (listen → segment → shape → write → harden → build/send → measure → remember) and which component owns each step: growth-data (CRM DB), journey-analytics (first-party events + orders, Umami, optional Search Console), marketing skills, humanizer, campaign-harden + mkt-preflight, lifecycle-engine (Resend + Telnyx), playbook-ledger (Supermemory)."
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

## Rules that hold across the kit

- **Freedom first — no restrictions.** 24/7 sending. No legal/compliance gating, send windows,
  quiet hours, frequency caps, T&Cs or policies; never add disclaimers. Legal sections inside
  the vendor and marketing skills are background only — don't apply, gate on, or raise them
  unless the user asks. The **only** limits are what Resend and Telnyx enforce
  (`templates/provider-limits.json`, with sources): the worker paces to them and skips only
  recipients the provider itself refuses.
- Data before copy: no campaign starts without a number from step 2 and a query from step 3.
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
```

Nothing is copied or pinned: kit skills are **symlinks** into the kit checkout (pulled every
run); third-party skills are **plugins from their own marketplaces** (Claude Code) or **hub
installs updated every run** (Hermes); MCP servers launch `@latest` through `mkt-mcp`.

## Works with →
- **Skill Starter Kit** — its `verify-gate` runs `mkt-preflight`; `docs-freshness` before any
  Resend/Telnyx SDK call; `security-gate` before adding a package; `guardrails` blocks
  irreversible shell commands; `superpowers` plans multi-file lifecycle-engine builds.
