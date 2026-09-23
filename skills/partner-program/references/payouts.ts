// =============================================================================
// Partner payouts — PayPal + Venmo (automated), store credit (instant), Cash App + Zelle (sheet).
// Pattern, not a drop-in. Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox|live,
// PAYPAL_WEBHOOK_ID (for verifying payout webhooks).
//
//   buildPayouts(db)          approved, unpaid commissions → one crm_payouts row per partner
//                             (store_credit rows settle immediately into crm_store_credit)
//   sendPayPal(db)            every draft paypal/venmo row → ONE Payouts API batch (≤15,000 items)
//   payoutWebhook(db, req)    PAYMENT.PAYOUTS-ITEM.* → paid / failed / returned
//   manualSheet(db)           Cash App + Zelle drafts with pay links; markPaid(db, id, ref) after
//
// Provider facts (templates/provider-limits.json → paypal): 15,000 items per call;
// sender_batch_id is deduplicated for 30 days, so a retry with the same id can never pay twice;
// on HTTP 5xx retry with the SAME sender_batch_id. Venmo needs a US mobile + a note.
// Cash App's payout API is partner-only and Zelle has no public API — those two stay manual.
// =============================================================================
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Db = NodePgDatabase<Record<string, never>>;
const PP = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const BASE = process.env.PAYPAL_BASE_URL ?? PP;          // tests point this at a mock
const MAX_ITEMS = 15_000;
const dollars = (cents: number) => (cents / 100).toFixed(2);

// ---- build: commissions → payout rows ------------------------------------------------------
export async function buildPayouts(db: Db, minPayoutCents = 0) {
  return db.transaction(async (tx) => {
    // Lock the approved, unpaid rows first (FOR UPDATE can't sit on a GROUP BY) so two payout
    // runs can never claim the same commission.
    await tx.execute(sql`select id from crm_commissions where status = 'approved' and payout_id is null for update`);
    const { rows } = await tx.execute<{ partner_id: string; contact_id: string; method: string; handle: string | null; cents: number }>(sql`
      select pa.id as partner_id, pa.contact_id, pa.payout_method as method, pa.payout_handle as handle,
             sum(c.amount_cents)::bigint as cents
      from crm_commissions c join crm_partners pa on pa.id = c.partner_id
      where c.status = 'approved' and c.payout_id is null
      group by pa.id
      having sum(c.amount_cents) > ${Math.max(minPayoutCents, 0)}`);
    const made: { id: string; method: string; cents: number }[] = [];
    for (const r of rows) {
      const cents = Number(r.cents);
      const provider = r.method === "paypal" || r.method === "venmo" ? "paypal"
                     : r.method === "store_credit" ? "ledger" : "manual";
      const { rows: [p] } = await tx.execute<{ id: string }>(sql`
        insert into crm_payouts (partner_id, method, handle, amount_cents, provider, status)
        values (${r.partner_id}, ${r.method}, ${r.handle}, ${cents}, ${provider}, 'draft') returning id`);
      await tx.execute(sql`
        update crm_commissions set payout_id = ${p.id}
        where partner_id = ${r.partner_id} and status = 'approved' and payout_id is null`);
      if (provider === "ledger") {   // store credit: money moves inside our own ledger, right now
        await tx.execute(sql`
          insert into crm_store_credit (contact_id, amount_cents, kind, ref)
          values (${r.contact_id}, ${cents}, 'commission_payout', ${p.id}) on conflict (kind, ref) do nothing`);
        await markPaidTx(tx, p.id, "store_credit");
      }
      made.push({ id: p.id, method: r.method, cents });
    }
    return made;
  });
}

