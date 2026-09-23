# Marketing Kit

A growth-engine skill stack for **Claude Code** and **Hermes** that fits apps which **own their
CRM**: Postgres on Railway (Drizzle), email through **Resend**, SMS + WhatsApp through **Telnyx**,
push through **Expo Push / Web Push**, mobile web and Expo apps treated as first-class. There's no
third-party CRM, analytics or automation SaaS. **Every customer number comes from the site
itself and its own databases**: events the site writes to its own Postgres, its own
orders/payments, and a self-hosted Umami dashboard. The agent writes copy against that data and
ships campaigns through your own code.

Sibling of [skill-starter-kit](https://github.com/feelthefusion/skill-starter-kit). Starter Kit is
for building software; Marketing Kit is for growing it. They hand off to each other: the Starter
Kit's `verify.sh` gate also runs the campaign preflight.

## Install (the same command updates)

```bash
# Claude Code
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash
# Hermes
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash -s -- hermes
# both
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash -s -- both
```

Then, in each app repo:

```bash
mkt-init        # .agents/growth-stack.md (auto-drafted), campaigns/, verify step, gitignore
mkt-doctor      # every gap on this machine and in this repo, with the fix command
```

### Always latest, never a copy

| What | How it stays live |
|------|-------------------|
| Kit skills (11) | **symlinked** from `~/.marketing-kit`, which bootstrap `git pull`s every run |
| Curated upstream skills (73) | one list for both hosts, [`install/upstream-skills.tsv`](install/upstream-skills.tsv). Claude Code: shallow **live checkouts** (pulled on session start) **symlinked per repo** by `mkt-init`. Hermes: hub installs + `hermes skills update`. Only listed skills exist, so nothing duplicates. (Claude Code can't switch off single skills inside a plugin, so whole packs can't be curated.) |
| Vendor packs | Resend, Telnyx (SMS + WhatsApp), Hyperframes, Humanizer. Claude Code: **plugins from each vendor's own marketplace**, updated every run. Hermes: **hub installs from the vendor repo** |
| Context budget | Marketing skills load **per repo** (`mkt-init` links them into `.claude/skills`, git-excluded), so coding-only sessions don't pay for them |
| MCP servers | `mkt-mcp <name>` runs `npx pkg@latest` / `uvx pkg@latest` on every launch |
| Supermemory | the official installer; an existing server (e.g. from Starter Kit) gets reused |

This repo contains no vendored third-party skill.

## Freedom first

Sending is **24/7 with no restrictions**. The kit has no legal or compliance gating, no send
windows or quiet hours, no frequency caps, and no terms or policies. The agent is told to treat
legal notes inside vendor skills as background only.

The **only** limits are the ones the providers enforce themselves (Resend, Telnyx, Expo, Web Push, WhatsApp, Apple/Google). They are listed with
source links in [`templates/provider-limits.json`](templates/provider-limits.json), and the
outbox worker paces to them exactly.

| Provider | What it enforces | What the kit does |
|---|---|---|
| Resend | 10 req/s per team, batch ≤100 emails (= 1 request), ≤50 recipients/email, key ≤256 chars; free plan 100/day + 3,000/month | batches every send (≈1,000 emails/s), waits out 429s, holds quota stops until they reset (00:00 UTC / next month) |
| Resend | won't deliver to hard-bounced or spam-complaint addresses | skips them (they'd fail) |
| Telnyx | 50 SMS/s per account; toll-free 20/s, short code 1,000/s, US long code = your 10DLC class; 4h queue | paces per number + account (`TELNYX_SENDER_MPS` for 10DLC) |
| Telnyx | ≤10 segments (40302), MMS ≤10 media/1 MB (40317), refuses STOP'd (40300) and non-routable (40001) numbers | preflight catches size limits; the worker records refusals so it stops paying to retry |
| WhatsApp (via Telnyx) | 80 msg/s per number (up to 1,000); 250 → 2K → 10K → 100K → unlimited unique people per 24h outside the service window; templates only outside it (40008) | paces per number (`WHATSAPP_MPS`), sends `payload.template` when set |
| Expo Push | ≤100 per request, 4096-byte payload, receipts after ~15 min, `DeviceNotRegistered` | SDK chunks; the worker checks receipts in its loop and revokes dead tokens |
| Web Push | bodies ≤4096 bytes guaranteed (RFC 8030); 404/410 = gone; iPhone only for Home Screen web apps (iOS 16.4+) | encrypts + VAPID-signs, revokes gone subscriptions, retries 429 |
| Apple | review prompt shown ≤3× per 365 days; AdServices token valid 24h | `reviewMoment()` spends the prompts on peak moments only |

