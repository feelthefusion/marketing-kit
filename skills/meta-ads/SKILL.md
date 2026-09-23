---
name: meta-ads
description: "Use when planning, launching, analyzing or optimizing Facebook/Instagram ads: Meta's official Ads MCP (read + create/edit/pause campaigns, budgets, audiences, creative), Partnership Ads with creators, Conversions API from the app's own orders, custom and lookalike audiences from CRM segments and CLV scores, creative testing, and incrementality."
---

# Meta Ads (official Ads MCP + your first-party data)

Ads amplify what already sells through creators and loyalty — they don't replace it. Meta's own
hosted MCP server (`https://mcp.facebook.com/ads`) gives the agent full read **and write**:
create, edit, pause, budgets, audiences, creative. Your orders feed Meta's delivery model through
the Conversions API, so it optimizes on real sales.

**Strategy upstream:** `ads` (platform playbooks, 2026 Meta structure), `ad-creative`
(hooks, formats, iteration), `influencer-marketing` (creator content), `attribution`,
`ab-testing`.

## Setup later (optional — the kit installs fine without it)

1. developers.facebook.com/apps → create or open an app → note the **App ID** (public).
2. For Hermes: add `http://localhost:27890/callback` as a valid OAuth redirect URI.
3. `META_APP_ID=<id>` in `~/.config/marketing-kit/secrets.env` → `mkt-settings meta on`.
4. Claude Code: `/mcp` → meta-ads → Authenticate. Hermes: `hermes mcp login meta-ads`.
   (Owning an app isn't strictly required; Meta's "AI connectors" business help page has a
   no-app path.)
5. Conversions API (app env on Railway, when you want it): `META_PIXEL_ID`, `META_CAPI_TOKEN`
   (system-user token), optional `META_TEST_EVENT_CODE`, `META_GRAPH_VERSION` (default v26.0).

## Engine

- `references/meta-capi.ts` — `sendPurchase()` from the order.paid handler: event_id = order id
  (the browser Pixel fires the same eventID → deduplicated), SHA-256 hashed email/phone/name/
  external_id, `fbp`/`fbc`, value, contents, and `partner_code` so creator-driven sales are
  visible inside Meta.
- Audiences come from growth-data SQL: export a segment, hash, and push through the MCP.

## Techniques (highest leverage first)

1. **Partnership Ads from your top creators** (partner-program scorecard → top 5 by
   `partner_quality`). Creator handle + creator content + your budget consistently outperforms
   brand creative; the creator earns commission on the sales too.
2. **Feed it real conversions.** CAPI Purchase with value on every order; without it the
   algorithm is optimizing on guesses.
3. **Value-based lookalikes** from growth-optimizer's `clv` scores (top 10–20% of customers
   by predicted value), not "all purchasers".
4. **Broad targeting + creative as the targeting.** Few campaigns, Advantage+ placements, many
   creatives; kill losers fast, scale winners by budget, refresh before fatigue.
5. **Exclude who you don't need to pay for**: current loyalty members inside the repeat window,
   recent purchasers — reach them through email/SMS for free.
6. **Retarget with the offer that already won** in growth-optimizer's bandits (welcome offer,
   bundle), and with creator UGC.
7. **Incrementality, not platform ROAS.** Compare against a holdout (Meta conversion-lift via
   the MCP, or a geo split) and against first-party revenue in `crm_revenue`
   (`utm_campaign` = campaign id). Platform-reported ROAS double-counts creator and email sales.

Meta enforces its own ad policies on what it will run; that's a provider limit. Creator,
loyalty and owned channels aren't subject to it.

## Works with →
- **partner-program** — creator content and handles for Partnership Ads.
- **growth-optimizer** — CLV scores for lookalikes, churn scores for exclusions/retargeting.
- **journey-analytics** — first-party revenue per `utm_campaign` is the scoreboard.
