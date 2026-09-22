# Umami (core) — the human dashboard, self-hosted on your Railway

Umami is the traffic dashboard: visitors, referrers, UTMs, pages and countries. It runs in your
own Railway project on its own Postgres. The engine (triggers, cohorts, lift) still reads
`crm_events` in the app DB. Umami is for people looking at traffic, and it supplies a second,
independent count to sanity-check the collector.

## Deploy (once per app)
```bash
cd <app repo>            # railway-linked
mkt-umami deploy --dry-run   # prints exactly what it will create
mkt-umami deploy             # umami-db (Postgres) + umami (ghcr.io/umami-software/umami:latest) + domain
```
It writes `UMAMI_DATABASE_URL` and `UMAMI_URL` to `~/.config/marketing-kit/secrets.env`. Then:
1. Open `UMAMI_URL`, log in as `admin` / `umami`, and **change the password immediately**.
2. Go to Settings → Websites → Add, enter the site's domain, and copy the **Website ID**.
3. Run `mkt-umami snippet <website-id>` and paste the output into `app/layout.tsx`.
4. Re-run the kit installer. This registers the `umami` MCP (read-only) in Claude Code and Hermes.
5. Run `mkt-umami status` to check that the dashboard is up and events are arriving.

Updating: redeploy the `umami` service on Railway. `:latest` pulls the newest release, and
Umami migrates its own DB on boot.

## Identity: one person across both databases
Call `umami.identify(contact.id)` right after login or signup. Umami stores that value as
`session.distinct_id`, so an Umami session maps to exactly one `crm_contacts.id`. The two
databases are separate: query each through its own MCP, then join on the id list. Don't copy
tables across.

## What to use Umami for (vs crm_events)
| Question | Source |
|---|---|
| "Where is traffic coming from this week?", top pages, countries, devices | Umami dashboard / `umami` MCP (analytics.sql U1) |
| Did campaign X's clicks arrive? (utm_campaign = campaign id) | both: Umami U1 and analytics.sql #6. A big mismatch means a broken link or a blocked collector |
| Funnels, retention, churn/upsell cohorts, revenue, lift | `crm_events` + `crm_revenue` only (the join to orders and messages lives there) |
| Triggers ("inactive 10 days", "hit 90% of limit") | `crm_events` only, never Umami |

## Pitfalls
- Umami counts page views by itself. Don't also send `page.viewed` to Umami with `track()`.
- Custom Umami events are for the dashboard. Anything a trigger needs must also go through
  `/api/t` (or be written server-side with `source: 'app'`).
- `UMAMI_DATABASE_URL` is the **public** Railway URL. The MCP opens it in restricted
  (read-only) mode. Don't reuse that URL for writes.