`send.exclude` overrides the skip list per campaign, and `[]` skips nothing.


## One marketing brain

Every task passes three layers, and each job has **one** owner per layer
([`skills/marketing-kit/SKILL.md`](skills/marketing-kit/SKILL.md)):

| Layer | Who | Does |
|---|---|---|
| Think | 73 curated strategy skills: [marketingskills](https://github.com/coreyhaines31/marketingskills) (48), [appeeky/aso-skills](https://github.com/appeeky/aso-skills) (11), [rorkai asc skills](https://github.com/rorkai/app-store-connect-cli-skills) (10, Apple's API), brand (3), [last30days](https://github.com/mvanhorn/last30days-skill) (live social listening) | diagnose, pick the play, draft, design the test |
| Do | the kit's owners on **your** stack | build, send, attribute, pay: `lifecycle-engine`, `partner-program`, `loyalty-engine`, `mobile-growth`, `meta-ads` |
| Learn | `journey-analytics` · `growth-optimizer` · `playbook-ledger` | lift from real orders, scores/arms, memory |

- **One writer per table and channel.** For example, only `lifecycle-engine` sends, and only `partner-program` writes commissions.
- **Conflict rules decide overlaps.** When a strategy skill names GA4, HubSpot, Klaviyo, Twilio, Branch or a cron job, the idea stands and the tool is translated to the owner.
- **Two competing upstream skills are deliberately not installed:** `analytics` (GA4-first) and `revops` (HubSpot-first).
- **`tests/brain_check.py` fails the build if:** the map names a skill that isn't installed, two installed skills share a name, or a kit skill has no owner.

## Mobile first: mobile web and the app

| Lane | What ships |
|---|---|
| Mobile web (every site) | device / OS / in-app browser (Instagram, TikTok…) / PWA on every event; real-user Core Web Vitals; PWA + Web Push; mobile page rules (thumb-zone CTA, wallet pay, inputs, no intrusive interstitials); smart app banner; tap-to-text / WhatsApp |
| Native app (Expo) | universal links + app links (`/r/<code>` opens the app); install claims that keep the creator's credit (Play install referrer, app link, code, clipboard) feeding the same `attributeOrder()`; Expo Push; in-app inbox; review moments; Apple Ads + AdAttributionKit copies |
| Both | `mobile.sql`: device mix, in-app browsers, vitals p75, checkout drop-off, PWA retention, installs by creator, push reach, channel scoreboard, web→app handoff |

## Living updates (always latest, no timers)

Every install pulls the latest kit and fetches every component live (vendor marketplaces, `hermes skills` hub, `npx`/`uvx …@latest`). After that the kit keeps itself current **on events, never on a schedule**:

| Event | What happens |
|---|---|
| You open a Claude Code or Hermes session | `SessionStart` / `on_session_start` → `mkt-update --hook`: returns instantly; in the background one `git ls-remote` per upstream (kit, each vendor marketplace, each hub-skill source, Umami releases) finds what moved and updates **only that**, then re-syncs the repo you opened. The next session is told what changed. |
| You push to this kit's `main` | GitHub webhook → `notify-projects.yml` → `repository_dispatch` to every registered project → its `marketing-kit-sync.yml` re-syncs with the latest kit and opens one PR (none if nothing managed changed). |
| Umami cuts a release | redeployed from the latest image on your next session (`railway redeploy --from-source`). |
| MCP servers | nothing to do: they launch `pkg@latest` every time. |

Vendor upstreams can't send webhooks — GitHub only delivers them to a repo's admins, and npm/PyPI have none — so for those the session start **is** the event.

```bash
mkt-update --status            # every component, upstream revision, last check
mkt-update                     # check + apply now
mkt-webhooks token             # once: token the kit repo uses to dispatch (Contents: read & write on your projects)
cd ~/Dropbox/APPS/helix && mkt-init && mkt-webhooks add     # register a project for kit-push PRs
MKT_UPDATE=off                 # disable
```

## The stack

| # | Component | Source | Role |
|---|-----------|--------|------|
| 1 | **playbook-ledger** + Supermemory | local server `:6767` · `mkt-ledger` | ICPs, voice, offers, campaign lift, seasonal plays. Recalled first, saved last. Shared by both hosts |
| 2 | **growth-data** + `crm-db` + `railway` MCP | [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) · Railway CLI `railway mcp` | CRM schema (Drizzle reference), identity stitching, cohort SQL. Resolves **the current repo's** DB. Read-only by default |
| 3 | **journey-analytics** + first-party collector + `umami` MCP · optional `gsc` | this kit (collector: `/api/t` → `crm_events`) · [umami-software/umami](https://github.com/umami-software/umami) self-hosted on your Railway (`ghcr.io/…/umami:latest`) · [AminForou/mcp-gsc](https://github.com/AminForou/mcp-gsc) behind a switch | traffic → behavior → revenue from your own data, one join key, holdout-based lift |
| 4 | Curated strategy skills (73) | `install/upstream-skills.tsv`: marketingskills, appeeky ASO, rorkai App Store Connect, brand, last30days | strategy + drafts for every discipline (see *One marketing brain*) |
| 5 | Humanizer | [blader/humanizer](https://github.com/blader/humanizer) (Hermes: bundled port) | strips AI tells from customer-facing copy |
| 6 | **campaign-harden** + `mkt-preflight` | this kit | persona grill with evidence, claim check, and a deterministic gate for schema, variables, UTMs and SMS segments |
| 7 | **lifecycle-engine** + Resend + Telnyx + Expo/Web Push | [resend/resend-skills](https://github.com/resend/resend-skills) (official, hosted MCP) · [team-telnyx/ai](https://github.com/team-telnyx/ai) (official: SMS + WhatsApp) + `@telnyx/mcp` · [expo-server-sdk](https://github.com/expo/expo-server-sdk-node) · [web-push](https://github.com/web-push-libs/web-push) | one outbox for email, SMS, WhatsApp, push and in-app: triggers, holdouts, idempotent sends, receipts, verified webhooks, all in your own code |
| 8 | **partner-program** | this kit + `influencer-marketing`, `referrals`, `co-marketing` | creators, influencers, affiliates, customer referrals: codes + `?ref` links, attribution, tiered commissions, clawbacks, payouts, creator discovery |
| 9 | **loyalty-engine** | this kit | points, tiers on 12-month spend, rewards, store credit, tier-progress nudges |
| 10 | **meta-ads** | Meta's official hosted Ads MCP (optional) + `ads`, `ad-creative` | Partnership Ads from top creators, Conversions API from your orders, value lookalikes |
| 11 | **growth-optimizer** + `mkt-optimize` | this kit (`uv` script, scikit-learn) | churn / CLV / partner / prospect scores and bandits that learn from your sales |
| 12 | **mobile-growth** | this kit + `aso`, `asc-*`, appeeky skills | mobile web + Expo apps: devices, app links, install claims, push registration, inbox, review moments, PWA, mobile reports |
| — | **marketing-kit** | this kit | the brain: owners, conflict rules, shared context; loads on any growth task |

### The revenue engine: creators, referrals and loyalty first, ads second

| Piece | What you get | Third-party setup |
|---|---|---|
| Partner program | one engine for creators, affiliates, ambassadors and referring customers. Typed codes beat cookies, repeat orders earn recurring credit, tier rates apply at order time, refunds claw back proportionally, commissions wait out a hold. Payouts: store credit (instant), PayPal + Venmo (Payouts API, idempotent batch), Cash App + Zelle (a pay sheet with prefilled Cash App links, then `markPaid`) | none to start; PayPal, YouTube, Instagram and TikTok One keys whenever you want those pieces |
| Loyalty | append-only points + store-credit ledgers, tiers as a live view, rewards as rows, points for reviews/UGC/referrals, optional expiry | none |
| Growth optimizer | scores in `crm_scores` that every segment can JOIN; each model must beat a transparent baseline on held-out time or the baseline is written; bandits (value-weighted Thompson sampling) for offers, rewards and commission plans | none (`uv`) |
| Meta ads | the official MCP with read + write, Conversions API reference | optional: `META_APP_ID`, then `mkt-settings meta on` |

The optimizer retrains when orders arrive, not on a clock: `mkt-optimize --if-due` whenever you
like, or `optimize.py --listen` on Railway (a Postgres NOTIFY trigger wakes it on each new order).

### Analytics: first-party by design

| Layer | What | Why |
|---|---|---|
| Collector (core) | `lib/track.ts` → `POST /api/t` → `crm_events` in the app's Postgres, `stitchAnon()` at login | Same-domain requests (ad blockers rarely drop them). Rows sit next to orders and messages, so triggers and lift are one SQL join with no sync. No IP stored |
| Revenue (core) | `crm_revenue` = a table or VIEW over the app's own orders/payments | no billing vendor in the loop |
| Umami (core) | self-hosted on your Railway: `mkt-umami deploy`, then `mkt-umami snippet` | the human dashboard (visitors, referrers, UTMs) without building UI. `umami.identify(contact.id)` links it to the CRM |
| Search Console (optional) | `mkt-settings gsc on\|off` | search-query data only exists at Google. It's read-only and collects nothing from visitors |

No GA4, PostHog, Segment or Stripe. Self-hosted PostHog needs ClickHouse, Kafka and Redis, which
is heavy on Railway. Plausible CE is AGPL and also needs ClickHouse. Umami is MIT, runs on
Postgres and idles at about 200 MB.

## The loop

```
recall ─▶ listen ─▶ segment ─▶ shape ─▶ write ─▶ harden ─▶ build/send ─▶ measure ─▶ remember
ledger   crm-db    growth-    market-  copy →   campaign-  lifecycle-   lift vs    ledger
         events +  data SQL   ing      edit →   harden +   engine       holdout
         orders,   (cohorts)  skills   human-   preflight  Resend/      (crm-db)
         Umami,                        izer     (GREEN)    Telnyx
         GSC opt.
```

**One join key:** the campaign `id` is also the `utm_campaign`, the Resend tag `campaign` and
`crm_campaigns.id`, so the collector, Umami, messages and revenue all group by the same value.
`mkt-preflight` rejects any link that breaks it.

## `mkt-preflight`: the campaign gate

```bash
mkt-preflight campaigns/winback.campaign.json --db
```

It errors when:
- a `{{var}}` isn't a column the audience query returns (`--db` runs the SQL with `LIMIT 0` and checks the real columns)
- the audience SQL isn't a read-only SELECT, or a link is malformed
- placeholders are left over (`TODO`, `[FIRST NAME]`)
- the idempotency key doesn't contain `{{contact_id}}`, or renders over Resend's 256 characters
- a provider limit would be hit: Telnyx's 10 segments (40302) or 10 MMS files (40317), Resend's 50 recipients

It warns on slop phrases (kit list + your `.agents/banned-phrases.txt`), long subjects, a
missing preheader, UCS-2 characters and a `utm_campaign` that doesn't match the id. A link with
no `utm_campaign` is a note (that traffic just won't be attributed). `--strict` turns warnings
into errors. `mkt-init` adds it to the Starter Kit's `verify.sh`, so a broken campaign blocks the agent's turn.

## Your settings

```bash
mkt-settings                 # show switches: core (always on) + optional sources
mkt-settings gsc on          # Search Console on: registers the MCP in Claude Code + Hermes
mkt-settings gsc off         # off: unregisters it everywhere
mkt-settings meta on         # Meta Ads MCP (official, hosted; needs META_APP_ID) — optional, later
```
Switches live in `~/.config/marketing-kit/settings.env`. Secrets stay separate, in `secrets.env`.

## Manual steps (the only ones)

**Once per machine:** fill `~/.config/marketing-kit/secrets.env` (chmod 600, read by both hosts),
then re-run the installer to register those servers.

```bash
$EDITOR ~/.config/marketing-kit/secrets.env     # TELNYX_API_KEY, RESEND_API_KEY (Hermes)
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash
```

- **Resend on Claude Code:** browser OAuth on first use (hosted MCP from the official plugin).
- **Umami (once per app):** in the app repo, run `mkt-umami deploy`. It writes `UMAMI_*` into
  `secrets.env`. Log in, change the default password, add the site, run
  `mkt-umami snippet <website-id>`, then re-run the installer.
- **Search Console (optional):** `mkt-settings gsc on`, plus a service-account JSON in
  `GOOGLE_APPLICATION_CREDENTIALS` (see `journey-analytics/references/search-console.md`).
  `mkt-settings gsc off` unregisters it everywhere.
- **Supermemory extraction** needs an LLM key in `~/.supermemory/env`; search works without one.

**Once per repo:**

```bash
mkt-init
railway link                    # or set CRM_DATABASE_URL in .agents/marketing-kit.env
# then ask the agent: "add the journey-analytics first-party collector"
```

To use a read-only DB role (recommended), run the SQL in
`skills/growth-data/references/readonly-role.sql` once, via `railway connect Postgres`.

**When you want the agent to write CRM rows directly:** set `MKT_DB_ACCESS=unrestricted` in
`.agents/marketing-kit.env` and restart the session. Schema changes still go through your migrations.

## Layout

```
skills/            marketing-kit · growth-data · journey-analytics · campaign-harden · lifecycle-engine · playbook-ledger
                   partner-program · loyalty-engine · growth-optimizer · meta-ads · mobile-growth
  growth-data/references/     crm-schema.ts (Drizzle) · cohorts.sql · readonly-role.sql
  journey-analytics/references/ first-party-tracking.ts · analytics.sql · umami.md · search-console.md
  lifecycle-engine/references/ outbox-worker.ts · webhooks.ts
  partner-program/references/  partner-tracking.ts · partner.sql · payouts.ts · creator-discovery.ts
  loyalty-engine/references/   loyalty.sql · loyalty.ts
  growth-optimizer/            scripts/optimize.py · references/bandit.ts · references/optimizer.sql
  meta-ads/references/         meta-capi.ts
  mobile-growth/references/    app-server.ts · app-client.md (Expo + PWA) · mobile.sql
bin/               mkt-mcp · mkt-preflight · mkt-ledger · mkt-doctor · mkt-settings · mkt-umami · mkt-update · mkt-webhooks · mkt-optimize
install/           bootstrap.sh · install.sh (Claude Code) · hermes.sh · init-project.sh (mkt-init)
                   upstream-skills.tsv ← the curated set (both hosts) · claude-plugins.tsv · hermes-skills.tsv ← vendor packs
templates/         campaign.example.json · secrets.env.example · marketing-kit.env · banned-phrases.txt
tests/run.sh       preflight, DB resolution, switches, Umami, mkt-init idempotency, verify gating, ledger,
                   schema typecheck, and every analytics/cohort query on a real seeded Postgres;
                   outbox worker on every channel (mock Resend/Telnyx/Expo/Web Push), partner/loyalty money paths
                   (mock PayPal), mobile E2E (app links, install claims → creator credit, Apple Ads, AdAttributionKit),
                   brain consistency, bandit, optimizer on synthetic history
```

## Verify

```bash
bash tests/run.sh        # 49 checks
mkt-doctor --live        # also launches every MCP server and completes the handshake
```

MIT licensed.
