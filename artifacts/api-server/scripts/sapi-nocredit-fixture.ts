// SAPI-NOCREDIT fixture (masked copy only). Run: CRM_DATABASE_PATH=<masked copy> IDF_CERT=c.pem IDF_KEY=k.pem NODE_ENV=production
//   node scripts/run-bundled-fixture.mjs scripts/sapi-nocredit-fixture.ts > out.log
// Local fakes only (stub "s.api.ir" over a fetch mock + local relay/CONNECT proxy/HTTPS). Never reaches s.api.ir. Synthetic ids only.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const FAKE_NID = "0000000018", FAKE_MOBILE = "09000001234", FAKE_CARD = "6037000000000006";
const IBAN_A = "IR530170000000111111111111", IBAN_B = "IR680550000000333333333333";
const NOCREDIT = { success: false, message: "no credit on account | شارژ حساب کاربری شما کافی نمی باشد" };
const cert = readFileSync(process.env.IDF_CERT!, "utf8"), key = readFileSync(process.env.IDF_KEY!, "utf8");
let fails = 0, n = 0; const ok = (c: boolean, m: string) => { n++; console.error(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };

// ---- identity upstream (proxy path) + relay (tunnel path): mode-driven replies
type Mode = "ok" | "nocredit200" | "nocredit403" | "http401" | "http500" | "nomatch";
let idMode: Mode = "ok";
const idReply = (url: string): [number, unknown] => {
  if (idMode === "nocredit200") return [200, NOCREDIT];
  if (idMode === "nocredit403") return [403, { ...NOCREDIT, code: 4031 }];
  if (idMode === "http401") return [401, { message: "Unauthorized" }];
  if (idMode === "http500") return [500, { message: "internal error" }];
  if (idMode === "nomatch" && /shahkar/i.test(url)) return [200, { success: true, data: false, message: "عدم تطابق" }];
  if (/personinfo/i.test(url)) return [200, { success: true, data: { firstName: "تست", lastName: "ماسک", fatherName: "پدر" } }];
  if (/postalcodeinfo/i.test(url)) return [200, { success: true, data: { address: "آدرس تستی" } }];
  return [200, { success: true, data: true }];
};
const hits: string[] = [];
const serve = (req: http.IncomingMessage, res: http.ServerResponse) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
  hits.push(req.url ?? ""); const [s, body] = idReply(req.url ?? ""); res.statusCode = s; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); }); };
const relay = http.createServer(serve);
const up = https.createServer({ cert, key }, serve);
const proxy = http.createServer((_q, r) => { r.statusCode = 405; r.end(); });
proxy.on("connect", (_req, csock, head) => { const s = net.connect(upPort, "127.0.0.1", () => { csock.write("HTTP/1.1 200 Connection established\r\n\r\n"); s.write(head); s.pipe(csock); csock.pipe(s); }); s.on("error", () => csock.destroy()); });
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));
const relayPort = await listen(relay); const upPort = await listen(up); const proxyPort = await listen(proxy);

// ---- bank: fetch mock for the stub host only; anything else (incl. the real s.api.ir) is refused
type BMode = "ok" | "nocredit200" | "nocredit402" | "nocredit_match" | "http500" | "otherfail" | "nonjson" | "network" | "mismatch";
let bankMode: BMode = "ok"; const bankHits: string[] = []; const realFetch = globalThis.fetch; let blocked = 0;
const jr = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.hostname !== "sapi-stub.invalid") { blocked++; throw new TypeError("network disabled in test"); }
  const op = url.pathname.split("/").pop() ?? ""; bankHits.push(op);
  if (bankMode === "network") throw new TypeError("fetch failed");
  if (bankMode === "nocredit200") return jr(NOCREDIT);
  if (bankMode === "nocredit402") return jr({ ...NOCREDIT, status: 402 }, 402);
  if (bankMode === "nocredit_match" && op === "IbanMatch") return jr(NOCREDIT);
  if (bankMode === "http500") return jr({}, 500);
  if (bankMode === "otherfail") return jr({ success: false, message: "invalid input" });
  if (bankMode === "nonjson") return new Response("<html>bad gateway</html>", { status: 502 });
  if (op === "CardToIban") return jr({ success: true, data: { iban: IBAN_A } });
  if (op === "IbanMatch") return jr({ success: true, data: bankMode !== "mismatch" });
  return jr({ success: true, data: { active: true, name: "صاحب حساب آزمایشی", bankName: "بانک آزمایشی" } });
}) as typeof fetch;

