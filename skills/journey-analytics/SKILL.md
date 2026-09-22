---
name: journey-analytics
description: "Use when measuring or explaining the customer journey or revenue — traffic sources, search intent, funnels, activation, retention, churn signals, feature-limit hits, cohort behavior, campaign lift, attribution, MRR/LTV — across GA4, Search Console, PostHog, Stripe and the CRM database. Defines the one join key, the identity stitch, KPI definitions, and holdout-based lift so every number traces to a query."
---

# Journey Analytics (listen → measure)

Four sources, one person, one campaign key. The job is to turn "traffic", "events" and
"payments" into statements like *"reactivation emails lifted 7-day return by 6.1 pts vs
holdout (n=412, p≈0.03), +$1,840 MRR"* — with the queries that produced them.

## Sources and what each is trusted for

| Source | MCP | Trusted for | Not for |
|--------|-----|-------------|---------|
| GA4 | `ga4` (official `analytics-mcp`): `run_report`, `run_realtime_report`, `get_property_details` | acquisition source/medium/campaign, landing pages, pre-signup funnel | per-user revenue (sampling, consent gaps) |
| Search Console | `gsc` (`mcp-search-console`) | queries, impressions, CTR, position per page | anything post-click |
| PostHog | `posthog` (official hosted MCP / plugin) | in-app behavior, funnels, retention, cohorts, feature flags, experiments | money |
| Stripe | `stripe` (official hosted MCP / plugin) | subscriptions, invoices, MRR movement, refunds | behavior |
| CRM DB | `crm-db` | the joined truth: contacts, identities, messages, enrollments, `crm_revenue` | — |

## The join (set this up once per app, record it in `.agents/growth-stack.md`)

- **Campaign key**: campaign `id` = `utm_campaign` on every link = Resend tag `campaign` =
  `crm_campaigns.id`. GA4 and PostHog both capture UTMs, so every source can group by it.
- **Person key**: `crm_contacts.id` ↔ `crm_identities` (`posthog_distinct_id`, `ga_client_id`,
  `stripe_customer`). Wire it in the app: PostHog `identify(contact_id)` at login; GA4 `user_id`
  = contact_id; Stripe `metadata.contact_id` on customer creation; first/last touch UTMs saved
  onto `crm_contacts.first_touch` at signup.
- **Behavior into the CRM**: app events (and PostHog events you act on) land in `crm_events` —
  trigger rules run on the DB, not on a dashboard.

## KPI definitions (use these names; override in growth-stack.md)

- **Activation rate** — signups reaching the activation event within 7 days / signups.
- **Retention (Wn)** — PostHog retention insight on the activation event; report W1/W4/W8.
- **Churn risk** — paid + ≥60% activity drop vs own 4-week baseline (cohorts.sql #1).
- **Upsell signal** — `usage.limit_90pct` in the last 7 days (cohorts.sql #2).
- **Net MRR** — Σ `crm_revenue.mrr_delta_cents` by kind (new, expansion, contraction, churn).
- **Source quality** — 90-day revenue per first-touch source (cohorts.sql #4), not signups.
- **Campaign lift** — (conversion treated − conversion holdout) on the ONE primary metric in
  the campaign spec, inside its window (cohorts.sql #5). Report n per arm and a two-proportion
  z-test; under ~100 per arm say "directional".
- **Attributed revenue** — revenue from a contact within the campaign window after their
  first delivered message, minus the holdout arm's revenue per head × treated n. Never
  last-click totals alone.

## Procedure — "what's happening / did it work?"

1. State the question as a metric + segment + window. Recall prior readings:
   `mkt-ledger recall "<metric> <segment>"`.
2. Pull each source with its MCP; save raw numbers with the query/report params used.
3. Join in the DB (identities) — not in your head. Paste the SQL.
4. Compare to the baseline or holdout; give n, the difference, and the uncertainty.
5. Output: finding → evidence (queries) → decision it supports → next test.
6. `mkt-ledger save lift|insight "…"` with the numbers, n, window, date.

## Pitfalls

- GA4 `(not set)` / consent gaps undercount; never reconcile GA4 users to DB contacts 1:1.
- PostHog person merges: use `distinct_id` stitched through `crm_identities`, not email.
- Stripe amounts are in the smallest currency unit; MRR for annual plans ÷ 12.
- A "lift" with no holdout is a before/after — label it so.

## Works with →
- **growth-data** — schema, identity tables, cohort SQL.
- **campaign-harden** — supplies the evidence the persona grill demands.
- **lifecycle-engine** — its messages/enrollments are what gets measured.
- Marketing skills: `analytics` (tracking plans), `attribution`, `ab-testing`, `revops`.
- **playbook-ledger** — results go to the ledger or they did not happen.
