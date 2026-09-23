# Marketing Kit

A growth-engine skill stack for **Claude Code** and **Hermes** that fits apps which **own their
CRM**: Postgres on Railway (Drizzle), email through **Resend**, SMS through **Telnyx**. There's no
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
| Kit skills (6) | **symlinked** from `~/.marketing-kit`, which bootstrap `git pull`s every run |
| Vendor skills | Claude Code: **plugins from each vendor's own marketplace**, `marketplace update` + `plugin update` every run. Hermes: **hub installs from the vendor repo**, `hermes skills update` every run |
| Context budget | Heavy plugins load **per repo** (`mkt-init` enables them in `.claude/settings.json`), so coding-only sessions don't pay ~13k tokens for 70 marketing skills. Measured with `claude plugin details` |
| MCP servers | `mkt-mcp <name>` runs `npx pkg@latest` / `uvx pkg@latest` on every launch |
| Supermemory | the official installer; an existing server (e.g. from Starter Kit) gets reused |

This repo contains no vendored third-party skill.

## Freedom first

Sending is **24/7 with no restrictions**. The kit has no legal or compliance gating, no send
windows or quiet hours, no frequency caps, and no terms or policies. The agent is told to treat
legal notes inside vendor skills as background only.

The **only** limits are the ones Resend and Telnyx enforce themselves. They are listed with
source links in [`templates/provider-limits.json`](templates/provider-limits.json), and the
outbox worker paces to them exactly.

| Provider | What it enforces | What the kit does |
|---|---|---|
| Resend | 10 req/s per team, batch ≤100 emails (= 1 request), ≤50 recipients/email, key ≤256 chars; free plan 100/day + 3,000/month | batches every send (≈1,000 emails/s), waits out 429s, holds quota stops until they reset (00:00 UTC / next month) |
| Resend | won't deliver to hard-bounced or spam-complaint addresses | skips them (they'd fail) |
| Telnyx | 50 SMS/s per account; toll-free 20/s, short code 1,000/s, US long code = your 10DLC class; 4h queue | paces per number + account (`TELNYX_SENDER_MPS` for 10DLC) |
| Telnyx | ≤10 segments (40302), MMS ≤10 media/1 MB (40317), refuses STOP'd (40300) and non-routable (40001) numbers | preflight catches size limits; the worker records refusals so it stops paying to retry |

`send.exclude` overrides the skip list per campaign, and `[]` skips nothing.


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
| 4 | Marketing skills | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | strategy + drafts: copywriting, emails, sms, churn-prevention, pricing, offers, ab-testing, attribution, … |
| 5 | Humanizer | [blader/humanizer](https://github.com/blader/humanizer) (Hermes: bundled port) | strips AI tells from customer-facing copy |
| 6 | **campaign-harden** + `mkt-preflight` | this kit | persona grill with evidence, claim check, and a deterministic gate for schema, variables, UTMs and SMS segments |
| 7 | **lifecycle-engine** + Resend + Telnyx | [resend/resend-skills](https://github.com/resend/resend-skills) (official, hosted MCP) · [team-telnyx/ai](https://github.com/team-telnyx/ai) (official) + `@telnyx/mcp` | triggers, enrollment with holdout, idempotent outbox, verified webhooks, all in your own code |
| 8 | **partner-program** | this kit + `influencer-marketing`, `referrals`, `co-marketing` | creators, influencers, affiliates, customer referrals: codes + `?ref` links, attribution, tiered commissions, clawbacks, payouts, creator discovery |
| 9 | **loyalty-engine** | this kit | points, tiers on 12-month spend, rewards, store credit, tier-progress nudges |
| 10 | **meta-ads** | Meta's official hosted Ads MCP (optional) + `ads`, `ad-creative` | Partnership Ads from top creators, Conversions API from your orders, value lookalikes |
| 11 | **growth-optimizer** + `mkt-optimize` | this kit (`uv` script, scikit-learn) | churn / CLV / partner / prospect scores and bandits that learn from your sales |
| — | **marketing-kit** | this kit | the workflow map; loads on any growth/CRM/email/SMS/partner/loyalty task |

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
                   partner-program · loyalty-engine · growth-optimizer · meta-ads
  growth-data/references/     crm-schema.ts (Drizzle) · cohorts.sql · readonly-role.sql
  journey-analytics/references/ first-party-tracking.ts · analytics.sql · umami.md · search-console.md
  lifecycle-engine/references/ outbox-worker.ts · webhooks.ts
  partner-program/references/  partner-tracking.ts · partner.sql · payouts.ts · creator-discovery.ts
  loyalty-engine/references/   loyalty.sql · loyalty.ts
  growth-optimizer/            scripts/optimize.py · references/bandit.ts · references/optimizer.sql
  meta-ads/references/         meta-capi.ts
bin/               mkt-mcp · mkt-preflight · mkt-ledger · mkt-doctor · mkt-settings · mkt-umami · mkt-update · mkt-webhooks · mkt-optimize
install/           bootstrap.sh · install.sh (Claude Code) · hermes.sh · init-project.sh (mkt-init)
                   claude-plugins.tsv · hermes-skills.tsv   ← the vendor manifest
templates/         campaign.example.json · secrets.env.example · marketing-kit.env · banned-phrases.txt
tests/run.sh       preflight, DB resolution, switches, Umami, mkt-init idempotency, verify gating, ledger,
                   schema typecheck, and every analytics/cohort query on a real seeded Postgres;
                   outbox worker, partner/loyalty money paths (mock PayPal), bandit, optimizer on synthetic history
```

## Verify

```bash
bash tests/run.sh        # 49 checks
mkt-doctor --live        # also launches every MCP server and completes the handshake
```

MIT licensed.
