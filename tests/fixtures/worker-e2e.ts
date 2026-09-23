// Outbox worker E2E: real Postgres + mock providers speaking their real response shapes:
// Resend (email), Telnyx (SMS + WhatsApp), Expo Push (send + receipts), Web Push endpoints.
// Email/SMS are asserted by tests/run.sh from the DB; the mobile channels print OK/FAIL lines.
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import webpush from "web-push";

let batches = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = b && String(req.headers["content-type"] ?? "").includes("json") ? JSON.parse(b) : {};
    const j = (s: number, o: any) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const url = req.url!;
    if (url.startsWith("/emails/batch")) {
      batches++;
      if (body.length > 100) return j(422, { statusCode: 422, name: "validation_error", message: "batch > 100" });
      if (batches === 1) return j(200, { data: body.map((_: any, i: number) => ({ id: `re_${i}` })) });
      return j(429, { statusCode: 429, name: "daily_quota_exceeded", message: "daily quota" });
    }
    if (url.startsWith("/v2/messages/whatsapp")) {
      if (body.to === "+1555" + "0000408") return j(422, { errors: [{ code: "40008", title: "Template not usable" }] });
      return j(200, { data: { id: `wa_${body.to.slice(-3)}`, type: body.whatsapp_message?.type } });
    }
    if (url.startsWith("/v2/messages")) {
      if (body.to === "+1555" + "0000300") return j(422, { errors: [{ code: "40300", title: "Blocked due to STOP message" }] });
      return j(200, { data: { id: `tx_${body.to.slice(-3)}`, parts: 1 } });
    }
    if (url === "/--/api/v2/push/send") {       // Expo: one ticket per message, same order
      return j(200, { data: body.map((m: any, i: number) => m.to.includes("dead")
        ? { status: "error", message: `"${m.to}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: `tk_${i}` }) });
    }
    if (url === "/--/api/v2/push/getReceipts") {
      return j(200, { data: Object.fromEntries(body.ids.map((id: string) => [id, { status: "ok" }])) });
    }
    if (url.startsWith("/wp/ok")) { res.writeHead(201, { location: "/wp/msg/1" }); return res.end(); }
    if (url.startsWith("/wp/gone")) { res.writeHead(410); return res.end(); }
    j(404, {});
  });
});

const C = "00000000-0000-0000-0000-000000000001";
const b64u = (buf: Buffer) => buf.toString("base64url");
function subKeys() {             // a real P-256 subscription key pair, as a browser would send
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  return { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}

srv.listen(Number(process.env.MOCK_PORT), async () => {
  const port = process.env.MOCK_PORT;
  const v = webpush.generateVAPIDKeys();
  Object.assign(process.env, { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "mailto:t@x.co" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s: string, p: unknown[] = []) => pool.query(s, p);
  // devices: 2 Expo (one dead), 2 Web Push (one gone) — all granted
  const dev = async (install: string, platform: string, kind: string, token: string, keys: unknown = null) =>
    (await q(`insert into crm_devices (contact_id, install_id, platform, push_kind, push_token, push_keys, push_status)
              values ($1,$2,$3,$4,$5,$6,'granted') returning id`, [C, install, platform, kind, token, keys])).rows[0].id as string;
  const dOk = await dev("i-ok", "ios", "expo", "ExponentPushToken[okAAAAAAAAAAAAAAAAAAAA]");
  const dDead = await dev("i-dead", "android", "expo", "ExponentPushToken[deadAAAAAAAAAAAAAAAAAA]");
  const wOk = await dev("w-ok", "web", "webpush", `http://localhost:${port}/wp/ok/1`, JSON.stringify(subKeys()));
  const wGone = await dev("w-gone", "web", "webpush", `http://localhost:${port}/wp/gone/1`, JSON.stringify(subKeys()));
  const msg = (key: string, ch: string, to: string, from: string, provider: string, payload: unknown = null) =>
    q(`insert into crm_messages (idempotency_key, contact_id, channel, to_address, from_address, subject, body, payload, provider, scheduled_for)
       values ($1,$2,$3,$4,$5,'Your order shipped','Tap to track it',$6,$7,now())`, [key, C, ch, to, from, payload, provider]);
  const link = JSON.stringify({ url: "https://acme.test/a/orders/1" });
  await msg("p/ok", "push", dOk, "app", "expo", link);
  await msg("p/dead", "push", dDead, "app", "expo", link);
  await msg("p/wok", "push", wOk, "app", "webpush", link);
  await msg("p/wgone", "push", wGone, "app", "webpush", link);
  await msg("wa/1", "whatsapp", "+1555" + "0000001", "+1888" + "0000100", "telnyx");
  await msg("wa/tpl", "whatsapp", "+1555" + "0000408", "+1888" + "0000100", "telnyx", JSON.stringify({ template: { name: "winback", language: { code: "en" } } }));
  await msg("ia/1", "in_app", C, "app", "inapp", JSON.stringify({ kind: "banner", cta: "/a/rewards" }));

  const { drainOutbox, processPushReceipts } = await import(process.env.WORKER!);
  await drainOutbox();
  const receipts = await processPushReceipts(0);        // test: don't wait Expo's 15 minutes

  const one = async (s: string, p: unknown[] = []) => (await q(s, p)).rows[0];
  const st = async (key: string) => one(`select status, error, provider_message_id from crm_messages where idempotency_key = $1`, [key]);
  const check = (name: string, cond: boolean, got?: unknown) => console.log(cond ? `OK   ${name}` : `FAIL ${name} — got ${JSON.stringify(got)}`);
  const pOk = await st("p/ok"), pDead = await st("p/dead"), wo = await st("p/wok"), wg = await st("p/wgone");
  check("expo push sent → receipt ok → delivered", pOk.status === "delivered" && receipts === 1, { pOk, receipts });
  check("expo DeviceNotRegistered → failed + device revoked", pDead.status === "failed" && pDead.error === "DeviceNotRegistered"
    && (await one(`select push_status from crm_devices where id = $1`, [dDead])).push_status === "revoked", pDead);
  check("web push (RFC 8291 encrypted, VAPID) → 201 sent", wo.status === "sent" && wo.provider_message_id === "/wp/msg/1", wo);
  check("web push 410 → failed + subscription revoked", wg.status === "failed"
    && (await one(`select push_status from crm_devices where id = $1`, [wGone])).push_status === "revoked", wg);
  check("push.revoked events recorded for both dead tokens", Number((await one(`select count(*) n from crm_events where name = 'push.revoked'`)).n) === 2);
  const wa = await st("wa/1"), tpl = await st("wa/tpl");
  check("whatsapp via Telnyx → sent", wa.status === "sent" && wa.provider_message_id === "wa_001", wa);
  check("whatsapp template refused (40008) → failed", tpl.status === "failed" && String(tpl.error).includes("40008"), tpl);
  check("in_app → sent with no provider call (row is the inbox item)", (await st("ia/1")).status === "sent");
  await pool.end(); srv.close(); process.exit(0);
});
