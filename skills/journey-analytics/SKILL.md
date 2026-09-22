---
name: journey-analytics
description: "Use when measuring or explaining the customer journey or revenue — traffic sources, landing pages, funnels, activation, retention, churn signals, feature-limit hits, campaign lift, attribution, LTV — from FIRST-PARTY data only: events the site writes to its own Postgres (crm_events), the app's own orders/payments, the self-hosted Umami dashboard, and (optional switch) Google Search Console. Covers the collector, the identity stitch, KPI definitions and holdout lift so every number traces to a query."
---

# Journey Analytics (listen → measure), first-party only

All customer data comes from **the site itself and its own databases on Railway**. No GA4,
PostHog, Segment or billing vendor. The job is to turn events and orders into statements like
*"reactivation emails lifted 7-day return by 6.1 pts vs holdout (n=412, p≈0.03), +$1,840
revenue"*, and to show the queries that produced them.

## Sources

| Source | Access | Trusted for | Status |
|--------|--------|-------------|--------|
| `crm_events` (collector `source='web'`, server facts `source='app'`) | `crm-db` MCP | traffic, sessions, landing pages, funnels, feature use, limit hits, **triggers** | core |
| `crm_revenue` (table or VIEW over the app's own orders/payments) | `crm-db` | revenue, LTV, source quality, attributed revenue | core |
| `crm_messages` / `crm_enrollments` | `crm-db` | what was sent to whom, holdout arms | core |
| Umami (self-hosted on your Railway) | `umami` MCP, read-only | the human dashboard: visitors, referrers, UTMs, pages; an independent traffic count | core, `mkt-umami deploy` |
| Google Search Console | `gsc` MCP | search queries, impressions, CTR, position (pre-click only) | **optional**, `mkt-settings gsc on\|off` |

## Setting it up in an app (once, then record it in `.agents/growth-stack.md`)
1. **Collector**: implement `references/first-party-tracking.ts`. It has three parts:
   - `lib/track.ts`: anon id, 30-minute session id, UTMs, `sendBeacon` to `/api/t`.
   - `app/api/t/route.ts`: validates, drops bots, attaches the logged-in contact, and inserts
     into `crm_events`. It stores no IP.
   - `stitchAnon()`: runs at signup/login. It links the pre-login history and sets `first_touch`.
   Keep the `marketing-kit:collector` marker; `mkt-doctor` checks for it.
2. **Server facts**: the code that performs an action writes it with `source: 'app'`, for example
   `signup.completed`, `order.paid`, `plan.changed`, `usage.limit_90pct`. Don't infer these
   from page views.
3. **Revenue**: point `crm_revenue` at the app's own orders/payments. The simplest way is a VIEW
   with `contact_id, kind, amount_cents, currency, occurred_at`.
4. **Umami**: `mkt-umami deploy`, then `mkt-umami snippet <id>`, then add
   `umami.identify(contact.id)` after login (see `references/umami.md`).
5. **Search Console** (optional): `references/search-console.md`.

## Join keys
- **Campaign**: campaign `id` = `utm_campaign` on every link = Resend tag `campaign` =
  `crm_campaigns.id`. The collector and Umami both store `utm_campaign`.
- **Person**: `crm_contacts.id`. The pre-login `anon_id` is linked through `crm_identities`
  (kind `anon_id`), and Umami `session.distinct_id` equals the contact id.

## Reports (`references/analytics.sql`; tested on Postgres)
Traffic by source (#1), landing page → signup (#2), funnel (#3), weekly retention (#4), revenue by
first-touch source (#5), campaign clicks → sessions (#6), feature adoption (#7), Umami U1/U2.
Cohorts for sending (churn risk, upsell, activation gap, lift, message volume) live in
growth-data `references/cohorts.sql`.

## KPI definitions (use these names; override in growth-stack.md)
- **Session**: consecutive events from one browser with less than 30 minutes idle (client-rolled `session_id`).
- **Activation rate**: signups reaching the activation event within 7 days, divided by signups.
- **Retention (Wn)**: share of a weekly signup cohort with any event in week n (report #4).
- **Churn risk**: a paid contact whose activity dropped at least 60% vs their own 4-week baseline.
- **Upsell signal**: `usage.limit_90pct` in the last 7 days.
- **Source quality**: 90-day revenue per first-touch source (report #5), not signups.
- **Campaign lift**: conversion rate of treated minus conversion rate of holdout, on the ONE
  primary metric in the campaign spec and inside its window. Give n per arm and a
  two-proportion z-test. Under about 100 per arm, call it "directional".
- **Attributed revenue**: treated revenue per head minus holdout revenue per head, times treated
  n. Never last-click totals alone.

## Procedure: "what's happening / did it work?"
1. State the question as a metric + segment + window. Check prior readings with
   `mkt-ledger recall "<metric> <segment>"`.
2. Query `crm-db` (and `umami` / `gsc` when relevant). Keep the exact SQL.
3. Compare to the baseline or holdout: give n, the difference, and the uncertainty.
4. Output: finding → evidence (the queries) → the decision it supports → the next test.
5. Save it with `mkt-ledger save lift|insight "…"`, including the numbers, n, window and date.

## Pitfalls
- Collector and Umami counts will differ by a few percent (bot rules, timing). If the gap
  exceeds 20%, the collector is broken or blocked; check `/api/t` responses.
- Pre-login events have `contact_id` null until `stitchAnon` runs. Count people with
  `coalesce(contact_id::text, anon_id)`.
- Money is stored in the smallest currency unit. Convert only when you display it.
- A "lift" with no holdout is a before/after comparison, so label it that way.
- At high volume, give `crm_events` a BRIN index on `occurred_at` and monthly partitions
  (growth-data).

## Works with →
- **growth-data**: schema, identities, cohort SQL, migrations.
- **campaign-harden**: supplies the evidence the persona grill asks for.
- **lifecycle-engine**: its messages and enrollments are what gets measured; triggers read `crm_events`.
- Marketing skills: `analytics` (tracking plans; implement them with the first-party collector,
  not the vendor tags it mentions), `ab-testing`, `attribution`, `revops`.
- **playbook-ledger**: results go to the ledger or they didn't happen.
