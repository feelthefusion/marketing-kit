// =============================================================================
// Reference outbox worker — ONE outbox for every channel: Resend (email), Telnyx (SMS + WhatsApp),
// Expo Push + Web Push (push), and the app's own inbox (in_app). Drizzle + pg, Railway.
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
//           WhatsApp: same account; free-form only inside the 24h window, else an approved
//           template (payload.template) · 40008 = template not usable
//   Expo    ≤100 messages per request (SDK chunks) · payload ≤4096 bytes · SDK caps at 6
//           concurrent connections · receipts ~15 min later; DeviceNotRegistered = stop
//   WebPush endpoint 404/410 = subscription gone · 413 = payload too large · 429 = retry-after
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
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import webpush from "web-push";
import { sql } from "drizzle-orm";
import { db } from "../db"; // the app's drizzle instance

const resend = new Resend(process.env.RESEND_API_KEY);
const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY! });
const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });   // token only if "enhanced security" is on

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
const WHATSAPP_MPS = Number(process.env.WHATSAPP_MPS ?? 80);   // per business number (Meta default throughput)
const waSenders = new Map<string, Bucket>();
const waBucket = (from: string) => waSenders.get(from) ?? waSenders.set(from, new Bucket(WHATSAPP_MPS)).get(from)!;
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

