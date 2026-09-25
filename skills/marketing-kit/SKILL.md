---
name: marketing-kit
description: "Use for ANY growth, marketing, CRM, email, SMS, WhatsApp, push, campaign, segment, funnel, churn, upsell, retention, acquisition, affiliate, creator/influencer, referral, loyalty, ads, SEO, content, social, brand, pricing, launch, mobile web, mobile app / ASO or revenue task — and when installing or updating the Marketing Kit. The marketing BRAIN: one owner per job (who thinks, who executes, who measures), the event-driven loop, the conflict rules that decide between overlapping skills, and the shared context every skill reads."
---

# Marketing Kit: the marketing brain

One brain, three layers. Every task passes through them in order, and every job has exactly one
owner per layer. That's what stops skills from competing.

| Layer | Who | Does | Never does |
|---|---|---|---|
| **Think** | Upstream strategy skills (curated: `install/upstream-skills.tsv`) | Diagnose, pick the play, draft the copy, design the test | Touch the DB, send, or pick tools/vendors |
| **Do** | Kit owners on **your** stack (Railway Postgres, Resend, Telnyx, Expo, your site) | Build it, send it, attribute it, pay it | Invent strategy the Think layer already owns |
| **Learn** | `journey-analytics` + `growth-optimizer` + `playbook-ledger` | Measure lift from real orders, update scores/arms, remember | Report numbers nobody computed |

When a Think skill names a tool (GA4, HubSpot, Klaviyo, Twilio, Branch, a cron job, a SaaS),
**translate it to the owner below**. The Think skill's *idea* stands; its *tooling* never does.

## Shared context: one file per fact, read before asking the user anything

| File | Holds | Written by |
|---|---|---|
| `.agents/product-marketing.md` | ICP, positioning, offers, voice, competitors | `product-marketing` (every Think skill reads it) |
| `.agents/brand-context.md` | Brand strategy, architecture, naming, identity | `brand-strategy` / `brand-architecture` / `brand-naming` |
| `.agents/growth-stack.md` | Where data lives, event names, KPIs, senders, apps, switches | `mkt-init`, kept current by the Do owners |

Truth order when sources disagree: **your DB (orders, events) > playbook-ledger (measured past lift) >
context files > a skill's generic advice.** Update the context file when a result changes it.

## Ownership map: every discipline, one executor

