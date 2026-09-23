// =============================================================================
// Meta Conversions API — send YOUR paid orders to Meta server-side, so Meta's delivery model
// optimizes on real sales (incl. creator/affiliate-attributed ones), not on pixel guesses.
// Pattern, not a drop-in. Env: META_PIXEL_ID, META_CAPI_TOKEN (System User token),
// META_GRAPH_VERSION (default v26.0 — current as of 2026-07-29), META_TEST_EVENT_CODE (optional).
//
//   Call sendPurchase() from the order.paid handler (or the outbox worker). event_id = order id,
//   and the browser Pixel must fire Purchase with the SAME eventID → Meta dedupes the pair.
//   Identifiers are normalized + SHA-256 hashed here; raw email/phone never leave the server.
// =============================================================================
import { createHash } from "node:crypto";

const VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
const GRAPH = process.env.META_GRAPH_BASE ?? "https://graph.facebook.com";
const h = (v: string) => createHash("sha256").update(v).digest("hex");
const norm = {
  email: (e: string) => e.trim().toLowerCase(),
  phone: (p: string) => p.replace(/\D/g, ""),          // E.164 digits, no "+"
  name: (n: string) => n.trim().toLowerCase(),
};

export type CapiPurchase = {
  orderId: string; contactId: string; valueCents: number; currency: string; paidAt: Date;
  email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null;
  ip?: string | null; userAgent?: string | null;
  fbp?: string | null;        // _fbp cookie
  fbc?: string | null;        // _fbc cookie, or "fb.1.<ts>.<fbclid>" built from ?fbclid=
  url?: string | null;        // checkout / confirmation URL
  partnerCode?: string | null; // creator/affiliate code → custom_data, so creator sales are visible in Meta
  items?: { id: string; quantity: number; priceCents: number }[];
};

export async function sendPurchase(p: CapiPurchase) {
  const user_data: Record<string, unknown> = { external_id: [h(p.contactId)] };
  if (p.email) user_data.em = [h(norm.email(p.email))];
  if (p.phone) user_data.ph = [h(norm.phone(p.phone))];
  if (p.firstName) user_data.fn = [h(norm.name(p.firstName))];
  if (p.lastName) user_data.ln = [h(norm.name(p.lastName))];
  if (p.ip) user_data.client_ip_address = p.ip;
  if (p.userAgent) user_data.client_user_agent = p.userAgent;
  if (p.fbp) user_data.fbp = p.fbp;
  if (p.fbc) user_data.fbc = p.fbc;

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(p.paidAt.getTime() / 1000),
      event_id: p.orderId,                 // == Pixel eventID → deduplicated
      action_source: "website",
      event_source_url: p.url ?? undefined,
      user_data,
      custom_data: {
        currency: p.currency, value: p.valueCents / 100, order_id: p.orderId,
        ...(p.partnerCode ? { partner_code: p.partnerCode } : {}),
        ...(p.items ? { contents: p.items.map((i) => ({ id: i.id, quantity: i.quantity, item_price: i.priceCents / 100 })), content_type: "product" } : {}),
      },
    }],
    ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
  };
  const r = await fetch(`${GRAPH}/${VERSION}/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { events_received?: number; error?: { message: string; code: number } };
  if (!r.ok) throw Object.assign(new Error(`meta capi ${r.status}: ${j.error?.message ?? ""}`), { retriable: r.status >= 500 || r.status === 429 });
  return j.events_received ?? 0;
}

// Build fbc from a landing URL's fbclid when the _fbc cookie is missing (Meta's documented format).
export const fbcFromClickId = (fbclid: string, at = Date.now()) => `fb.1.${at}.${fbclid}`;
