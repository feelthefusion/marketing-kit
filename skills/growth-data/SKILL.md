---
name: growth-data
description: "Use when querying, modeling, or changing the app's own CRM data — contacts, identities, events, segments/cohorts, enrollments, messages, suppressions, revenue — in Postgres on Railway via the crm-db (postgres-mcp) and railway MCP servers. Covers the reference Drizzle schema, identity stitching (pre-login anon id → one contact), cohort SQL, read-only vs write access, and schema changes through migrations."
---

# Growth Data (the CRM you own)

The CRM is tables in the app's database. This skill is how the agent reads them, shapes
audiences, and changes them without breaking the app.

## Tools

| Tool | Use for | Notes |
|------|---------|-------|
| `crm-db` MCP (`postgres-mcp`) | `execute_sql`, `list_objects`, `get_object_details`, `explain_query`, `analyze_query_indexes`, `analyze_db_health` | Resolves the DB from the **current project** (`mkt-mcp db`). Default `restricted` = read-only transactions + timeouts |
| `railway` MCP (`railway mcp`) | services, deploys, logs, variables, `railway connect` | Find the Postgres service and its `DATABASE_PUBLIC_URL`; tail worker logs after a send |
| app code (Drizzle) | every WRITE that the app should own | enrollments, messages, traits — through the same functions the app uses |
| `drizzle-kit` | schema changes | `generate` → review SQL → `migrate`; the only DDL path |

Access: `restricted` unless `<repo>/.agents/marketing-kit.env` sets `MKT_DB_ACCESS=unrestricted`
(restart the session after changing it). Pair it with a DB role: `references/readonly-role.sql`
creates `growth_ro` (and an optional `growth_rw` limited to `crm_*` tables).
Unrestricted mode is for direct CRM row work (backfills, tagging, fixing a bad import): state
the rows affected with a `select count(*)` first, run inside a transaction, paste the result.

## First contact with a repo

1. Read `.agents/growth-stack.md` (tables, event names, DB service) — `mkt-init` created it.
2. `list_objects` → map what exists. **Adopt before adding**: if `users`/`customers`/`orders`
   exist, the CRM references them (`crm_contacts.user_id`) or reads them through a view; never
   a second copy of identity.
3. Compare with `references/crm-schema.ts`. Propose only the missing pieces, as a migration.
4. Record the mapping (which table = contacts, which column = plan, activation event name) in
   `.agents/growth-stack.md` so no later session re-discovers it.

## Schema rules (why each table exists)

- **One person, many IDs** — `crm_identities(kind, value)` links the pre-login browser
  `anon_id` (plus Resend/Telnyx/legacy ids) to one `contact_id`. `stitchAnon()` writes it at
  signup/login (journey-analytics → `references/first-party-tracking.ts`); Umami needs no row
  because the site calls `umami.identify(contact.id)`.
- **Events are the journey** — `crm_events` is append-only with `source` and a provider
  `dedupe_key` (webhook replays are harmless). Names are `object.action` snake_case and listed
  in `growth-stack.md`; a new name gets added there in the same change.
- **Outbox before send** — a `crm_messages` row exists before the provider call, keyed by a
  unique `idempotency_key`. lifecycle-engine owns this.
- **Holdouts are rows** — `crm_enrollments.holdout = true` means eligible and deliberately not
  messaged. Without it, lift is unknowable.
- **Revenue from the app's own orders/payments** — `crm_revenue` is either written by the code
  that records a payment/refund/plan change, or is a VIEW over the existing orders/payments
  tables. Attribution is computed, never typed in.
- **First-party only** — every row comes from the site or its own databases. No third-party
  analytics or billing IDs in the schema.
- **High volume** — `crm_events` past ~10M rows: BRIN index on `occurred_at`, monthly
  partitions, and a retention policy for raw `page.viewed` (keep aggregates).
- **Traits are typed at the edge** — `traits jsonb` is validated by a zod schema in the app
  before write; a template may only use a trait the audience query projects as a column.

## Audience queries (cohorts)

- A read-only `SELECT` returning `contact_id` plus exactly the columns the templates use.
- Filter reachable contacts in the query (`email_status = 'ok'`, not in `crm_suppressions`),
  and exclude recent enrollees of the same campaign and fatigued contacts (cohorts.sql #6).
- Save it as `campaigns/<id>.sql`, declare its columns in the campaign spec, and let
  `mkt-preflight --db` prove the columns are real.
- `explain_query` any cohort that scans `crm_events` without a time bound.
- Starting points: `references/cohorts.sql` (churn risk, upsell at 90% limit, activation gap,
  source quality by revenue, holdout lift, fatigue).

## Pitfalls

- `*.railway.internal` hosts only resolve inside Railway; the launcher skips them and uses
  `DATABASE_PUBLIC_URL`. If a query hangs, check which URL `mkt-mcp db` chose (it logs to stderr).
- Hermes connects MCP servers once per process: `crm-db` binds to the workspace Hermes started
  in. Switching repos → restart the session.
- Never paste a DB URL into chat or a committed file; it lives in `.agents/marketing-kit.env`
  (gitignored) or the app's `.env`.

## Works with →
- **journey-analytics** — the first-party collector that fills `crm_events`, analytics SQL,
  Umami, optional Search Console; owns lift math.
- **lifecycle-engine** — writes enrollments/messages; reads suppressions at send time.
- **campaign-harden** — `mkt-preflight --db` runs the audience SQL here.
- **playbook-ledger** — save the table mapping and winning cohort definitions.
- Starter Kit **security-gate** / **verify-gate** — migrations ship with a passing gate.
