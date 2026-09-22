// =============================================================================
// Reference webhook ingest — Resend + Telnyx delivery events → crm_messages / crm_events /
// crm_suppressions. Verify signatures on the RAW body (both providers sign it).
// Everything is RECORDED as data (bounces, complaints, opt-outs); nothing here blocks sends.
// Each campaign decides what to skip via spec.send.exclude (lifecycle-engine).
// Current field names live in the `resend` (references/webhooks.md) and
// `telnyx-messaging-javascript` skills — read them before extending the switch.
// =============================================================================
import { Resend } from "resend";
import Telnyx from "telnyx";
import { sql } from "drizzle-orm";
import { db } from "../db";

const resend = new Resend(process.env.RESEND_API_KEY);
const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY! });

// Resend signs with Svix headers: svix-id, svix-timestamp, svix-signature
export async function resendWebhook(rawBody: string, headers: Record<string, string>) {
  const event: any = resend.webhooks.verify({
    payload: rawBody,
    headers: { "svix-id": headers["svix-id"], "svix-timestamp": headers["svix-timestamp"], "svix-signature": headers["svix-signature"] },
    secret: process.env.RESEND_WEBHOOK_SECRET!,
  });
  const providerId = event.data?.email_id;
  const at = event.created_at ?? new Date().toISOString();
  const map: Record<string, string> = {
    "email.delivered": "delivered", "email.opened": "opened", "email.clicked": "clicked",
    "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed",
  };
  const status = map[event.type];
  if (status && providerId) {
    await db.execute(sql`update crm_messages set
        status = case when status in ('bounced','complained') then status else ${status}::crm_message_status end,
        delivered_at   = case when ${status} = 'delivered' then coalesce(delivered_at, ${at}::timestamptz) else delivered_at end,
        first_opened_at = case when ${status} = 'opened' then coalesce(first_opened_at, ${at}::timestamptz) else first_opened_at end,
        first_clicked_at = case when ${status} = 'clicked' then coalesce(first_clicked_at, ${at}::timestamptz) else first_clicked_at end
      where provider = 'resend' and provider_message_id = ${providerId}`);
  }
  if ((event.type === "email.bounced" && event.data?.bounce?.type !== "Transient") || event.type === "email.complained") {
    for (const to of event.data?.to ?? []) {
      await db.execute(sql`insert into crm_suppressions (channel, value, reason, source)
        values ('email', lower(${to}), ${event.type === "email.complained" ? "complaint" : "hard_bounce"}, 'resend')
        on conflict do nothing`);
      await db.execute(sql`update crm_contacts set email_status = ${event.type === "email.complained" ? "complained" : "bounced"}
        where lower(email) = lower(${to})`);
    }
  }
  await logEvent("resend", event.type, providerId, headers["svix-id"], event.data, at);
}

// Telnyx signs with Ed25519: telnyx-signature-ed25519 + telnyx-timestamp (needs TELNYX_PUBLIC_KEY)
export async function telnyxWebhook(rawBody: string, headers: Record<string, string>) {
  const event: any = await telnyx.webhooks.unwrap(rawBody, { headers });
  const p = event.data?.payload ?? {};
  const type = event.data?.event_type as string;          // message.sent | message.finalized | message.received
  if (type === "message.finalized") {
    const toStatus = p.to?.[0]?.status as string | undefined; // delivered | delivery_failed | sending_failed ...
    const ok = toStatus === "delivered";
    await db.execute(sql`update crm_messages set
        status = ${ok ? "delivered" : "failed"}::crm_message_status,
        delivered_at = case when ${ok} then ${p.completed_at ?? null}::timestamptz else delivered_at end,
        error = case when ${ok} then error else ${JSON.stringify(p.errors ?? []).slice(0, 500)} end,
        segments = coalesce(${p.parts ?? null}, segments)
      where provider = 'telnyx' and provider_message_id = ${p.id}`);
  }
  if (type === "message.received") {
    // Inbound SMS keywords are recorded as data (sms_status + a row with reason 'opted_out').
    // Whether a campaign skips them is its own send.exclude choice. Note: Telnyx itself rejects
    // sends to numbers that texted STOP (error 40300) — that is the provider, not this code.
    const from = p.from?.phone_number as string | undefined;
    const word = String(p.text ?? "").trim().toUpperCase();
    if (from && ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(word)) {
      await db.execute(sql`insert into crm_suppressions (channel, value, reason, source)
        values ('sms', ${from}, 'opted_out', 'telnyx') on conflict do nothing`);
      await db.execute(sql`update crm_contacts set sms_status = 'opted_out' where phone_e164 = ${from}`);
    } else if (from && ["START", "UNSTOP"].includes(word)) {
      await db.execute(sql`delete from crm_suppressions where channel = 'sms' and value = ${from}`);
      await db.execute(sql`update crm_contacts set sms_status = 'ok' where phone_e164 = ${from}`);
    }
  }
  await logEvent("telnyx", type, p.id, event.data?.id, p, p.completed_at ?? p.received_at ?? new Date().toISOString());
}

async function logEvent(source: string, name: string, providerMessageId: string | undefined, dedupe: string | undefined, props: unknown, at: string) {
  await db.execute(sql`insert into crm_events (contact_id, name, source, properties, occurred_at, dedupe_key)
    values ((select contact_id from crm_messages
             where provider = ${source} and provider_message_id = ${providerMessageId ?? ""} limit 1),
            ${name}, ${source}, ${JSON.stringify(props)}::jsonb, ${at}::timestamptz, ${dedupe ?? null})
    on conflict (source, dedupe_key) do nothing`);
}