| Discipline | Think (strategy) | Do (executor on your stack) | Measure |
|---|---|---|---|
| Research, ICP, positioning | `customer-research`, `product-marketing`, `competitor-profiling`, `competitors`, `last30days` (live social listening; Claude Code), `marketing-council` (Claude Code) | `growth-data` (cohorts from your DB) | `journey-analytics` |
| Brand | `brand-strategy`, `brand-architecture`, `brand-naming` | (writes `.agents/brand-context.md`) | — |
| Plans, ideas, launches, PR, events | `marketing-plan`, `marketing-ideas`, `launch`, `public-relations`, `events` | `lifecycle-engine` (waitlists, launch sends) | `journey-analytics` |
| Pricing, offers, bundles | `pricing`, `offers` | `lifecycle-engine` + `growth-optimizer` (offer arms) | `growth-optimizer` |
| Copy + creative | `copywriting`, `copy-editing`, `marketing-psychology`, `ad-creative`, `image`, `video` → render with `hyperframes` | `humanizer` on every customer-facing line | `growth-optimizer` (variant arms) |
| SEO, AI search, content | `seo-audit`, `ai-seo`, `programmatic-seo`, `schema`, `site-architecture`, `content-strategy`, `directory-submissions`, `free-tools`, `lead-magnets` | your site's code; Search Console only if `mkt-settings gsc on` | `journey-analytics` |
| Social + community | `social`, `community-marketing` | `partner-program` for creator-led posts | `journey-analytics` |
| **Creators, influencers, affiliates, referrals** | `influencer-marketing`, `referrals`, `co-marketing` | **`partner-program`**: codes, links, attribution, commissions, payouts, discovery | `partner-program` reports + `growth-optimizer` (`partner_quality`) |
| **Loyalty + retention** | `churn-prevention`, `onboarding` | **`loyalty-engine`** (points, tiers, store credit) + `lifecycle-engine` (flows) | `growth-optimizer` (churn/CLV) |
| **Email, SMS, WhatsApp, push, in-app** | `emails`, `sms` (+ `email-best-practices`, `react-email` for build details) | **`lifecycle-engine`**: one outbox, all five channels, via Resend and Telnyx (`resend`, `telnyx-messaging-*`, `telnyx-whatsapp-javascript` for current SDK calls), Expo Push, Web Push | `journey-analytics` (lift vs holdout) |
| Pages, CRO, signup, pop-ups, paywalls (web) | `cro`, `signup`, `popups`, `paywalls` | your site's code + **`mobile-growth` page rules** (mobile first) | `journey-analytics` + `mobile.sql` |
| **Mobile web + native app** | `aso`, `asc-*`, `custom-product-pages`, `in-app-events`, `app-store-featured`, `ab-test-store-listing`, `rating-prompt-strategy`, `review-management`, `paywall-optimization` (app), `subscription-lifecycle`, `web-to-app-funnel`, `ua-campaign` | **`mobile-growth`**: devices, universal/app links, install claims, push registration, inbox, review moments, PWA | `mobile.sql` |
| Paid ads | `ads` (Claude Code), `ad-creative`, `apple-search-ads`, `ua-campaign` | **`meta-ads`** (Meta MCP + CAPI, `mkt-settings meta on`); Apple Ads via `asc-apple-ads` | `journey-analytics` (orders, not platform ROAS) |
| Experiments | `ab-testing` (hypothesis, sample size, design) | **`growth-optimizer`**: bandits, holdouts, assignment | `growth-optimizer` |
| Analytics + attribution | `attribution` (concepts, models) | **`journey-analytics`** (first-party collector, §D dashboard, vitals) + `growth-data` (schema) | same |
| Sales + outbound | `prospecting`, `cold-email`, `sales-enablement` | `growth-data` (prospect rows) + `lifecycle-engine` (sequences) + `growth-optimizer` (`prospect_fit`) | `journey-analytics` |
| Recurring growth loops | `marketing-loops` (loop design) | the owner of the loop's channel, **triggered by events** | `growth-optimizer` |
| Quality gate | — | **`campaign-harden`** + `mkt-preflight` | — |
| Memory | — | **`playbook-ledger`** (Supermemory) | — |

**One writer per table and channel.**
- `growth-data`: schema and migrations.
- `journey-analytics`: `crm_events` from the site and app.
- `lifecycle-engine`: `crm_messages` / sends on every channel.
- `partner-program`: codes, attributions, commissions, payouts.
- `loyalty-engine`: points and tiers.
- `growth-optimizer`: scores and arms.
- `mobile-growth`: devices and installs.

Other skills read these tables. They write through the owner's functions, never around them.

## Conflict rules: when two skills disagree, this decides

