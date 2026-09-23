// Mobile E2E (mobile-growth): association files, store handoff, device registration, install
// claims → the SAME creator attribution as the web, Apple Ads (mock AdServices), AdAttributionKit
// copies, in-app inbox + engagement, review moments. Real Postgres (programs DB: partner "maya").
import http from "node:http";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

let ads = 0;
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    ads++;
    if (ads === 1) { res.writeHead(404); return res.end(); }                       // "not ready yet"
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ attribution: b === "tok-good", orgId: 40669820, campaignId: 542370539, conversionType: "Download",
      claimType: "Click", adGroupId: 542317095, countryOrRegion: "US", keywordId: 87675432, adId: 542317136 }));
  });
}).listen(4997);
Object.assign(process.env, {
  MKT_IOS_APP_IDS: "TEAM123456.com.acme.app", MKT_IOS_APP_STORE_ID: "6450000000",
  MKT_ANDROID_PACKAGE: "com.acme.app", MKT_ANDROID_SHA256: "AB:CD:EF",
  APPLE_ADSERVICES_URL: "http://localhost:4997/api/v1/", APPLE_ADSERVICES_RETRY_MS: "30",
});
const m = await import("./ref/app-server.ts");
const { attributeOrder, partnerQr, shortLink } = await import("./ref/partner-tracking.ts");
const pj: any = await import("pngjs"); const PNG = pj.PNG ?? pj.default.PNG;
const jq: any = await import("jsqr"); const jsQR = jq.default?.default ?? jq.default ?? jq;   // UMD bundle
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const one = async (s: string, p: unknown[] = []) => (await q(s, p)).rows[0];
const check = (name: string, cond: boolean, got?: unknown) => console.log(cond ? `OK   ${name}` : `FAIL ${name} — got ${JSON.stringify(got)}`);

const E1 = "00000000-0000-0000-0000-0000000000e1", E2 = "00000000-0000-0000-0000-0000000000e2";
await q(`insert into crm_contacts (id, email) values ($1,'e1@x.test'),($2,'e2@x.test')`, [E1, E2]);

// A. association files
const aasa: any = await m.appleAppSiteAssociation().json();
check("AASA: app id + /r/* and /a/* claimed", aasa.applinks.details[0].appIDs[0] === "TEAM123456.com.acme.app"
  && aasa.applinks.details[0].components.map((c: any) => c["/"]).join(",") === "/r/*,/a/*", aasa);
const al: any = await m.assetLinks().json();
check("assetlinks.json: package + fingerprint", al[0].target.package_name === "com.acme.app" && al[0].target.sha256_cert_fingerprints[0] === "AB:CD:EF", al);

// B. store handoff (mobile web visitor who came through maya's link)
const WEB = "11111111-1111-4111-8111-111111111111";
await q(`insert into crm_events (name, source, anon_id, properties, occurred_at) values ('partner.clicked','web',$1,'{"code":"maya","device":"mobile"}', now())`, [WEB]);
const links = m.storeLinks({ code: "Maya", webAnonId: WEB, utm: { utm_source: "tiktok" }, appArgument: "https://acme.test/r/maya" });
const referrer = decodeURIComponent(new URL(links.android!).searchParams.get("referrer")!);
check("Play URL carries mk_ref + mk_click + utm through the install", referrer === `mk_ref=maya&mk_click=${WEB}&utm_source=tiktok`, referrer);
check("smart app banner + App Store URL", links.ios === "https://apps.apple.com/app/id6450000000" && links.smartBanner!.includes("app-argument=https://acme.test/r/maya"), links);

// B2. QR: the same /r/ link, tagged, decodable; the redirect keeps the tag
const qrSvg = await partnerQr(db as any, "Maya", new Request("https://acme.test/r/maya/qr"));
check("QR SVG for a real code", qrSvg.status === 200 && qrSvg.headers.get("content-type") === "image/svg+xml" && (await qrSvg.text()).includes("<svg"));
const qrPng = await partnerQr(db as any, "maya", new Request("https://acme.test/r/maya/qr?format=png&size=512"));
const img = PNG.sync.read(Buffer.from(await qrPng.arrayBuffer()));
const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data;
check("QR PNG decodes to /r/maya?utm_source=qr&utm_medium=print", decoded === "https://acme.test/r/maya?utm_source=qr&utm_medium=print", decoded);
check("QR for an unknown code → 404", (await partnerQr(db as any, "nobody", new Request("https://acme.test/r/nobody/qr"))).status === 404);
const hop = (await shortLink(db as any, "maya", new Request(decoded!))).headers.get("location") ?? "";
check("scan → redirect keeps ref + utm_source=qr", hop.includes("ref=maya") && hop.includes("utm_source=qr"), hop);

// C. devices
const r1 = await m.registerDevice(db as any, null, { install_id: "ios-A", platform: "ios", push: { kind: "expo", token: "ExponentPushToken[AAA]" }, app_version: "1.0" });
check("device registered, push granted", r1.ok && r1.pushStatus === "granted", r1);
await m.registerDevice(db as any, null, { install_id: "ios-A2", platform: "ios", push: { kind: "expo", token: "ExponentPushToken[AAA]" } });
check("reinstall moves the token: old install revoked", (await one(`select push_status, push_token from crm_devices where install_id='ios-A'`)).push_status === "revoked");
await m.registerDevice(db as any, null, { install_id: "and-B", platform: "android", app_version: "1.0" });

