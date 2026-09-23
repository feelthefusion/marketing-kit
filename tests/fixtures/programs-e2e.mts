// Partner + loyalty E2E: real Postgres + a mock PayPal speaking the real Payouts API shapes.
// Run by tests/run.sh after schema + programs-seed.sql; prints "OK <name>" / "FAIL <name>" lines.
import http from "node:http";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

const seen: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let payoutCalls = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = b && req.headers["content-type"]?.includes("json") ? JSON.parse(b) : b;
    seen.push({ path: req.url!, headers: req.headers, body });
    const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/v1/oauth2/token") return send(200, { access_token: "A21-test", expires_in: 32400 });
    if (req.url === "/v1/payments/payouts") {
      payoutCalls++;
      if (payoutCalls === 1) return send(503, { name: "SERVICE_UNAVAILABLE" });            // first try: transient
      return send(201, { batch_header: { payout_batch_id: "PB-123", batch_status: "PENDING", sender_batch_header: body.sender_batch_header } });
    }
    if (req.url === "/v1/notifications/verify-webhook-signature") return send(200, { verification_status: "SUCCESS" });
    send(404, {});
  });
});
await new Promise<void>((r) => srv.listen(0, r));
process.env.PAYPAL_BASE_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
process.env.PAYPAL_CLIENT_ID = "cid"; process.env.PAYPAL_CLIENT_SECRET = "sec"; process.env.PAYPAL_WEBHOOK_ID = "WH";

const { attributeOrder, settle } = await import("./ref/partner-tracking.ts");
const { buildPayouts, sendPayPal, payoutWebhook, manualSheet, markPaid } = await import("./ref/payouts.ts");
const { settleLoyalty, redeem, awardAction, spendCredit, status } = await import("./ref/loyalty.ts");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const q = async (s: string) => (await pool.query(s)).rows;
const ok = (name: string, cond: boolean, extra: unknown = "") => console.log(`${cond ? "OK" : "FAIL"} ${name}${cond ? "" : " " + JSON.stringify(extra)}`);
const B3 = "00000000-0000-0000-0000-0000000000b3", MAYA_C = "00000000-0000-0000-0000-00000000c001", MAYA = "00000000-0000-0000-0000-0000000000a1";

// ---- attribution paths ----------------------------------------------------------------------
await q(`insert into crm_contacts (id, email) values ('00000000-0000-0000-0000-0000000000d1','d1@x.test'),('00000000-0000-0000-0000-0000000000d2','d2@x.test'),('00000000-0000-0000-0000-0000000000d3','d3@x.test')`);
const order = async (id: string, contact: string, cents: number, kind = "new") =>
  q(`insert into crm_revenue (id, contact_id, kind, amount_cents, currency, occurred_at) values ('${id}','${contact}','${kind}',${cents},'USD',now())`);
const now = new Date(Date.now() + 60_000);   // order.paid time: after the rows the test inserted
await order("t1", "00000000-0000-0000-0000-0000000000d1", 10000);
const a1 = await db.transaction((tx) => attributeOrder(tx, { id: "t1", contactId: "00000000-0000-0000-0000-0000000000d1", netCents: 10000, typedCode: "MAYA", refCookie: `ref10|${Date.now()}`, paidAt: now }));
ok("typed code beats another partner's cookie", a1?.partnerId === MAYA && a1?.method === "code", a1);
await order("t2", "00000000-0000-0000-0000-0000000000d2", 5000);
const a2 = await db.transaction((tx) => attributeOrder(tx, { id: "t2", contactId: "00000000-0000-0000-0000-0000000000d2", netCents: 5000, refCookie: encodeURIComponent(`maya|${Date.now() - 86_400_000}`), paidAt: now }));
ok("fresh ?ref cookie → link attribution", a2?.method === "link" && a2.newCustomer === true, a2);
await order("t3", "00000000-0000-0000-0000-0000000000d3", 5000);
const a3 = await db.transaction((tx) => attributeOrder(tx, { id: "t3", contactId: "00000000-0000-0000-0000-0000000000d3", netCents: 5000, refCookie: `maya|${Date.now() - 31 * 86_400_000}`, paidAt: now }));
ok("cookie older than plan cookie_days → no attribution", a3 === null, a3);
await order("t4", MAYA_C, 7000);
const a4 = await db.transaction((tx) => attributeOrder(tx, { id: "t4", contactId: MAYA_C, netCents: 7000, typedCode: "maya", paidAt: now }));
ok("partner using own code → not attributed", a4 === null, a4);
await q(`update crm_commission_plans set recurring_months = 6 where id = 'creator'`);
await order("t5", "00000000-0000-0000-0000-0000000000d1", 4000, "renewal");
const a5 = await db.transaction((tx) => attributeOrder(tx, { id: "t5", contactId: "00000000-0000-0000-0000-0000000000d1", netCents: 4000, paidAt: now }));
ok("repeat order inside recurring_months → recurring credit", a5?.method === "recurring" && a5.newCustomer === false, a5);
const replay = await db.transaction((tx) => attributeOrder(tx, { id: "t1", contactId: "00000000-0000-0000-0000-0000000000d1", netCents: 10000, typedCode: "maya", paidAt: now }));
ok("replayed order.paid is harmless (one attribution row)", (await q(`select count(*)::int n from crm_attributions where order_id='t1'`))[0].n === 1, replay);
const ev = await q(`select count(*)::int n from crm_events where name='partner.order_attributed'`);
ok("attribution emits partner.order_attributed for the optimizer", ev[0].n === 3, ev);

