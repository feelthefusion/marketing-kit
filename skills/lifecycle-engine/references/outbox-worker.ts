// =============================================================================
// Reference outbox worker — Resend (email) + Telnyx (SMS), Drizzle + pg, Railway.
// Pattern, not a drop-in: adapt table/column names to the app (growth-data schema).
// Before editing: `resend` and `telnyx-messaging-javascript` skills hold the CURRENT SDK
// signatures — check them (docs-freshness) rather than trusting this file's calls.
//
// Freedom first: 24/7, no send windows, no frequency caps, no policy filters. The ONLY pacing
// here is what Resend and Telnyx themselves enforce (templates/provider-limits.json, with
// sources). Send as fast as the providers accept, and park anything they refuse.
//
//   Resend  10 req/s per team (no burst) · batch ≤100 emails = 1 request · ≤50 recipients/email
//           idempotency key ≤256 chars, remembered 24h · free plan 100/day (00:00 UTC) + 3,000/mo
//   Telnyx  account 50 SMS/s, 15 MMS/s · per sender: toll-free 20/s, short code 1,000/s,
//           US long code = your 10DLC class (set TELNYX_SENDER_MPS) · queue holds 4h (40318 full)
//           · ≤10 segments · refuses STOP'd (40300) and non-routable (40001) numbers
//
// Guarantees:
//   * at-most-once per idempotency key: the unique index on crm_messages.idempotency_key is the
//     lock; Resend also receives a key, so a retried HTTP call is a no-op upstream
//   * crash-safe: rows are claimed with FOR UPDATE SKIP LOCKED — N workers never grab the same row
//   * skips only what the provider itself refuses (spec.send.exclude overrides; [] = skip nothing)
// Run: a long-lived Railway worker (`node dist/outbox.js`) calling drainOutbox() in a loop.
// =============================================================================
import { createHash } from "node:crypto";
import { Resend } from "resend";
import Telnyx from "telnyx";
import { sql } from "drizzle-orm";
import { db } from "../db"; // the app's drizzle instance

const resend = new Resend(process.env.RESEND_API_KEY);
const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY! });

// ── provider limits (templates/provider-limits.json) ────────────────────────────────────────────
const RESEND_RPS = Number(process.env.RESEND_RPS ?? 10);       // your team's limit (Settings → Usage)
const RESEND_BATCH_MAX = 100;
const TELNYX_ACCOUNT_SMS_MPS = 50;
const SENDER_MPS_OVERRIDE = process.env.TELNYX_SENDER_MPS ? Number(process.env.TELNYX_SENDER_MPS) : null;

export function senderMps(from: string): number {
  if (SENDER_MPS_OVERRIDE) return SENDER_MPS_OVERRIDE;
  const digits = from.replace(/\D/g, "");
  if (digits.length <= 6) return 1000;                                     // short code
  if (/^1(800|833|844|855|866|877|888)/.test(digits)) return 20;           // US/CA toll-free
  if (digits.startsWith("1")) return 1;   // US long code: 10DLC class decides — set TELNYX_SENDER_MPS
  return 0.1;                                                              // non-US long code
}

// Token bucket, one per provider scope. Waits instead of letting the provider 429 / fill its queue.
export class Bucket {
  private tokens: number; private last = Date.now();
  constructor(private rate: number, private burst = Math.max(1, rate)) { this.tokens = this.burst; }
  async take(n = 1) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      await new Promise((r) => setTimeout(r, Math.ceil(((n - this.tokens) / this.rate) * 1000)));
    }
  }
}
const resendBucket = new Bucket(RESEND_RPS, RESEND_RPS);   // Resend: no burst above the per-second limit
const telnyxAccount = new Bucket(TELNYX_ACCOUNT_SMS_MPS);
const telnyxSenders = new Map<string, Bucket>();
const senderBucket = (from: string) =>
  telnyxSenders.get(from) ?? telnyxSenders.set(from, new Bucket(senderMps(from))).get(from)!;

// Telnyx error classes (developers.telnyx.com/docs/messaging/messages/error-codes)
const TELNYX_RETRY = new Set([40006, 40008, 40011, 40016, 40018, 40318]);
const TELNYX_HOLD = new Set([40002, 40020, 40320, 40333]);
const TELNYX_BLOCKS: Record<number, string> = { 40300: "opted_out", 40001: "carrier_reject", 40003: "carrier_reject", 40310: "carrier_reject" };

