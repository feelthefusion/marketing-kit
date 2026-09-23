---
name: partner-program
description: "Use when building, running, or optimizing affiliate, creator, influencer, ambassador or customer-referral programs in the app's own CRM: partner codes and ?ref links, attribution (code beats cookie, recurring credit), tiered commissions, clawbacks on refunds, payouts (store credit, PayPal, Venmo, Cash App, Zelle), creator discovery (YouTube, Instagram, TikTok One), outreach pipeline, partner scorecards and leaderboards, QR codes, and creator links that keep their credit through an app install (mobile-growth). Execution owner — program strategy comes from influencer-marketing / referrals / co-marketing."
---

# Partner Program (creators · influencers · affiliates · customer referrals)

One engine for every "someone else sells for you" channel, in the app's own Postgres. Creators,
affiliates, ambassadors and referring customers are all rows in `crm_partners`; only their
**plan** differs. This is the low-ad-spend growth engine: you pay for sales that happened,
never for impressions.

**Strategy lives upstream; load it first:** `influencer-marketing` (finding, vetting, briefs,
deal structures), `referrals` (referral loops, double-sided rewards), `co-marketing`,
`community-marketing`, `offers`, `marketing-psychology`. This skill is the engine they run on.

## Engine (all tested: tests/run.sh "programs")

| Piece | File | What it does |
|---|---|---|
| Schema | growth-data `references/crm-schema.ts` | plans, partners, codes, attributions, commissions, payouts, store credit, prospects |
| Tracking | `references/partner-tracking.ts` | `?ref=` cookie + `partner.clicked`, `/r/<code>` short links (carry `utm_*`), `partnerQr()` printable QR of the same link (SVG / PNG, `utm_source=qr`), `attributeOrder()` inside the order transaction |
| Money | `references/partner.sql` | 1 accrue (tier rate at order time) · 2 claw back refunds proportionally · 3 approve after hold · 4 payable · 5 scorecard |
| Payouts | `references/payouts.ts` | store credit (instant) · PayPal + Venmo (Payouts API, one idempotent batch) · Cash App + Zelle (pay sheet + `markPaid`) |
| Discovery | `references/creator-discovery.ts` | YouTube Data API, Instagram business_discovery, TikTok One → `crm_creator_prospects` |

Wire-up order in an app: migrate schema → copy `partner.sql` to `sql/` → `captureRef()` on every
page → `previewCode()` at checkout → `attributeOrder()` + `settle()` in the order.paid handler →
`settle()` after every refund (refund row has `parent_id` = order) → payouts when you choose.
Everything is idempotent: replayed webhooks and retries never double-pay.

**Attribution rules** (per plan, nothing hard-coded): typed code wins → fresh `?ref` cookie inside
`cookie_days` → repeat order from a customer the partner brought, inside `recurring_months`.
A partner buying through their own code isn't attributed.

## Techniques that drive most sales (apply in this order)

1. **Code + link, always both.** Creators' audiences type codes they heard in a video; links
   die in bios and stories. Each partner gets a vanity code (`MAYA`) *and* `/r/maya`, plus a QR of
   the same link (`/r/maya/qr`) for packaging, stickers, events and on-screen in videos. The code
   gives the audience a discount (`customer_discount_bps`) — that's the reason to use it.
2. **Tiered commission that ratchets** (`tiers` on the plan: e.g. 10% → 15% at $1k/30 days →
   20% at $5k). Creators push harder when the next tier is close; `partner.sql` pays the tier
   reached *at the time of each order*. Announce tier-ups by SMS the moment they happen.
3. **Pay for new customers more than repeats.** `flat_cents` CPA bonus on first orders +
   `recurring_months` so the creator earns on the customer's repeats too — they'll promote
   the product, not just a one-time deal.
4. **Seed widely, sign narrowly.** Send product to many micro-creators (5k–100k, high
   engagement); give contracts, custom codes and higher tiers only to those whose
   `partner_quality` climbs. Micro-creators beat celebrities on cost per sale.
5. **Every customer is a partner.** Auto-create a `customer` partner with `store_credit` payout
   after the first delivered order; double-sided reward (friend gets the discount, referrer
   gets credit). Store credit costs you margin, not cash, and it pulls the referrer back.
6. **Whitelist the winners into ads.** Top creators' posts become Meta Partnership Ads
   (skill `meta-ads`): their content, their handle, your budget — the best-performing
   creative in paid social, and they earn commission on the resulting sales.
7. **Leaderboards + drops.** Monthly leaderboard (scorecard query), early product access for
   top tiers, a private creator group. Status is a cheaper motivator than rate.
8. **Content rights.** Ask every paid creator for usage rights; their videos are your ad and
   email creative library.
9. **Fast, frequent payouts.** Venmo/PayPal the day commissions clear the hold. Payout speed is
   the #1 thing creators talk about to each other.

## Discovery → outreach → signed (one pipeline)

`creator-discovery.ts` fills `crm_creator_prospects`; growth-optimizer scores `fit_score` from
the outcomes of partners you've already signed (heuristic until 15 have results). Outreach runs
through lifecycle-engine (email/SMS sequences, `crm_campaigns`), stage moves
`found → contacted → replied → negotiating → signed`; on signing create the `crm_partners` row
with `prospect_id` so the model learns what a great creator looks like.

## Measure

Scorecard (`partner.sql` §5): orders, new customers, net, commission, clawback %, 90-day repeat
revenue from referred customers, net per click, return per commission dollar. Rank by
growth-optimizer's `partner_quality` (shrunk, so one lucky order doesn't crown anyone).
Save what worked with `mkt-ledger save`.

## Setup later (optional; the engine runs without any of it)

App env vars (Railway), each only when you use that piece:
`PAYPAL_CLIENT_ID` · `PAYPAL_CLIENT_SECRET` · `PAYPAL_ENV=live` · `PAYPAL_WEBHOOK_ID` (webhook →
`/api/webhooks/paypal`, events `PAYMENT.PAYOUTS-ITEM.*`) · `YOUTUBE_API_KEY` ·
`IG_USER_ID` + `META_GRAPH_TOKEN` · `TIKTOK_TTO_TOKEN` + `TIKTOK_TTO_ACCOUNT_ID`.
Without them: store credit works, Cash App/Zelle sheets work, prospects can be added by hand
or through a `/partners/apply` form.

Provider limits (`templates/provider-limits.json`): PayPal 15,000 items/batch, `sender_batch_id`
deduped 30 days; YouTube 10,000 units/day (search = 100); TikTok One page size ≤ 200.

## Works with →
- **loyalty-engine** — store-credit payouts and referral points share its ledgers.
- **growth-optimizer** — `partner_quality`, `prospect_fit`, bandits over commission plans.
- **meta-ads** — Partnership Ads from top creators; Conversions API carries `partner_code`.
- **lifecycle-engine** — creator outreach sequences, tier-up and payout notifications.