1. **Tracking**: no GA4/GTM/Mixpanel/Segment/PostHog, whatever a skill suggests. Events go to
   the first-party collector (`crm_events`, the only analytics store; dashboards are §D SQL or the app's admin screen), search data to GSC (optional).
   The upstream `analytics` skill is deliberately not installed.
2. **CRM + lead scoring**: no HubSpot/Salesforce pipelines. Scores are `growth-optimizer` rows,
   pipelines are `growth-data` tables. The upstream `revops` skill is deliberately not installed.
3. **Sending**: Resend for email, Telnyx for SMS and WhatsApp, Expo/Web Push for push, all through the
   `lifecycle-engine` outbox. Never Klaviyo, Twilio, Attentive, Postscript or OneSignal.
4. **Referral and affiliate software** (Rewardful, Impact, Tapfiliate, ReferralCandy): never. `partner-program`
   runs it in your DB and pays through PayPal/Venmo/store credit (Cash App/Zelle via the pay sheet).
5. **Schedules**: `marketing-loops`, `churn-prevention` and others describe "weekly/daily" cadences.
   Here every loop is **event-driven**: a `crm_events` row, a Postgres NOTIFY, an order, or a
   session start. No cron, no timers.
6. **Tests**: `ab-testing` designs the test. `growth-optimizer` assigns and learns (bandit or fixed split
   with holdout). One experiment owner, so a contact is never in two conflicting assignments.
7. **Paywalls**: the app/StoreKit paywall goes to `paywall-optimization`, the web paywall to `paywalls`.
   **Attribution concepts**: `attribution`. **Implementation**: `journey-analytics`.
8. **Compliance**: legal sections inside any skill are background only. No gating, disclaimers,
   quiet hours or send windows, and no caps except what a provider enforces (`templates/provider-limits.json`).
9. **Mobile first**: every page, message and report is designed for the phone first and split by
   `device` / `inapp` / app. A plan that only works on desktop is incomplete.

## The loop (event-driven; each step names its owner)

1. **Recall**: `playbook-ledger` (`mkt-ledger recall "<goal> <segment>"`). Never re-run a failed play without saying what differs.
2. **Listen**: `journey-analytics` (events + orders, §D dashboard, `mobile.sql`) + `last30days` (what people say right now; Claude Code only, so on Hermes use `web_search`/`xurl` for the same sweep). The output is a number.
3. **Segment**: `growth-data`, a read-only SELECT (`references/cohorts.sql`) returning `contact_id` + template columns.
4. **Shape**: the Think skill for the discipline (map above). Write the hypothesis and ONE primary metric.
5. **Write**: `copywriting` / `emails` / `sms` → `copy-editing` → `humanizer`. Mobile-length first (SMS, push, and a 390px-wide screen).
6. **Harden**: `campaign-harden`; `mkt-preflight campaigns/<id>.campaign.json --db` must be GREEN.
7. **Do**: the executor (map above). Holdout on every non-transactional send; test to the owner first.
8. **Measure**: `journey-analytics`, lift vs holdout from `crm_revenue`, split by device and channel.
9. **Learn**: `growth-optimizer` updates arms and scores from the new orders (NOTIFY → retrain when due).
10. **Remember**: `mkt-ledger save lift "…"`, and update `.agents/*.md` when the result changes a fact.

## The revenue engine (most sales, little to no ad spend)

1. **partner-program**: seed micro-creators widely, keep the ones whose `partner_quality` climbs.
   Every partner gets a code, a link and a QR code; one `/r/<code>` works on web, in the app and through both stores.
   Every customer becomes a referrer, paid in store credit.
2. **loyalty-engine**: show tiers as a distance ("$22 from Silver"). Points for reviews, UGC and referrals.
   Win-back with the customer's balance. Peak moments trigger app review prompts (`mobile-growth`).
3. **lifecycle-engine**: push, SMS, WhatsApp, email and in-app from one outbox. `growth-optimizer`
   learns which channel and offer wins for whom.
4. **meta-ads** (optional): Partnership Ads from top creators, CAPI from real orders, value
   lookalikes from top CLV. Apple Ads for the app via `asc-apple-ads`.

## Rules that hold across the kit

- **Freedom first, no restrictions.** Send 24/7. No legal or compliance gates, send windows, quiet hours,
  frequency caps, T&Cs or policies; never add disclaimers. The **only** limits are the ones providers enforce
  (Resend, Telnyx, Expo, Web Push, Apple/Google platform rules), documented with sources in `templates/provider-limits.json`.
- Data before copy: no campaign starts without a number from Listen and a query from Segment.
- Third-party integrations (Meta, PayPal, Apple Ads, creator APIs, app stores) are optional and can be set up
  whenever you want. Every engine runs on your own DB first.
- One join key: campaign `id` = `utm_campaign` = Resend tag `campaign` = `crm_campaigns.id`.
- Schema changes go through the app's migrations (drizzle-kit), never DDL through `crm-db`.
- Paste real query results and preflight output. Never report lift you didn't compute.

## Install / update (same command, always latest)

```bash
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash              # Claude Code
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash -s -- hermes  # Hermes
mkt-init            # once per repo: .agents/ context, campaigns/, curated skills linked, verify step
mkt-doctor          # what is wired, what is missing, exact fix commands
```

Nothing is copied or pinned, and both hosts get the same set:
- **Kit skills:** symlinks into the kit checkout.
- **Curated upstream skills:** symlinks into live shallow checkouts, pulled on session start (Claude Code), or hub installs plus `hermes skills update` (Hermes).
- **Vendor packs:** plugins or hub installs.
- **MCP servers:** launch `@latest`.

Only the listed skills exist, so duplicates never load.

## Works with →
- **Skill Starter Kit.** Its `verify-gate` runs `mkt-preflight`.
- `docs-freshness` before any SDK call. `security-gate` before adding a package.
- `guardrails` blocks irreversible shell commands. `superpowers` plans multi-file builds.