// What the providers themselves refuse — recorded from their own signals (webhooks / errors).
const PROVIDER_REFUSES = ["hard_bounce", "complaint", "opted_out", "carrier_reject"];
const excludeCache = new Map<string, string[]>();
async function excludeFor(campaignId: string | null): Promise<string[]> {
  if (!campaignId) return PROVIDER_REFUSES;
  if (!excludeCache.has(campaignId)) {
    const { rows } = await db.execute(sql`select spec->'send'->'exclude' as ex from crm_campaigns where id = ${campaignId}`);
    const ex = (rows[0] as any)?.ex;
    excludeCache.set(campaignId, Array.isArray(ex) ? ex : PROVIDER_REFUSES);
  }
  return excludeCache.get(campaignId)!;
}

type Claimed = {
  id: string; idempotency_key: string; channel: "email" | "sms"; to_address: string;
  from_address: string; subject: string | null; body: string; campaign_id: string | null;
};

export async function drainOutbox(claim = 500) {
  // 0. crash recovery: a worker that died mid-drain leaves rows in 'sending' — requeue after 10 min
  await db.execute(sql`update crm_messages set status = 'queued'
    where status = 'sending' and scheduled_for < now() - interval '10 minutes'`);

  // 1. claim due rows atomically (scheduled_for = claim time, for the recovery above)
  const { rows } = await db.execute<Claimed>(sql`
    update crm_messages m set status = 'sending', scheduled_for = now()
    where m.id in (
      select id from crm_messages
      where status = 'queued' and scheduled_for <= now()
      order by scheduled_for
      for update skip locked
      limit ${claim})
    returning m.id, m.idempotency_key, m.channel, m.to_address, m.from_address, m.subject, m.body, m.campaign_id`);

  // 2. skip what the provider would refuse anyway (or what the campaign's own exclude lists)
  const ready: Claimed[] = [];
  for (const m of rows) {
    const exclude = await excludeFor(m.campaign_id);
    if (exclude.length) {
      const { rows: hit } = await db.execute(sql`
        select reason from crm_suppressions
        where channel = ${m.channel} and value = lower(${m.to_address}) and reason = any(string_to_array(${exclude.join(",")}, ',')) limit 1`);   // drizzle expands JS arrays to a list, not a pg array
      if (hit.length) { await mark(m.id, "skipped", { error: `provider refuses: ${(hit[0] as any).reason}` }); continue; }
    }
    ready.push(m);
  }

  // 3. email → Resend batch API, ≤100 per request, paced at the team's req/s
  const emails = ready.filter((m) => m.channel === "email");
  for (let i = 0; i < emails.length; i += RESEND_BATCH_MAX) await sendEmailChunk(emails.slice(i, i + RESEND_BATCH_MAX));

  // 4. SMS → Telnyx, paced per sender number and per account (senders run in parallel)
  const bySender = groupBy(ready.filter((m) => m.channel === "sms"), (m) => m.from_address);
  await Promise.all([...bySender.values()].map(async (msgs) => { for (const m of msgs) await sendSms(m); }));
  return rows.length;
}

async function sendEmailChunk(chunk: Claimed[]) {
  await resendBucket.take();
  // Batch key = hash of the sorted message keys: an identical retry within 24h is a no-op at Resend.
  const key = `batch/${createHash("sha256").update(chunk.map((m) => m.idempotency_key).sort().join("|")).digest("hex")}`;
  const { data, error } = await resend.batch.send(
    chunk.map((m) => ({
      from: m.from_address, to: [m.to_address], subject: m.subject ?? "", html: m.body,
      tags: m.campaign_id ? [{ name: "campaign", value: m.campaign_id }] : undefined,
      headers: { "X-Entity-Ref-ID": m.id },
    })),
    { idempotencyKey: key },
  );
  if (!error) {
    const ids = (data as any)?.data ?? [];
    await Promise.all(chunk.map((m, i) => mark(m.id, "sent", { providerMessageId: ids[i]?.id })));
    return;
  }
  // Resend-imposed stops: wait exactly until Resend lifts them, then the same rows go again.
  const until =
    error.name === "daily_quota_exceeded" ? sql`(date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc'` :
    error.name === "monthly_quota_exceeded" ? sql`date_trunc('month', now()) + interval '1 month'` :
    error.name === "rate_limit_exceeded" ? sql`now() + interval '1 second'` : null;
  for (const m of chunk) {
    if (until) await requeue(m.id, until, `${error.name}: ${error.message}`);
    else await mark(m.id, "failed", { error: `${error.name}: ${error.message}`.slice(0, 500) });
  }
}