// ---- money: settle (partner.sql 1–3, read from the file) → payouts --------------------------
await settle(db);
const pend = await q(`select count(*)::int n from crm_commissions where order_id in ('t1','t2','t5') and status='pending'`);
ok("settle() accrues the new orders (pending, inside the hold)", pend[0].n === 3, pend);
const made = await buildPayouts(db);
const venmo = made.find((m) => m.method === "venmo"), credit = made.find((m) => m.method === "store_credit");
ok("buildPayouts: one row per partner with the approved balance", venmo?.cents === 10050 && credit?.cents === 1000, made);
const sc = await q(`select sum(amount_cents)::int c from crm_store_credit where kind='commission_payout'`);
ok("store-credit partner paid instantly into the ledger", sc[0].c === 1000, sc);
ok("no double claim: second build finds nothing", (await buildPayouts(db)).length === 0);

const sent = await sendPayPal(db);
const calls = seen.filter((s) => s.path === "/v1/payments/payouts");
const item = calls[1]?.body?.items?.[0];
ok("PayPal 5xx retried with the SAME sender_batch_id", calls.length === 2 && calls[0].body.sender_batch_header.sender_batch_id === calls[1].body.sender_batch_header.sender_batch_id
   && calls[1].headers["paypal-request-id"] === calls[1].body.sender_batch_header.sender_batch_id, calls.map((c) => c.body?.sender_batch_header));
ok("Venmo item shape: PHONE + recipient_wallet VENMO + note + $100.50", item?.recipient_type === "PHONE" && item?.recipient_wallet === "VENMO"
   && item?.receiver === "+14155550101" && item?.amount?.value === "100.50" && !!item?.note, item);
ok("payout marked sent with PayPal's batch id", sent?.payoutBatchId === "PB-123" && (await q(`select status from crm_payouts where method='venmo'`))[0].status === "sent");

const pid = (await q(`select id from crm_payouts where method='venmo'`))[0].id;
const hook = (type: string) => new Request("http://x/api/webhooks/paypal", { method: "POST", headers: { "paypal-transmission-id": "t" },
  body: JSON.stringify({ event_type: type, resource: { payout_item_id: "PI-9", payout_item: { sender_item_id: pid } } }) });
await payoutWebhook(db, hook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"));
const paid = await q(`select (select status from crm_payouts where id='${pid}') p, (select count(*)::int from crm_commissions where payout_id='${pid}' and status<>'paid') unpaid`);
ok("PAYOUTS-ITEM.SUCCEEDED webhook → payout + its commissions paid", paid[0].p === "paid" && paid[0].unpaid === 0, paid);

// returned payout → commissions released back to approved/unpaid (money never left)
await q(`update crm_payouts set status='sent' where id='${pid}'`);
await payoutWebhook(db, hook("PAYMENT.PAYOUTS-ITEM.RETURNED"));
const rel = await q(`select count(*)::int n from crm_commissions where partner_id='${MAYA}' and status='approved' and payout_id is null`);
ok("RETURNED webhook → commissions released for the next run", rel[0].n > 0, rel);

// Cash App partner → manual sheet with a prefilled pay link
await q(`update crm_partners set payout_method='cashapp', payout_handle='mayamakes' where id='${MAYA}'`);
await buildPayouts(db);
const sheet = await manualSheet(db);
ok("Cash App payout on the sheet with a prefilled cash.app link", sheet[0]?.payLink === "https://cash.app/$mayamakes/100.50", sheet);
await markPaid(db, sheet[0].id, "cashapp-conf-777");
ok("markPaid records the manual reference", (await q(`select paid_ref from crm_payouts where id='${sheet[0].id}'`))[0].paid_ref === "cashapp-conf-777");

// ---- loyalty ---------------------------------------------------------------------------------
await settleLoyalty(db);
const st = await status(db, B3) as any;
ok("settleLoyalty (loyalty.sql 2–3 from the file) earns points", Number(st?.points) === 280, st);
ok("redeem refuses when points are short", (await redeem(db, B3, "ten-off")).ok === false);
ok("awardAction is once per key", (await awardAction(db, B3, "review:sku1", 300)) === true && (await awardAction(db, B3, "review:sku1", 300)) === false);
const r = await redeem(db, B3, "ten-off");
const after = await status(db, B3) as any;
ok("redeem: −500 points, +$10 store credit", r.ok === true && Number(after.points) === 80 && Number(after.store_credit_cents) === 1000, { r, after });
const used = await db.transaction((tx) => spendCredit(tx, B3, "t9", 2500));
ok("spendCredit caps at the balance and is ledgered", used === 1000 && Number(((await status(db, B3)) as any).store_credit_cents) === 0, used);

await pool.end(); srv.close();
