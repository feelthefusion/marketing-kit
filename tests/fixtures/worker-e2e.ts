// Outbox worker E2E: real Postgres + a mock Resend/Telnyx speaking the providers' real error shapes.
// Asserted by tests/run.sh from the DB state afterwards.
import http from "node:http";
let batches = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = b ? JSON.parse(b) : {};
    const j = (s: number, o: any) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url!.startsWith("/emails/batch")) {
      batches++;
      if (body.length > 100) return j(422, { statusCode: 422, name: "validation_error", message: "batch > 100" });
      if (batches === 1) return j(200, { data: body.map((_: any, i: number) => ({ id: `re_${i}` })) });
      return j(429, { statusCode: 429, name: "daily_quota_exceeded", message: "daily quota" });
    }
    if (req.url!.startsWith("/v2/messages")) {
      if (body.to === "+15550000300") return j(422, { errors: [{ code: "40300", title: "Blocked due to STOP message" }] });
      return j(200, { data: { id: `tx_${body.to.slice(-3)}`, parts: 1 } });
    }
    j(404, {});
  });
}).listen(Number(process.env.MOCK_PORT), async () => {
  const { drainOutbox } = await import(process.env.WORKER!);
  await drainOutbox(); srv.close(); process.exit(0);
});