async function sendSms(m: Claimed) {
  await senderBucket(m.from_address).take();
  await telnyxAccount.take();
  try {
    const res: any = await telnyx.messages.send({
      from: m.from_address, to: m.to_address, text: m.body,
      webhook_url: `${process.env.PUBLIC_URL}/webhooks/telnyx`,
    });
    const d = res?.data ?? res;
    await mark(m.id, "sent", { providerMessageId: d.id, segments: d.parts });
  } catch (err: any) {
    const code = Number(err?.error?.errors?.[0]?.code ?? err?.errors?.[0]?.code ?? 0);
    const msg = `${code || err?.status || "network"}: ${err?.message ?? err}`.slice(0, 500);
    if (TELNYX_BLOCKS[code]) {
      // Telnyx refuses this recipient — record the provider fact so we stop paying to retry it.
      await db.execute(sql`insert into crm_suppressions (channel, value, reason, source)
        values ('sms', ${m.to_address}, ${TELNYX_BLOCKS[code]}, ${`telnyx:${code}`}) on conflict do nothing`);
      await mark(m.id, "failed", { error: msg });
    } else if (err instanceof Telnyx.RateLimitError || err instanceof Telnyx.APIConnectionError || TELNYX_RETRY.has(code)) {
      const wait = Number(err?.headers?.["retry-after"] ?? 5);
      await requeue(m.id, sql`now() + (${wait} || ' seconds')::interval`, msg);
    } else if (TELNYX_HOLD.has(code)) {
      await requeue(m.id, sql`now() + interval '1 hour'`, msg);    // spend limit, 2FA hold, sender provisioning
    } else {
      await mark(m.id, "failed", { error: msg });
    }
  }
}

async function requeue(id: string, until: any, error: string) {
  await db.execute(sql`update crm_messages set status = 'queued', scheduled_for = ${until},
    error = ${String(error).slice(0, 500)} where id = ${id}`);
}

async function mark(id: string, status: string, f: { providerMessageId?: string; error?: string; segments?: number } = {}) {
  await db.execute(sql`update crm_messages set status = ${status}::crm_message_status,
      provider_message_id = coalesce(${f.providerMessageId ?? null}, provider_message_id),
      segments = coalesce(${f.segments ?? null}, segments),
      error = ${f.error ?? null},
      sent_at = case when ${status} = 'sent' then now() else sent_at end
    where id = ${id}`);
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const key = k(x); (m.get(key) ?? m.set(key, []).get(key)!).push(x); }
  return m;
}

// Enrollment → outbox: render per contact, insert with ON CONFLICT DO NOTHING (idempotent re-runs).
// Holdout (optional — only when the campaign sets holdout_pct) = enrollment row, no message.
export async function enqueueStep(opts: {
  campaignId: string; step: number; channel: "email" | "sms"; from: string;
  subject?: (row: any) => string; body: (row: any) => string; audience: any[]; delayMinutes?: number;
}) {
  for (const row of opts.audience) {
    const key = `${opts.campaignId}/${row.contact_id}/${opts.step}`;
    const to = opts.channel === "email" ? row.email : row.phone_e164;
    if (!to || row.holdout) continue;
    await db.execute(sql`
      insert into crm_messages (idempotency_key, campaign_id, contact_id, channel, to_address, from_address,
                                subject, body, provider, scheduled_for)
      values (${key}, ${opts.campaignId}, ${row.contact_id}, ${opts.channel}, ${to}, ${opts.from},
              ${opts.subject?.(row) ?? null}, ${opts.body(row)}, ${opts.channel === "email" ? "resend" : "telnyx"},
              now() + (${opts.delayMinutes ?? 0} || ' minutes')::interval)
      on conflict (idempotency_key) do nothing`);
  }
}
