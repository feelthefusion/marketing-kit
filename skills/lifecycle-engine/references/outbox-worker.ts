// =============================================================================
// Reference outbox worker — Resend (email) + Telnyx (SMS), Drizzle + pg, Railway.
// Pattern, not a drop-in: adapt table/column names to the app (growth-data schema).
// Before editing: `resend` and `telnyx-messaging-javascript` skills hold the CURRENT SDK
// signatures — check them (docs-freshness) rather than trusting this file's calls.
//
// Guarantees:
//   * at-most-once per idempotency key: the unique index on crm_messages.idempotency_key
//     is the lock; Resend also receives the key, so a retried HTTP call is a no-op upstream
//   * crash-safe: rows are claimed with FOR UPDATE SKIP LOCKED, so N workers (Railway
//     replicas, a cron + a queue) never grab the same message
//   * suppression + channel status are checked at SEND time, not only at enrollment
// Run: a Railway cron service (`node dist/outbox.js`) every minute, or a loop in the worker.
// =============================================================================
import { Resend } from "resend";
import Telnyx from "telnyx";
import { sql } from "drizzle-orm";
import { db } from "../db"; // the app's drizzle instance

const resend = new Resend(process.env.RESEND_API_KEY);
const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY! });
const BATCH = 50;

type Claimed = {
  id: string; idempotency_key: string; channel: "email" | "sms"; to_address: string;
  from_address: string; subject: string | null; body: string; campaign_id: string | null;
};

export async function drainOutbox() {
  // 1. claim due rows atomically
  const { rows } = await db.execute<Claimed>(sql`
    update crm_messages m set status = 'sending'
    where m.id in (
      select id from crm_messages
      where status = 'queued' and scheduled_for <= now()
      order by scheduled_for
      for update skip locked
      limit ${BATCH})
    returning m.id, m.idempotency_key, m.channel, m.to_address, m.from_address, m.subject, m.body, m.campaign_id`);

  for (const m of rows) {
    // 2. re-check suppression at send time (a bounce may have landed since enrollment)
    const { rows: sup } = await db.execute(sql`
      select 1 from crm_suppressions where channel = ${m.channel} and value = lower(${m.to_address}) limit 1`);
    if (sup.length) { await mark(m.id, "skipped", { error: "suppressed" }); continue; }

    try {
      if (m.channel === "email") {
        const { data, error } = await resend.emails.send(
          {
            from: m.from_address, to: [m.to_address], subject: m.subject ?? "", html: m.body,
            tags: m.campaign_id ? [{ name: "campaign", value: m.campaign_id }] : undefined,
            headers: { "X-Entity-Ref-ID": m.id },
          },
          { idempotencyKey: m.idempotency_key },
        );
        if (error) throw Object.assign(new Error(error.message), { permanent: error.name === "validation_error" });
        await mark(m.id, "sent", { providerMessageId: data!.id });
      } else {
        const res = await telnyx.messages.send({
          from: m.from_address, to: m.to_address, text: m.body,
          webhook_url: `${process.env.PUBLIC_URL}/webhooks/telnyx`,
        });
        const d: any = (res as any).data ?? res;
        await mark(m.id, "sent", { providerMessageId: d.id, segments: d.parts });
      }
    } catch (err: any) {
      // 429 / network → back to queue with backoff; 4xx validation → failed for good
      const transient = !err.permanent && (err.status === 429 || err.status >= 500 || err.status === undefined);
      if (transient) {
        await db.execute(sql`update crm_messages set status = 'queued',
          scheduled_for = now() + interval '2 minutes', error = ${String(err.message).slice(0, 500)} where id = ${m.id}`);
      } else {
        await mark(m.id, "failed", { error: String(err.message).slice(0, 500) });
      }
    }
  }
  return rows.length;
}

async function mark(id: string, status: string, f: { providerMessageId?: string; error?: string; segments?: number } = {}) {
  await db.execute(sql`update crm_messages set status = ${status}::crm_message_status,
      provider_message_id = coalesce(${f.providerMessageId ?? null}, provider_message_id),
      segments = coalesce(${f.segments ?? null}, segments),
      error = ${f.error ?? null},
      sent_at = case when ${status} = 'sent' then now() else sent_at end
    where id = ${id}`);
}

// Enrollment → outbox: render per contact, insert with ON CONFLICT DO NOTHING (idempotent re-runs).
// Holdout contacts get an enrollment row and NO message — that is what makes lift measurable.
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
