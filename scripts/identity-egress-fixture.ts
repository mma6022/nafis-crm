// identity_egress fixture (masked copy only). Run: CRM_DATABASE_PATH=<masked copy> IDF_CERT=c.pem IDF_KEY=k.pem
//   node scripts/run-bundled-fixture.mjs scripts/identity-egress-fixture.ts
// Local fakes only: an HMAC relay, a CONNECT proxy and an HTTPS "s.api.ir". No network, no real IDs.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const FAKE_NID = "0000000018", FAKE_MOBILE = "09000001234", FAKE_TOKEN = "FIXTURE-TOKEN-zz81", FAKE_SECRET = "FIXTURE-SECRET-yy73";
const cert = readFileSync(process.env.IDF_CERT!, "utf8"), key = readFileSync(process.env.IDF_KEY!, "utf8");
let fails = 0; const ok = (c: boolean, m: string) => { console.error(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };

// fake relay (tunnel path)
const relayHits: { path: string; sig: boolean }[] = [];
const relay = http.createServer((req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
  relayHits.push({ path: req.url ?? "", sig: !!req.headers["x-relay-signature"] });
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true, data: true })); }); });
// fake s.api.ir
let upstreamMode: "ok" | "401" = "ok";
const upHits: { path: string; auth: string; body: any }[] = [];
const up = https.createServer({ cert, key }, (req, res) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
  upHits.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(b || "{}") });
  res.setHeader("content-type", "application/json");
  if (upstreamMode === "401") { res.statusCode = 401; res.end("{}"); return; }
  if ((req.url ?? "").endsWith("PersonInfo")) res.end(JSON.stringify({ success: true, data: { firstName: "تست", lastName: "ماسک", fatherName: "پدر" } }));
  else if ((req.url ?? "").endsWith("PostalCodeInfo")) res.end(JSON.stringify({ success: true, data: { address: "آدرس تستی" } }));
  else res.end(JSON.stringify({ success: true, data: true })); }); });
// fake CONNECT proxy
let proxyMode: "ok" | "403" = "ok";
const connects: string[] = [];
const proxy = http.createServer((_q, r) => { r.statusCode = 405; r.end(); });
proxy.on("connect", (req, csock, head) => {
  connects.push(req.url ?? "");
  if (proxyMode === "403") { csock.end("HTTP/1.1 403 Filtered\r\n\r\n"); return; }
  const s = net.connect(upPort, "127.0.0.1", () => { csock.write("HTTP/1.1 200 Connection established\r\n\r\n"); s.write(head); s.pipe(csock); csock.pipe(s); });
  s.on("error", () => csock.destroy());
});
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));
const relayPort = await listen(relay); const upPort = await listen(up); const proxyPort = await listen(proxy);

process.env.SAPI_RELAY_URL = `http://127.0.0.1:${relayPort}`;
process.env.IR_RELAY_SHARED_SECRET = FAKE_SECRET;
process.env.SAPI_API_TOKEN = FAKE_TOKEN;
process.env.SMS_PROXY_URL = `http://127.0.0.1:${proxyPort}`;

