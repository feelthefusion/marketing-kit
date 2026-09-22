# Marketing Kit

A growth-engine skill stack for **Claude Code** and **Hermes** that fits apps which **own their
CRM**: Postgres on Railway (Drizzle), email through **Resend**, SMS through **Telnyx**. There's no
third-party CRM and no automation SaaS. The agent reads your database, your product analytics
and your revenue, writes copy against that data, and ships campaigns through your own code.

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
| 3 | **journey-analytics** + `ga4` · `gsc` · PostHog · Stripe | [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) (official) · [AminForou/mcp-gsc](https://github.com/AminForou/mcp-gsc) · PostHog hosted MCP `mcp.posthog.com` (official) · [stripe/ai](https://github.com/stripe/ai) (official) | traffic → behavior → revenue on one join key; holdout-based lift |
| 4 | Marketing skills | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | strategy + drafts: copywriting, emails, sms, churn-prevention, pricing, offers, ab-testing, attribution, … |
| 5 | Humanizer | [blader/humanizer](https://github.com/blader/humanizer) (Hermes: bundled port) | strips AI tells from customer-facing copy |
| 6 | **campaign-harden** + `mkt-preflight` | this kit | persona grill with evidence, claim check, and a deterministic gate for schema, variables, UTMs and SMS segments |
| 7 | **lifecycle-engine** + Resend + Telnyx | [resend/resend-skills](https://github.com/resend/resend-skills) (official, hosted MCP) · [team-telnyx/ai](https://github.com/team-telnyx/ai) (official) + `@telnyx/mcp` | triggers, enrollment with holdout, idempotent outbox, verified webhooks, all in your own code |
| — | **marketing-kit** | this kit | the workflow map; loads on any growth/CRM/email/SMS task |

Search Console is the one community server: Google doesn't ship an official GSC MCP.
Segment was left out: PostHog covers the same need first-party, and Segment would add a second
event pipeline for no gain. PostHog's own plugin is also skipped. It bundles 167 skills (~22k
tokens in every session), so the kit registers only its hosted MCP, which is the part it uses.

## The loop

```
recall ─▶ listen ─▶ segment ─▶ shape ─▶ write ─▶ harden ─▶ build/send ─▶ measure ─▶ remember
ledger   GA4/GSC   growth-    market-  copy →   campaign-  lifecycle-   lift vs    ledger
         PostHog   data SQL   ing      edit →   harden +   engine       holdout
         Stripe    (cohorts)  skills   human-   preflight  Resend/                 
         crm-db                        izer     (GREEN)    Telnyx
```

**One join key:** the campaign `id` is also the `utm_campaign`, the Resend tag `campaign` and
`crm_campaigns.id`, so GA4, PostHog, Stripe and the DB all group by the same value.
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

## Manual steps (the only ones)

**Once per machine:** fill `~/.config/marketing-kit/secrets.env` (chmod 600, read by both hosts),
then re-run the installer to register those servers.

```bash
$EDITOR ~/.config/marketing-kit/secrets.env     # TELNYX_API_KEY, RESEND_API_KEY (Hermes), GOOGLE_APPLICATION_CREDENTIALS
curl -fsSL https://raw.githubusercontent.com/feelthefusion/marketing-kit/main/install/bootstrap.sh | bash
```

- **Google (GA4 + GSC):** a single service-account JSON covers both. Add its email as a *Viewer*
  on the GA4 property and as a *user* on the Search Console property.
- **PostHog, Stripe, Resend on Claude Code:** browser OAuth on first use (hosted MCP from the
  official plugins). On Hermes: `hermes mcp login posthog` and `hermes mcp login stripe`.
- **Supermemory extraction** needs an LLM key in `~/.supermemory/env`; search works without one.

**Once per repo:**

```bash
mkt-init
railway link                    # or set CRM_DATABASE_URL in .agents/marketing-kit.env
```

To use a read-only DB role (recommended), run the SQL in
`skills/growth-data/references/readonly-role.sql` once, via `railway connect Postgres`.

**When you want the agent to write CRM rows directly:** set `MKT_DB_ACCESS=unrestricted` in
`.agents/marketing-kit.env` and restart the session. Schema changes still go through your migrations.

## Layout

```
skills/            marketing-kit · growth-data · journey-analytics · campaign-harden · lifecycle-engine · playbook-ledger
  growth-data/references/     crm-schema.ts (Drizzle) · cohorts.sql · readonly-role.sql
  lifecycle-engine/references/ outbox-worker.ts · webhooks.ts
bin/               mkt-mcp · mkt-preflight · mkt-ledger · mkt-doctor
install/           bootstrap.sh · install.sh (Claude Code) · hermes.sh · init-project.sh (mkt-init)
                   claude-plugins.tsv · hermes-skills.tsv   ← the vendor manifest
templates/         campaign.example.json · secrets.env.example · marketing-kit.env · banned-phrases.txt
tests/run.sh       preflight, DB resolution, mkt-init idempotency, verify gating, ledger, schema typecheck
```

## Verify

```bash
bash tests/run.sh        # 32 checks
mkt-doctor --live        # also launches every MCP server and completes the handshake
```

MIT licensed.
