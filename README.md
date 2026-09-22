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
| — | **marketing-kit** | this kit | the workflow map; loads on any growth/CRM/email/SMS task |

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
- a link is missing `utm_*`, or `utm_campaign ≠ id`
- an SMS goes over `max_segments` at maximum variable length (GSM-7/UCS-2 aware)
- the audience SQL isn't a SELECT
- placeholders are left over (`TODO`, `[FIRST NAME]`)
- there's no primary metric, no declared holdout, or no idempotency key containing `{{contact_id}}`

It warns on slop phrases (kit list + your `.agents/banned-phrases.txt`), long subjects, a
missing preheader, UCS-2 characters and a 0% holdout. `--strict` turns warnings into errors.
`mkt-init` adds it to the Starter Kit's `verify.sh`, so a broken campaign blocks the agent's turn.

## Your settings

```bash
mkt-settings                 # show switches: core (always on) + optional sources
mkt-settings gsc on          # Search Console on: registers the MCP in Claude Code + Hermes
mkt-settings gsc off         # off: unregisters it everywhere
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
  growth-data/references/     crm-schema.ts (Drizzle) · cohorts.sql · readonly-role.sql
  journey-analytics/references/ first-party-tracking.ts · analytics.sql · umami.md · search-console.md
  lifecycle-engine/references/ outbox-worker.ts · webhooks.ts
bin/               mkt-mcp · mkt-preflight · mkt-ledger · mkt-doctor · mkt-settings · mkt-umami
install/           bootstrap.sh · install.sh (Claude Code) · hermes.sh · init-project.sh (mkt-init)
                   claude-plugins.tsv · hermes-skills.tsv   ← the vendor manifest
templates/         campaign.example.json · secrets.env.example · marketing-kit.env · banned-phrases.txt
tests/run.sh       preflight, DB resolution, switches, Umami, mkt-init idempotency, verify gating, ledger,
                   schema typecheck, and every analytics/cohort query on a real seeded Postgres
```

## Verify

```bash
bash tests/run.sh        # 49 checks
mkt-doctor --live        # also launches every MCP server and completes the handshake
```

MIT licensed.