process.env.SAPI_API_BASE_URL = "https://sapi-stub.invalid";
process.env.SAPI_API_TOKEN = "FIXTURE-TOKEN-nc11";
process.env.SMS_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
process.env.IR_RELAY_SHARED_SECRET = "FIXTURE-SECRET-nc22";
const db = new DatabaseSync(process.env.CRM_DATABASE_PATH!);
const setEgress = (v: string | null) => { if (v === null) db.prepare("DELETE FROM call_queue_settings WHERE key='identity_egress'").run();
  else db.prepare("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES('identity_egress',?,NULL,'2026-11-03T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v); };
const { verifyCustomerBankAccount, lookupBankAccount } = await import("../src/lib/bank-verification");
const { verifyCustomer } = await import("../src/lib/sapi");
const { __setIdentityTestTarget } = await import("../src/lib/identity-egress");
const { isNoCreditReply, providerReason } = await import("../src/lib/provider-credit");
__setIdentityTestTarget({ host: "127.0.0.1", port: upPort, ca: cert });
const errOf = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as Error).message; } };
const bin = { nationalCode: FAKE_NID, birthDate: "1370/01/01" };

// ---- detector
ok(isNoCreditReply(NOCREDIT) && isNoCreditReply({ data: { message: "No Credit On Account" } }) && isNoCreditReply("شارژ حساب کاربری شما کافی نمی باشد"), "D1 detects the provider no-credit reply (en/fa, nested, raw)");
ok(!isNoCreditReply({ success: false, message: "invalid input" }) && !isNoCreditReply({ success: true, data: { name: "credit union" } }) && !isNoCreditReply(null), "D2 no false positive on other errors / data fields");
ok(providerReason({ message: `bad ${FAKE_NID} ${IBAN_A}` }).providerMessage.indexOf("0000000018") < 0, "D3 reason masks long digit runs");

// ---- bank
bankMode = "ok"; ok(await errOf(verifyCustomerBankAccount({ ...bin, iban: IBAN_B })) === "OK", "B1 happy path unchanged (iban)");
ok(await errOf(verifyCustomerBankAccount({ ...bin, cardNumber: FAKE_CARD })) === "OK", "B1b happy path unchanged (card)");
bankMode = "nocredit200"; ok(await errOf(verifyCustomerBankAccount({ ...bin, iban: IBAN_B })) === "bank_provider_no_credit", "B2 no-credit (200 body) -> bank_provider_no_credit (iban)");
ok(await errOf(verifyCustomerBankAccount({ ...bin, cardNumber: FAKE_CARD })) === "bank_provider_no_credit", "B2b no-credit -> bank_provider_no_credit (card)");
bankMode = "nocredit402"; ok(await errOf(verifyCustomerBankAccount({ ...bin, iban: IBAN_B })) === "bank_provider_no_credit", "B3 no-credit on non-2xx status -> bank_provider_no_credit");
bankMode = "nocredit_match"; ok(await errOf(verifyCustomerBankAccount({ ...bin, cardNumber: FAKE_CARD })) === "bank_provider_no_credit", "B4 no-credit on the 2nd step (IbanMatch) -> bank_provider_no_credit");
bankMode = "nocredit200"; ok(await errOf(lookupBankAccount(IBAN_B)) === "bank_provider_no_credit", "B5 lookupBankAccount no-credit -> bank_provider_no_credit");
for (const m of ["http500", "otherfail", "nonjson", "network"] as BMode[]) {
  bankMode = m; ok(await errOf(verifyCustomerBankAccount({ ...bin, iban: IBAN_B })) === "bank_verification_unavailable" && await errOf(lookupBankAccount(IBAN_B)) === "bank_verification_unavailable", `B6 ${m} -> bank_verification_unavailable (unchanged)`);
}
bankMode = "mismatch"; ok(await errOf(verifyCustomerBankAccount({ ...bin, iban: IBAN_B })) === "bank_ownership_mismatch", "B7 ownership mismatch unchanged");
const savedTok = process.env.SAPI_API_TOKEN; delete process.env.SAPI_API_TOKEN; bankMode = "ok"; const before = bankHits.length;
ok(await errOf(lookupBankAccount(IBAN_B)) === "bank_verification_unavailable" && bankHits.length === before, "B8 no token -> unavailable, nothing sent"); process.env.SAPI_API_TOKEN = savedTok;