const db = new DatabaseSync(process.env.CRM_DATABASE_PATH!);
const setFlag = (v: string | null) => { if (v === null) db.prepare("DELETE FROM call_queue_settings WHERE key='identity_egress'").run();
  else db.prepare("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES('identity_egress',?,NULL,'2026-10-29T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v); };
const { verifyCustomer } = await import("../src/lib/sapi");
const { identityEgress, __setIdentityTestTarget } = await import("../src/lib/identity-egress");
__setIdentityTestTarget({ host: "127.0.0.1", port: upPort, ca: cert });
const input = { nationalCode: FAKE_NID, mobile: FAKE_MOBILE, birthDateJalali: "1370/01/01", postalCode: "1111111111" };
const reset = () => { relayHits.length = 0; upHits.length = 0; connects.length = 0; };

// 1 default (absent) = tunnel
setFlag(null); reset();
ok(identityEgress() === "tunnel", "T1 absent key -> tunnel");
let r = await verifyCustomer(input);
ok(r.status === "verified" && relayHits.length === 4 && relayHits.every((h) => h.sig), "T1 tunnel: 4 signed relay calls, verified");
ok(connects.length === 0 && upHits.length === 0, "T1 tunnel: proxy and s.api.ir not touched");
ok(relayHits.map((h) => h.path).sort().join(",") === "/personInfo,/postalCodeInfo,/sana,/shahkarLite", "T1 relay paths unchanged");
// 2 explicit tunnel + junk values
for (const v of ["tunnel", "PROXY", "proxy ", "1", ""]) { setFlag(v); ok(identityEgress() === "tunnel", `T2 value ${JSON.stringify(v)} -> tunnel`); }
setFlag("tunnel"); reset(); r = await verifyCustomer(input);
ok(relayHits.length === 4 && connects.length === 0, "T2 explicit tunnel uses relay only");
// 3 proxy happy path
setFlag("proxy"); reset();
ok(identityEgress() === "proxy", "T3 'proxy' -> proxy");
r = await verifyCustomer(input);
ok(relayHits.length === 0, "T3 proxy: relay not touched");
ok(connects.length === 4 && connects.every((c) => c === `127.0.0.1:${upPort}`), "T3 proxy: 4 CONNECTs to the (test) s.api.ir target");
ok(upHits.map((h) => h.path).sort().join(",") === "/api/sw1/PersonInfo,/api/sw1/PostalCodeInfo,/api/sw1/Sana,/api/sw1/ShahkarLite", "T3 direct SAPI paths");
ok(upHits.every((h) => h.auth === `Bearer ${FAKE_TOKEN}`), "T3 Bearer token sent upstream only");
ok(upHits.find((h) => h.path.endsWith("ShahkarLite"))?.body.mobile === FAKE_MOBILE && upHits.find((h) => h.path.endsWith("Sana"))?.body.isCompany === false, "T3 payloads unchanged");
ok(r.status === "verified" && r.canonical.officialFirstName === "تست" && r.canonical.officialLastName === "ماسک", "T3 result parsed the same (verified + canonical names)");
// 4 subset of checks
reset(); r = await verifyCustomer(input, {}, ["shahkarLite"]);
ok(upHits.length === 1 && connects.length === 1 && r.checks.personInfo.providerStatus === "not_requested", "T4 selected check only");
// 5 proxy refuses CONNECT -> failed, nothing sent, 3 tunnel tries per check
proxyMode = "403"; reset(); r = await verifyCustomer(input, {}, ["shahkarLite"]);
ok(r.status === "failed" && r.checks.shahkarLite.providerStatus === "identity_proxy_proxy_connect_http_403", `T5 refused CONNECT -> ${r.checks.shahkarLite.providerStatus}`);
ok(connects.length === 3 && upHits.length === 0 && relayHits.length === 0, "T5 3 tunnel attempts, no request bytes, no relay fallback");
proxyMode = "ok";
// 6 upstream 401 -> failed, not retried
upstreamMode = "401"; reset(); r = await verifyCustomer(input, {}, ["sana"]);
ok(r.status === "failed" && r.checks.sana.providerStatus === "SAPI request failed (401)" && upHits.length === 1, "T6 upstream 401 -> failed, single request (no retry)");
upstreamMode = "ok";
// 7 missing proxy env / token
delete process.env.SMS_PROXY_URL; reset(); r = await verifyCustomer(input, {}, ["sana"]);
ok(r.checks.sana.providerStatus === "identity_proxy_not_configured" && upHits.length + relayHits.length + connects.length === 0, "T7 no SMS_PROXY_URL -> identity_proxy_not_configured, nothing sent");
process.env.SMS_PROXY_URL = `http://u:p@127.0.0.1:${proxyPort}`; reset(); r = await verifyCustomer(input, {}, ["sana"]);
ok(r.checks.sana.providerStatus === "identity_proxy_invalid" && connects.length === 0, "T7b proxy URL with credentials rejected (same rule as SMS)");
process.env.SMS_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
delete process.env.SAPI_API_TOKEN; reset(); r = await verifyCustomer(input, {}, ["sana"]);
ok(r.checks.sana.providerStatus === "SAPI provider is not configured" && connects.length === 0, "T7c no token -> not configured, nothing sent");
process.env.SAPI_API_TOKEN = FAKE_TOKEN;
// 8 switch back to tunnel without restart
setFlag("tunnel"); reset(); r = await verifyCustomer(input, {}, ["sana"]);
ok(relayHits.length === 1 && connects.length === 0, "T8 back to tunnel at runtime (no restart)");
// 9 retained checks never re-queried
setFlag("proxy"); reset(); r = await verifyCustomer(input, { shahkarLite: { ok: true, completed: true } }, ["shahkarLite"]);
ok(connects.length === 0 && r.checks.shahkarLite.ok, "T9 retained check not re-sent");
setFlag(null);
for (const s of [relay, up, proxy]) s.close();
console.error(fails ? `RESULT FAIL ${fails}` : "RESULT ALL PASS");
process.exit(fails ? 1 : 0);