// D. claims
const cA = await m.claimInstall(db as any, { install_id: "ios-A", platform: "ios", url: "https://acme.test/r/maya" });
check("iOS universal link claim → ref maya|ms", /^maya\|\d{13}$/.test(cA.ok ? String(cA.ref) : ""), cA);
const cB = await m.claimInstall(db as any, { install_id: "and-B", platform: "android", referrer });
check("Android install referrer claim → ref maya + web click linked", cB.ok && String(cB.ref).startsWith("maya|")
  && (await one(`select click_id from crm_app_installs where install_id='and-B'`)).click_id === WEB, cB);
const cX = await m.claimInstall(db as any, { install_id: "ios-X", platform: "ios", code: "nobody" });
check("unknown code → no claim, no ref", cX.ok && cX.ref === null && Number((await one(`select count(*) n from crm_app_installs where install_id='ios-X'`)).n) === 0, cX);
await m.claimInstall(db as any, { install_id: "ios-A", platform: "ios", url: "https://acme.test/r/maya" });
check("claim replay is idempotent", Number((await one(`select count(*) n from crm_app_installs where install_id='ios-A'`)).n) === 1
  && Number((await one(`select count(*) n from crm_events where anon_id='ios-A' and name='partner.clicked'`)).n) === 1);

// E. login stitch + checkout attribution (same attributeOrder as the web)
await m.stitchInstall(db as any, E1, "ios-A");
await m.stitchInstall(db as any, E2, "and-B");
check("stitch: the web visit before the store now belongs to the app user", (await one(`select contact_id from crm_events where anon_id=$1`, [WEB])).contact_id === E2);
const refA = await m.refForCheckout(db as any, "ios-A");
const att = await db.transaction((tx) => attributeOrder(tx as any, { id: "app-o1", contactId: E1, netCents: 5000, refCookie: refA, paidAt: new Date() }));
check("app order credited to maya by link (no mobile branch in attributeOrder)", (att as any)?.method === "link"
  && (await one(`select code, method from crm_attributions where order_id='app-o1'`))?.method === "link", att);
const refByContact = await m.refForCheckout(db as any, null, E2);
check("server fallback finds the ref by contact", String(refByContact).startsWith("maya|"), refByContact);

// F. Apple Ads (404 once → retry → attribution)
const aa = await m.appleAdsAttribution(db as any, "ios-A", "tok-good");
check("Apple Ads: 404 retried, campaign stored", aa.ok && (aa as any).attributed === true && ads === 2
  && (await one(`select campaign->>'campaignId' c from crm_app_installs where install_id='ios-A' and source='apple_ads'`)).c === "542370539", aa);

// G. AdAttributionKit copy
const post = { "jws-string": "eyJ…", "source-identifier": "3712", "conversion-value": 42, "did-win": true, "postback-sequence-index": 0 };
const req = () => new Request("https://acme.test/.well-known/appattribution/report-attribution/", { method: "POST", body: JSON.stringify(post) });
const s1 = await m.attributionCopy(db as any, "adattributionkit", req()); await m.attributionCopy(db as any, "adattributionkit", req());
check("AdAttributionKit copy stored once (dedupe), fields parsed", s1.status === 200
  && Number((await one(`select count(*) n from crm_app_installs where source='adattributionkit'`)).n) === 1
  && (await one(`select campaign->>'conversion' c from crm_app_installs where source='adattributionkit'`)).c === "42");

// H. inbox + engagement
const msg = await one(`insert into crm_messages (idempotency_key, contact_id, channel, to_address, from_address, subject, body, provider, status, sent_at)
  values ('ia/e1', $1, 'in_app', $2, 'app', 'You are $22 from Silver', 'Tap to see rewards', 'inapp', 'sent', now()) returning id`, [E1, E1]);
const box = await m.inbox(db as any, E1);
check("inbox lists the in-app message", box.length === 1 && (box[0] as any).seen === false, box);
await m.engaged(db as any, E1, msg.id, "opened");
check("open → status opened + in_app.opened event", (await one(`select status from crm_messages where id=$1`, [msg.id])).status === "opened"
  && Number((await one(`select count(*) n from crm_events where name='in_app.opened' and contact_id=$1`, [E1])).n) === 1);

// I. review moments
check("no peak event → don't ask", (await m.reviewMoment(db as any, E1, "ios-A", "1.0")) === false);
await q(`insert into crm_events (contact_id, name, source, occurred_at) values ($1,'order.delivered','app', now())`, [E1]);
check("peak moment → ask", (await m.reviewMoment(db as any, E1, "ios-A", "1.0")) === true);
await q(`insert into crm_events (anon_id, name, source, properties, occurred_at) values ('ios-A','app.review_prompted','mobile_app','{"app_version":"1.0"}', now())`);
check("already asked this version → don't ask again", (await m.reviewMoment(db as any, E1, "ios-A", "1.0")) === false);
check("new version + peak → ask", (await m.reviewMoment(db as any, E1, "ios-A", "1.1")) === true);

await pool.end(); mock.close();
