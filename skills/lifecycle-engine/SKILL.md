---
name: lifecycle-engine
description: "Use when building, changing, or running triggered or automated campaigns, drip sequences, broadcasts, transactional messages, or delivery infrastructure in the app's own code — the ONE sender for every channel: Resend (email), Telnyx (SMS + WhatsApp), Expo Push + Web Push (push) and the in-app inbox: trigger rules, enrollment, holdouts, outbox worker, idempotent sends, scheduling, delivery + inbound webhooks, push receipts, test sends. Execution owner — strategy and copy come from emails / sms / churn-prevention / onboarding. Also for ad-hoc sends through the Resend/Telnyx MCP servers."
---

# Lifecycle Engine (triggered + automated delivery, in your own code)

No automation SaaS: the app evaluates rules against its own DB, enrolls contacts, and drains
an outbox through Resend and Telnyx. The provider skills (`resend`, `react-email`,
`email-best-practices`, `telnyx-messaging-javascript`) hold current SDK/API detail — load
them before writing a provider call; this skill holds the architecture.

**Channels (one outbox, one worker):** `email` → Resend · `sms` → Telnyx · `whatsapp` → Telnyx
(`client.messages.whatsapp`; free-form inside the 24h window, else `payload.template`) · `push` →
Expo Push for the native app / Web Push for PWAs and browsers (`to_address` = `crm_devices.id`, one row
per granted device, receipts checked ~15 min later in the same loop, dead tokens revoke the device) ·
`in_app` → no provider, the row is the inbox item (`mobile-growth` → `inbox()`). Deep links go in
`payload.url` (`/a/*` paths open the app when installed). Pick the channel per contact with a
`growth-optimizer` arm; pacing is only what each provider enforces (`templates/provider-limits.json`).

## Architecture (five pieces, each idempotent)

```
event (site collector / app code / Resend+Telnyx webhooks) ─▶ crm_events
                     │  rule: SQL cohort or event match (campaign.send.trigger)
                     ▼
          crm_enrollments (variant, holdout)  ── holdout: row, no message
                     │  step scheduler (delay, only_if)
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
- **24/7, no kit limits.** No send windows, quiet hours, frequency caps or policy filters.
  The only limits are what Resend and Telnyx enforce, listed with sources in
  `templates/provider-limits.json` and paced for by the worker:
  - Resend: 10 req/s per team (no burst; `RESEND_RPS` if yours was raised) · batch ≤100
    emails = 1 request · ≤50 recipients/email · ≤40 MB attachments · idempotency key ≤256
    chars, 24h · free plan 100/day (resets 00:00 UTC) + 3,000/month · paid overage stops at 5×.
  - Telnyx: account 50 SMS/s, 15 MMS/s · per sender toll-free 20/s, short code 1,000/s, US long
    code = your 10DLC class (`TELNYX_SENDER_MPS`; AT&T TPM + T-Mobile daily brand cap) · queue
    holds 4h (40318 full) · ≤10 SMS segments (40302) · MMS ≤10 media, ≤1 MB (40317).
- **Provider refusals** — the worker skips only what the provider itself will refuse: Resend's
  own suppression (hard bounce, spam complaint) and Telnyx blocks (40300 STOP, 40001/40003/40310).
  Those would fail and cost money anyway. `send.exclude` overrides the list; `[]` skips nothing.
- **Provider stops are waited out, not failed** — Resend 429 rate → retry next second; daily quota
  → held to 00:00 UTC; monthly → next month. Telnyx 429/40318/40011/40016/40018 → backoff;
  40333 spend limit / 40020 / 40320 → hold 1h.
- **Holdout (optional)** — only if the campaign sets `holdout_pct`: deterministic
  `hash(contact_id || campaign_id) % 100 < holdout_pct`, enrollment row with no message.
- **Provider choice** — email always goes through `POST /emails/batch` (100 per request = 1,000
  emails/s at the default rate). Telnyx: E.164 numbers on a messaging profile; add numbers to
  the pool for more SMS throughput.
- **Webhooks** — verify on the RAW body; update by `provider_message_id`; dedupe by provider
  event id; bounces, complaints and inbound STOP/START are recorded in `crm_suppressions` + contact
  status as data. Nothing is blocked by the kit.
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