// ---- identity
const input = { nationalCode: FAKE_NID, mobile: FAKE_MOBILE, birthDateJalali: "1370/01/01", postalCode: "1111111111" };
for (const egress of ["proxy", "tunnel", "direct"] as const) {
  if (egress === "proxy") { setEgress("proxy"); delete process.env.SAPI_RELAY_URL; }
  else if (egress === "tunnel") { setEgress(null); process.env.SAPI_RELAY_URL = `http://127.0.0.1:${relayPort}`; }
  else { setEgress(null); delete process.env.SAPI_RELAY_URL; process.env.SAPI_API_BASE_URL = `http://127.0.0.1:${relayPort}`; }
  idMode = "ok"; let r = await verifyCustomer(input);
  ok(r.status === "verified" && r.providerNoCredit === false, `I1 ${egress}: happy path verified, providerNoCredit=false`);
  idMode = "nocredit200"; r = await verifyCustomer(input);
  ok(r.providerNoCredit === true && Object.values(r.checks).every((c) => c.completed === false && c.providerStatus === "provider_no_credit"), `I2 ${egress}: no-credit (200 body) -> provider_no_credit, completed=false, flag`);
  idMode = "nocredit403"; r = await verifyCustomer(input, {}, ["shahkarLite", "personInfo"]);
  ok(r.providerNoCredit === true && r.checks.shahkarLite.providerStatus === "provider_no_credit" && r.checks.sana.providerStatus === "not_requested", `I3 ${egress}: no-credit on non-2xx -> provider_no_credit (selected checks only)`);
  idMode = "http401"; r = await verifyCustomer(input, {}, ["sana"]);
  ok(r.providerNoCredit === false && r.checks.sana.providerStatus === "SAPI request failed (401)" && r.checks.sana.completed === false, `I4 ${egress}: 401 unchanged (SAPI request failed (401))`);
  idMode = "nomatch"; r = await verifyCustomer(input, {}, ["shahkarLite"]);
  ok(r.providerNoCredit === false && r.status === "failed" && r.checks.shahkarLite.completed === true && r.checks.shahkarLite.ok === false, `I5 ${egress}: genuine mismatch stays a completed failure`);
  idMode = "nocredit200"; r = await verifyCustomer(input, { shahkarLite: { ok: true, completed: true, providerStatus: "success" } }, ["shahkarLite"]);
  ok(r.providerNoCredit === false && r.checks.shahkarLite.ok, `I6 ${egress}: retained check not re-sent, no flag`);
}
process.env.SAPI_API_BASE_URL = "https://sapi-stub.invalid";
setEgress(null);
ok(blocked === 0, "N1 no request left the box (no non-stub host attempted)");
for (const s of [relay, up, proxy]) s.close();
console.error(fails ? `RESULT FAIL ${fails}/${n}` : `RESULT ALL PASS ${n}/${n}`);
process.exit(fails ? 1 : 0);
