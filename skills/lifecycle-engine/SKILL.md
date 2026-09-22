---
name: lifecycle-engine
description: "Use when building, changing, or running triggered or automated campaigns, drip sequences, broadcasts, transactional messages, or delivery infrastructure in the app's own code with Resend (email) and Telnyx (SMS): trigger rules, enrollment, holdouts, outbox worker, idempotent sends, scheduling/quiet hours, delivery + inbound webhooks, and test sends. Also for ad-hoc sends through the Resend/Telnyx MCP servers."
---

# Lifecycle Engine (triggered + automated delivery, in your own code)

No automation SaaS: the app evaluates rules against its own DB, enrolls contacts, and drains
an outbox through Resend and Telnyx. The provider skills (`resend`, `react-email`,
`email-best-practices`, `telnyx-messaging-javascript`) hold current SDK/API detail — load
them before writing a provider call; this skill holds the architecture.

## Architecture (five pieces, each idempotent)

```
event (app / PostHog / Stripe webhook) ─▶ crm_events
                     │  rule: SQL cohort or event match (campaign.send.trigger)
                     ▼
          crm_enrollments (variant, holdout)  ── holdout: row, no message
                     │  step scheduler (delay, quiet hours, only_if)
                     ▼
          crm_messages  status=queued  idempotency_key UNIQUE    ◀── outbox
                     │  worker: FOR UPDATE SKIP LOCKED, suppression re-check
                     ▼
        Resend (Idempotency-Key)  |  Telnyx /v2/messages
                     │  webhooks (Svix / Ed25519 verified)
                     ▼
     crm_messages status  +  crm_events  +  crm_suppressions
```

References: `references/outbox-worker.ts` (claim → re-check → send → mark; enqueue with
holdout), `references/webhooks.ts` (Resend + Telnyx ingest). Schema: growth-data
`references/crm-schema.ts`.

## Rules

- **Spec first** — every campaign is a `campaigns/<id>.campaign.json` that passed
  `mkt-preflight` (campaign-harden). The app stores it verbatim in `crm_campaigns.spec`.
- **Idempotency key** = `<campaign>/<contact>/<step>`; unique in the DB and passed to Resend.
  Re-running a job must be safe at every stage.
- **Render once, store rendered** — the exact body sent lives in `crm_messages.body`.
- **Holdout at enrollment**, deterministic: `hash(contact_id || campaign_id) % 100 < holdout_pct`.
- **Re-check at send time** — suppression, `email_status`/`sms_status`, converted-already
  (exit the enrollment when the primary metric fires), frequency cap.
- **Timezone-aware scheduling** — `crm_contacts.timezone`; respect the spec's `quiet_hours`.
- **Provider choice** — Resend single send for triggered 1:1; `POST /emails/batch` (≤100, no
  attachments/scheduling, atomic) for volume. Telnyx: E.164 numbers on a messaging profile;
  throughput depends on number type — spread volume over the pool, back off on 429.
- **Webhooks** — verify on the RAW body; update by `provider_message_id`; dedupe by provider
  event id; hard bounce / complaint / carrier opt-out → `crm_suppressions`.
- **Workers on Railway** — a separate service (or cron service) running the drain loop; watch
  it with the `railway` MCP logs after the first send.

## Ad-hoc sends through MCP

`resend` MCP (send, batch, contacts, broadcasts, domains) and `telnyx` MCP (messages,
numbers, profiles) are for **tests, one-offs and inspection** — a test to the owner, checking
domain DNS, reading a message's status. Anything recurring or >1 recipient goes through the
app's outbox so it is logged, deduped and measurable. Before an MCP send to a real audience,
show the recipient count and a rendered sample.

## Test path (every new campaign)

1. `mkt-preflight campaigns/<id>.campaign.json --db` → GREEN.
2. Enroll the owner's own contact only (`where email = '<owner>'`), drain, read on a phone.
3. Check the webhook landed: `crm_messages.status` moved to `delivered`, event row exists.
4. Activate (`crm_campaigns.active = true`); watch the first batch in `railway` logs.
5. After the window: journey-analytics lift report → `mkt-ledger save lift`.

## Works with →
- **campaign-harden** (gate before activation) · **growth-data** (tables, cohorts) ·
  **journey-analytics** (measure) · **playbook-ledger** (save outcomes).
- Provider skills: `resend`, `react-email` (templates), `email-best-practices`
  (deliverability, DNS), `telnyx-messaging-*` (SMS API, profiles).
- Marketing skills `emails` / `sms` / `onboarding` / `churn-prevention` for sequence design.
- Starter Kit: `docs-freshness` before an SDK call, `verify-gate` for the worker's tests.
