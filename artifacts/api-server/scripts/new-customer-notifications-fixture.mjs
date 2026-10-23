import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Real notifyNewCustomer against an in-memory DB; global fetch is replaced, so nothing leaves the machine.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-new-customer-notify-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  export const crmDb = new DatabaseSync(":memory:");
  crmDb.exec(\`
    CREATE TABLE salespersons (id INTEGER PRIMARY KEY, name TEXT, mobile TEXT);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, description TEXT, salesperson_id INTEGER);
    CREATE TABLE notification_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE notification_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL);
    INSERT INTO salespersons VALUES (7, 'کارشناس نمونه', '09120000007');
    INSERT INTO customers VALUES (1, 'مشتری سایت', '09000000011', 'نیاز: وام نقدی', 7);
    INSERT INTO customers VALUES (2, 'مشتری پنل', '09000000012', NULL, 7);
    INSERT INTO customers VALUES (3, 'مشتری تماس', '09000000013', NULL, NULL);
  \`);
  export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
  export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
  export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
  export const executeChanges=(s,p=[])=>crmDb.prepare(s).run(...p).changes;
  export const runTransaction=(fn)=>fn();
  export const runImmediateTransaction=(fn)=>fn();
`;

const unitSource = `
  import assert from "node:assert/strict";
  import { notifyNewCustomer, notifyWebsiteCallback } from "./src/lib/customer-notifications";
  import { websiteLeadNotification } from "./src/routes/public-leads";
  import { queryRows } from "./src/lib/crm-db";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ kind: u.includes("api.telegram.org") ? "telegram" : u.includes("127.0.0.1:18787") ? "sms" : "other:" + u, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const take = () => calls.splice(0);
  const deliveries = (id) => queryRows("SELECT channel, status FROM notification_deliveries WHERE customer_id=? ORDER BY id", [id]).map((r) => ({ ...r }));

  // Website lead (public endpoint options): exactly one Telegram, labelled سایت, and no SMS call at all.
  const websiteOptions = websiteLeadNotification({ name: "x", phone: "09000000011", contactTime: "any" });
  assert.deepEqual(websiteOptions, { customerSms: false, source: "website", kind: "request" });
  await notifyNewCustomer(1, websiteOptions);
  let c = take();
  assert.equal(c.filter((x) => x.kind === "sms").length, 0, "website lead: no SMS call");
  assert.equal(c.length, 1, "website lead: only one outbound call");
  assert.equal(c[0].kind, "telegram");
  assert.match(c[0].body.text, /سایت/, "Telegram says the lead came from the website");
  assert.match(c[0].body.text, /مشتری سایت/);
  assert.doesNotMatch(c[0].body.text, /زمان ترجیحی/, "no preferred-time line when absent");
  assert.deepEqual(deliveries(1), [{ channel: "telegram", status: "sent" }], "no ippanel delivery row for the website lead");

  // Callback with a preferred time: still no SMS, Telegram carries the time.
  await notifyNewCustomer(3, websiteLeadNotification({ type: "callback", preferredTime: "  امروز بعد از ساعت ۱۶  " }));
  c = take();
  assert.deepEqual(c.map((x) => x.kind), ["telegram"]);
  assert.match(c[0].body.text, /سایت \\(درخواست تماس\\)/);
  assert.match(c[0].body.text, /⏰ زمان ترجیحی تماس: امروز بعد از ساعت ۱۶\\n/);
  assert.deepEqual(websiteLeadNotification({ type: "callback", preferredTime: "   " }), { customerSms: false, source: "website", kind: "callback" });

  // Staff-side «درخواست تماس کارشناس» (no customer row yet): one Telegram with the contact time, no SMS, no delivery row.
  const deliveriesBefore = queryRows("SELECT COUNT(*) n FROM notification_deliveries")[0].n;
  const outcome = await notifyWebsiteCallback({ name: "درخواست‌کننده", phone: "09000000014", contactTimeFa: "صبح (۹ تا ۱۳)", description: "☎️ درخواست تماس (فرم مشاوره سایت)" });
  assert.equal(outcome, "sent");
  c = take();
  assert.deepEqual(c.map((x) => x.kind), ["telegram"], "callback alert: Telegram only");
  assert.match(c[0].body.text, /سایت \\(درخواست تماس\\)/);
  assert.match(c[0].body.text, /⏰ زمان ترجیحی تماس: صبح \\(۹ تا ۱۳\\)/);
  assert.match(c[0].body.text, /09000000014/);
  assert.equal(queryRows("SELECT COUNT(*) n FROM notification_deliveries")[0].n, deliveriesBefore);
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await notifyWebsiteCallback({ name: "x", phone: "09000000014", contactTimeFa: "عصر", description: "" }), "failed", "never throws");
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ kind: u.includes("api.telegram.org") ? "telegram" : u.includes("127.0.0.1:18787") ? "sms" : "other:" + u, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  // Any other path (panel, Instagram, ... call notifyNewCustomer(id) with no options): SMS + Telegram exactly as before.
  await notifyNewCustomer(2);
  c = take();
  assert.deepEqual(c.map((x) => x.kind).sort(), ["sms", "telegram"], "non-website path still sends the SMS");
  const tg = c.find((x) => x.kind === "telegram");
  assert.doesNotMatch(tg.body.text, /منبع: سایت/, "non-website Telegram unchanged");
  assert.ok(tg.body.text.startsWith("📋 مشتری جدید ثبت شد"));
  const sms = c.find((x) => x.kind === "sms");
  assert.deepEqual(sms.body.recipients, ["+989000000012"]);
  assert.deepEqual(deliveries(2).map((d) => d.channel).sort(), ["ippanel", "telegram"]);
  // An explicit customerSms: true (or any non-false) also keeps the SMS.
  await notifyNewCustomer(2, { customerSms: true });
  assert.deepEqual(take().map((x) => x.kind).sort(), ["sms", "telegram"]);
  console.log("new customer notification units ok");
`;

const plugin = {
  name: "notify-fixture",
  setup(ctx) {
    ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fx" }));
    ctx.onLoad({ filter: /^db$/, namespace: "fx" }, () => ({ contents: dbModule, loader: "js" }));
  },
};
const banner = { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` };
try {
  const out = path.join(temp, "units.mjs");
  await build({ stdin: { contents: unitSource, resolveDir: apiRoot, sourcefile: "units.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent", banner, plugins: [plugin] });
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: "fixture-token", IR_RELAY_SHARED_SECRET: "fixture-relay-secret", NODE_ENV: "production", LOG_LEVEL: "silent" };
  const run = spawnSync(process.execPath, ["--no-warnings", out], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  console.log(run.stdout.trim());
} finally {
  await rm(temp, { recursive: true, force: true });
}