// ---- PayPal + Venmo ------------------------------------------------------------------------
async function token(): Promise<string> {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`paypal oauth ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

export async function sendPayPal(db: Db, note = "Your partner commission — thank you!") {
  const { rows } = await db.execute<{ id: string; method: string; handle: string | null; amount_cents: number; currency: string }>(sql`
    select id, method, handle, amount_cents, currency from crm_payouts
    where provider = 'paypal' and status = 'draft' and handle is not null order by created_at limit ${MAX_ITEMS}`);
  if (!rows.length) return null;
  // Deterministic batch id: the same set of payouts always yields the same id → PayPal dedupes.
  const senderBatchId = "mk_" + createHash("sha256").update(rows.map((r) => r.id).sort().join(",")).digest("hex").slice(0, 28);
  const body = {
    sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "You have a payout", email_message: note },
    items: rows.map((r) => r.method === "venmo"
      ? { recipient_type: "PHONE", receiver: r.handle, recipient_wallet: "VENMO", note,
          amount: { value: dollars(Number(r.amount_cents)), currency: r.currency }, sender_item_id: r.id }
      : { recipient_type: "EMAIL", receiver: r.handle, recipient_wallet: "PAYPAL", note,
          amount: { value: dollars(Number(r.amount_cents)), currency: r.currency }, sender_item_id: r.id }),
  };
  await db.execute(sql`update crm_payouts set sender_batch_id = ${senderBatchId}
                       where id = any(string_to_array(${rows.map((r) => r.id).join(",")}, ',')::uuid[])`);
  const auth = await token();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/v1/payments/payouts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", "PayPal-Request-Id": senderBatchId },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { batch_header?: { payout_batch_id: string }; name?: string; message?: string };
    if (r.status === 201 || (r.status === 400 && j.name === "DUPLICATE_REQUEST_ID")) {
      await db.execute(sql`
        update crm_payouts set status = 'sent', provider_batch_id = ${j.batch_header?.payout_batch_id ?? null}
        where sender_batch_id = ${senderBatchId} and status = 'draft'`);
      return { senderBatchId, payoutBatchId: j.batch_header?.payout_batch_id ?? null, items: rows.length };
    }
    if (r.status >= 500 && attempt < 4) { await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt)); continue; }
    await db.execute(sql`update crm_payouts set error = ${`${r.status} ${j.name ?? ""} ${j.message ?? ""}`.trim()}
                         where sender_batch_id = ${senderBatchId} and status = 'draft'`);
    throw new Error(`paypal payouts ${r.status} ${j.name ?? ""}`);
  }
}

// PayPal → POST /api/webhooks/paypal. Verify with PayPal, then map the item status.
const ITEM_STATUS: Record<string, "paid" | "failed" | "returned" | null> = {
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "paid",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "failed", "PAYMENT.PAYOUTS-ITEM.DENIED": "failed",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "failed", "PAYMENT.PAYOUTS-ITEM.CANCELED": "failed",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "returned", "PAYMENT.PAYOUTS-ITEM.REFUNDED": "returned",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": null, "PAYMENT.PAYOUTS-ITEM.HELD": null,   // still in flight
};
export async function payoutWebhook(db: Db, req: Request): Promise<Response> {
  const raw = await req.text();
  const event = JSON.parse(raw) as { event_type: string; resource: { payout_item_id: string; payout_item: { sender_item_id: string }; errors?: { message?: string } } };
  const h = (k: string) => req.headers.get(k) ?? "";
  const v = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"),
      webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event,
    }),
  });
  if (((await v.json()) as { verification_status?: string }).verification_status !== "SUCCESS") return new Response("bad signature", { status: 400 });
  const status = ITEM_STATUS[event.event_type];
  if (!status) return new Response("ok");
  const id = event.resource.payout_item.sender_item_id;
  await db.transaction(async (tx) => {
    await tx.execute(sql`update crm_payouts set provider_item_id = ${event.resource.payout_item_id},
                           error = ${event.resource.errors?.message ?? null} where id = ${id}`);
    if (status === "paid") await markPaidTx(tx, id, event.resource.payout_item_id);
    else await releaseTx(tx, id, status);
  });
  return new Response("ok");
}

// ---- Cash App + Zelle: the payout sheet ----------------------------------------------------
export async function manualSheet(db: Db) {
  const { rows } = await db.execute<{ id: string; method: string; handle: string | null; amount_cents: number; name: string | null }>(sql`
    select p.id, p.method, p.handle, p.amount_cents, pa.display_name as name
    from crm_payouts p join crm_partners pa on pa.id = p.partner_id
    where p.provider = 'manual' and p.status = 'draft' order by p.amount_cents desc`);
  return rows.map((r) => ({
    ...r,
    amount: dollars(Number(r.amount_cents)),
    // Cash App opens the pay screen with the amount filled in; Zelle is sent from your bank app.
    payLink: r.method === "cashapp" && r.handle ? `https://cash.app/${r.handle.startsWith("$") ? r.handle : "$" + r.handle}/${dollars(Number(r.amount_cents))}` : null,
  }));
}
export async function markPaid(db: Db, payoutId: string, ref: string) {
  await db.transaction((tx) => markPaidTx(tx, payoutId, ref));
}

// ---- shared ---------------------------------------------------------------------------------
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function markPaidTx(tx: Tx, payoutId: string, ref: string) {
  await tx.execute(sql`update crm_payouts set status = 'paid', paid_at = now(), paid_ref = ${ref} where id = ${payoutId}`);
  await tx.execute(sql`update crm_commissions set status = 'paid' where payout_id = ${payoutId}`);
}
// Failed / returned: the money never left, so the commissions go back to "approved, unpaid".
async function releaseTx(tx: Tx, payoutId: string, status: "failed" | "returned") {
  await tx.execute(sql`update crm_payouts set status = ${status} where id = ${payoutId}`);
  await tx.execute(sql`update crm_commissions set payout_id = null, status = 'approved' where payout_id = ${payoutId}`);
}