export type Channel = "email" | "sms" | "push" | "whatsapp" | "in_app";
type Claimed = {
  id: string; idempotency_key: string; channel: Channel; to_address: string; provider: string;
  from_address: string; subject: string | null; body: string; campaign_id: string | null;
  payload: Record<string, any> | null;
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
    returning m.id, m.idempotency_key, m.channel, m.to_address, m.from_address, m.subject, m.body, m.campaign_id,
              m.provider, m.payload`);

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

  // 4. SMS + WhatsApp → Telnyx, paced per sender number and per account (senders run in parallel)
  const bySender = groupBy(ready.filter((m) => m.channel === "sms" || m.channel === "whatsapp"), (m) => `${m.channel}:${m.from_address}`);
  await Promise.all([...bySender.values()].map(async (msgs) => { for (const m of msgs) await sendTelnyx(m); }));

  // 5. push → Expo Push (native apps) / Web Push (browsers + home-screen PWAs). to_address = crm_devices.id
  const push = ready.filter((m) => m.channel === "push");
  if (push.length) await sendPush(push);

  // 6. in_app → nothing to call: the row IS the inbox item (mobile-growth inbox route reads it)
  for (const m of ready.filter((m) => m.channel === "in_app")) await mark(m.id, "sent");

  // 7. Expo receipts for pushes sent ≥15 min ago (Expo's recommended wait) — part of the loop, no timer
  await processPushReceipts();
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

async function sendTelnyx(m: Claimed) {
  if (m.channel === "whatsapp") await waBucket(m.from_address).take();
  else { await senderBucket(m.from_address).take(); await telnyxAccount.take(); }
  const webhook_url = `${process.env.PUBLIC_URL}/webhooks/telnyx`;
  try {
    const res: any = m.channel === "whatsapp"
      ? await telnyx.messages.whatsapp({
          from: m.from_address, to: m.to_address, webhook_url,
          // outside the 24h customer-service window Meta only delivers approved templates
          whatsapp_message: m.payload?.template
            ? { type: "template", template: m.payload.template }
            : { type: "text", text: { body: m.body, preview_url: true } },
        } as any)
      : await telnyx.messages.send({ from: m.from_address, to: m.to_address, text: m.body, webhook_url });
    const d = res?.data ?? res;
    await mark(m.id, "sent", { providerMessageId: d.id, segments: d.parts });
  } catch (err: any) {
    const code = Number(err?.error?.errors?.[0]?.code ?? err?.errors?.[0]?.code ?? 0);
    const msg = `${code || err?.status || "network"}: ${err?.message ?? err}`.slice(0, 500);
    if (TELNYX_BLOCKS[code]) {
      // Telnyx refuses this recipient — record the provider fact so we stop paying to retry it.
      await db.execute(sql`insert into crm_suppressions (channel, value, reason, source)
        values (${m.channel}::crm_channel, ${m.to_address}, ${TELNYX_BLOCKS[code]}, ${`telnyx:${code}`}) on conflict do nothing`);
      await mark(m.id, "failed", { error: msg });
    } else if (m.channel === "whatsapp" && code === 40008) {
      await mark(m.id, "failed", { error: msg });     // WhatsApp 40008 = template pending/rejected/paused/disabled: retrying can't fix it
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

// ── push ────────────────────────────────────────────────────────────────────────────────────────
type Device = { id: string; push_kind: string | null; push_token: string | null; push_keys: { p256dh: string; auth: string } | null };
async function sendPush(msgs: Claimed[]) {
  const ids = msgs.map((m) => m.to_address);
  const { rows } = await db.execute<Device>(sql`select id, push_kind, push_token, push_keys from crm_devices
    where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and push_status = 'granted'`);
  const dev = new Map(rows.map((d) => [d.id, d]));
  const toExpo: { m: Claimed; msg: ExpoPushMessage }[] = [];
  for (const m of msgs) {
    const d = dev.get(m.to_address);
    if (!d?.push_token) { await mark(m.id, "skipped", { error: "device has no granted push token" }); continue; }
    const url = m.payload?.url as string | undefined;          // deep link: universal link or app scheme
    if (d.push_kind === "expo") {
      if (!Expo.isExpoPushToken(d.push_token)) { await revoke(d.id, "invalid token"); await mark(m.id, "failed", { error: "not an Expo push token" }); continue; }
      toExpo.push({ m, msg: { to: d.push_token, title: m.subject ?? undefined, body: m.body, sound: "default",
        data: { ...(m.payload?.data ?? {}), url, message_id: m.id }, badge: m.payload?.badge, channelId: m.payload?.channelId } });
    } else if (d.push_kind === "webpush" && d.push_keys) {
      await sendWebPush(m, d, url);
    } else await mark(m.id, "skipped", { error: `unknown push kind ${d.push_kind}` });
  }
  for (const chunk of expo.chunkPushNotifications(toExpo.map((x) => x.msg))) {
    const part = toExpo.splice(0, chunk.length);
    let tickets: ExpoPushTicket[];
    try { tickets = await expo.sendPushNotificationsAsync(chunk); }
    catch (err: any) {                                            // whole request refused (429 / 5xx / network)
      const why = [err?.message ?? String(err), err?.cause?.code].filter(Boolean).join(" · ");
      for (const { m } of part) await requeue(m.id, sql`now() + interval '30 seconds'`, `expo: ${why}`.slice(0, 500));
      continue;
    }
    for (let i = 0; i < part.length; i++) {
      const t = tickets[i], m = part[i].m;
      if (t?.status === "ok") { await mark(m.id, "sent", { providerMessageId: t.id }); continue; }
      const code = (t as any)?.details?.error as string | undefined;
      if (code === "DeviceNotRegistered") { await revoke(m.to_address, code); await mark(m.id, "failed", { error: code }); }
      else if (code === "MessageRateExceeded") await requeue(m.id, sql`now() + interval '5 seconds'`, code);
      else await mark(m.id, "failed", { error: `${code ?? "error"}: ${(t as any)?.message ?? ""}`.slice(0, 500) });
    }
  }
}

async function sendWebPush(m: Claimed, d: Device, url?: string) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) { await mark(m.id, "failed", { error: "web push not configured (VAPID_* keys)" }); return; }
  // generateRequestDetails = the encrypted request (RFC 8291) + VAPID auth; sent with fetch so the
  // worker sees the push service's own status codes.
  const req = webpush.generateRequestDetails(
    { endpoint: d.push_token!, keys: d.push_keys! },
    JSON.stringify({ title: m.subject ?? "", body: m.body, url, data: { ...(m.payload?.data ?? {}), message_id: m.id } }),
    { TTL: Number(m.payload?.ttl ?? 86400), urgency: m.payload?.urgency ?? "normal",
      vapidDetails: { subject: VAPID_SUBJECT ?? "mailto:growth@localhost", publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY } },
  );
  try {
    // fetch sets Content-Length from the body itself; web-push hands it (and TTL) over as numbers, which
    // stricter undici builds reject (UND_ERR_INVALID_ARG), so pass string headers without it.
    const headers = Object.fromEntries(Object.entries(req.headers)
      .filter(([k]) => k.toLowerCase() !== "content-length").map(([k, v]) => [k, String(v)]));
    const res = await fetch(req.endpoint, { method: req.method, headers, body: req.body as any });
    if (res.status >= 200 && res.status < 300) await mark(m.id, "sent", { providerMessageId: res.headers.get("location") ?? undefined });
    else if (res.status === 404 || res.status === 410) { await revoke(d.id, `webpush ${res.status}`); await mark(m.id, "failed", { error: `subscription gone (${res.status})` }); }
    else if (res.status === 429) await requeue(m.id, sql`now() + (${Number(res.headers.get("retry-after") ?? 10)} || ' seconds')::interval`, "webpush 429");
    else await mark(m.id, "failed", { error: `webpush ${res.status}: ${(await res.text()).slice(0, 200)}` });
  } catch (err: any) {                                  // network-level: fetch's real reason lives in err.cause
    const why = [err?.message ?? String(err), err?.cause?.code, err?.cause?.message].filter(Boolean).join(" · ");
    await requeue(m.id, sql`now() + interval '30 seconds'`, `webpush: ${why}`.slice(0, 500));
  }
}

export async function processPushReceipts(minAgeMinutes = 15) {
  const { rows } = await db.execute<{ id: string; ticket: string; device: string }>(sql`
    select id, provider_message_id as ticket, to_address as device from crm_messages
    where provider = 'expo' and status = 'sent' and provider_message_id is not null
      and sent_at <= now() - (${minAgeMinutes} || ' minutes')::interval
    limit 1000`);
  if (!rows.length) return 0;
  const byTicket = new Map(rows.map((r) => [r.ticket, r]));
  for (const ids of expo.chunkPushNotificationReceiptIds([...byTicket.keys()])) {
    let receipts: Record<string, any>;
    try { receipts = await expo.getPushNotificationReceiptsAsync(ids); } catch { continue; }   // next loop retries
    for (const [ticket, r] of Object.entries(receipts)) {
      const row = byTicket.get(ticket)!;
      if (r.status === "ok") await db.execute(sql`update crm_messages set status = 'delivered', delivered_at = now() where id = ${row.id}`);
      else {
        if (r.details?.error === "DeviceNotRegistered") await revoke(row.device, "DeviceNotRegistered");
        await mark(row.id, "failed", { error: `${r.details?.error ?? "error"}: ${r.message ?? ""}`.slice(0, 500) });
      }
    }
  }
  return rows.length;
}

// A dead token is a provider fact: record it on the device so nothing retries it.
async function revoke(deviceId: string, why: string) {
  await db.execute(sql`update crm_devices set push_status = 'revoked', push_token = null where id = ${deviceId}::uuid`);
  await db.execute(sql`insert into crm_events (contact_id, name, source, properties, occurred_at)
    select contact_id, 'push.revoked', 'app', jsonb_build_object('device_id', id, 'reason', ${why}::text), now()
    from crm_devices where id = ${deviceId}::uuid`);
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
// push fans out to every device the contact granted (one row per device); in_app targets the contact.
export async function enqueueStep(opts: {
  campaignId: string; step: number; channel: Channel; from: string;
  subject?: (row: any) => string; body: (row: any) => string; payload?: (row: any) => Record<string, unknown>;
  audience: any[]; delayMinutes?: number;
}) {
  for (const row of opts.audience) {
    if (row.holdout) continue;
    const base = `${opts.campaignId}/${row.contact_id}/${opts.step}`;
    let targets: { key: string; to: string; provider: string }[];
    if (opts.channel === "push") {
      const { rows } = await db.execute<{ id: string; push_kind: string }>(sql`select id, push_kind from crm_devices
        where contact_id = ${row.contact_id} and push_status = 'granted' and push_token is not null`);
      targets = rows.map((d) => ({ key: `${base}/d:${d.id}`, to: d.id, provider: d.push_kind }));
    } else {
      const to = opts.channel === "email" ? row.email : opts.channel === "in_app" ? row.contact_id : row.phone_e164;
      const provider = { email: "resend", sms: "telnyx", whatsapp: "telnyx", in_app: "inapp" }[opts.channel];
      targets = to ? [{ key: base, to, provider }] : [];
    }
    for (const t of targets) await db.execute(sql`
      insert into crm_messages (idempotency_key, campaign_id, contact_id, channel, to_address, from_address,
                                subject, body, payload, provider, scheduled_for)
      values (${t.key}, ${opts.campaignId}, ${row.contact_id}, ${opts.channel}, ${t.to}, ${opts.from},
              ${opts.subject?.(row) ?? null}, ${opts.body(row)}, ${opts.payload ? JSON.stringify(opts.payload(row)) : null}::jsonb,
              ${t.provider}, now() + (${opts.delayMinutes ?? 0} || ' minutes')::interval)
      on conflict (idempotency_key) do nothing`);
  }
}
