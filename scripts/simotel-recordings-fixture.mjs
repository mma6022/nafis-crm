import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import express from "express";

// Synthetic schema/rows only: never copy customer records or call a provider.
const root = await mkdtemp(path.join(os.tmpdir(), "simotel-fixture-"));
const db = new DatabaseSync(":memory:");
globalThis.simotelFixtureDb = db;
db.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER,created_at TEXT);
 CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
 CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY,extension TEXT UNIQUE,authorization_username TEXT,updated_at TEXT,updated_by_user_id INTEGER);
 INSERT INTO users VALUES(1,'admin','مدیر آزمایشی','admin',1,'2026-10-04'),(2,'agent','کارشناس آزمایشی','salesperson',1,'2026-10-04'),(3,'other','کارشناس دیگر','salesperson',1,'2026-10-04');
 INSERT INTO customers VALUES(1,'مشتری خود','09120000001',2,NULL),(2,'مشتری دیگر','09120000002',3,NULL);
 INSERT INTO voip_extensions(user_id,extension,authorization_username) VALUES(2,'201','preserved-sip-login'),(3,'202','other-login');
`);
const row = (id, src, dst, record = "test.mp3") => ({
  _id: String(id), cuid: `same-cuid`, src, dst, type: "outgoing",
  duration: 60, billsec: 50, disposition: "ANSWERED", record,
  starttime: "1405-07-12 15:31:23", endtime: { $date: { $numberLong: String(Date.parse("2026-10-04T15:32:23+03:30")) } },
});
const rows = [
  row(1, "201", "09120000001"), row(2, "202", "09120000002"),
  row(3, "201", "09120000002"), row(4, "201", "09120000003"),
  row(5, "201", "09120000001", ""), row(6, "202", "09120000002", "bad.mp3"),
  row(7, "202", "09120000002", "../secret.mp3"),
];
rows[4].disposition = "NO ANSWER";
// Start one second before Iran midnight, but finish after it: still excluded.
const old = row(8,"201","09120000001");
old.endtime.$date.$numberLong=String(Date.parse("2026-10-03T20:30:59Z"));
rows.push(old);
rows[0].endtime.$date.$numberLong=String(Date.parse("2026-10-03T20:31:00Z"));
const network = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  network.push({ url, body: init?.body });
  assert.equal(init?.redirect, "error");
  if (url.pathname.endsWith("/reports/cdr/search")) {
    assert.equal(new Headers(init.headers).get("X-APIKEY"), "synthetic-key");
    const body = JSON.parse(init.body);
    return Response.json({ success: 1, data: {
      pagination: { total: rows.length }, data: rows.slice(body.pagination.start, body.pagination.start + body.pagination.count),
    } });
  }
  if (url.pathname.endsWith("/reports/audio/download")) {
    const { file } = JSON.parse(init.body);
    return Response.json({ success: 1, data: {
      audioLink: file === "bad.mp3" ? "https://127.0.0.1/private" : "https://storage.hostedpbx.ir/synthetic.mp3",
    } });
  }
  assert.equal(url.origin, "https://storage.hostedpbx.ir");
  assert.equal(new Headers(init?.headers).has("X-APIKEY"), false, "Never forward API credential to audio storage");
  return new Response(Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
};
Object.assign(process.env, { SIMOTEL_API_KEY: "synthetic-key", NODE_ENV: "test" });
let server;
try {
  const bundle = path.join(root, "recordings.mjs");
  await build({
    entryPoints: ["src/routes/simotel-recordings.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
    plugins: [{ name: "synthetic-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const crmDb=globalThis.simotelFixtureDb;
        export const queryRow=(sql,args=[])=>crmDb.prepare(sql).get(...args);
        export const queryRows=(sql,args=[])=>crmDb.prepare(sql).all(...args);
        export const execute=(sql,args=[])=>crmDb.prepare(sql).run(...args);
      ` }));
    } }],
  });
  const app = express();
  app.use((req, res, next) => {
    const actor = req.headers["x-fixture-user"];
    if (actor) res.locals.authUser = {
      id: actor === "admin" ? 1 : ["agent","all-scope"].includes(actor) ? 2 : 4,
      role: actor === "admin" ? "admin" : "salesperson",
      permissions: actor === "blocked" ? [] : ["calls.view"],
      customerScope: ["admin","all-scope","all-missing"].includes(actor) ? "all" : "assigned", salespersonId: 2,
    };
    next();
  });
  app.use((await import(pathToFileURL(bundle).href)).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const range = "from=2026-07-01&to=2026-10-04";
  const get = (suffix = "", actor = "admin") => fetch(`${base}/voip/recordings${suffix}`, {
    headers: actor ? { "x-fixture-user": actor } : {},
  });
  const allScope = await (await get(`?${range}`, "all-scope")).json();
  assert.equal(allScope.total,4,"Customer-wide permission never grants other extensions' calls");
  assert.ok(!allScope.items.some(x=>x.id==="8"),"A call beginning before Iran midnight is hidden even when it ends on 12 Mehr");
  assert.ok(allScope.items.some(x=>x.id==="1"),"Exact Iran midnight on 12 Mehr is included");
  assert.equal(allScope.from,"2026-10-04","An old requested filter is clamped to the permanent display boundary");
  assert.equal((await (await get("?from=2026-10-01&to=2026-10-03")).json()).total,0,"Entirely old windows show no calls");
  assert.equal((await (await get("?from=2026-10-05&to=2026-10-06")).json()).total,0,"Selected day bounds are enforced even if the provider ignores them");
  assert.ok(allScope.items.every(x=>x.extensions.includes("201")));
  assert.equal((await get(`/6/audio?${range}`,"all-scope")).status,404);
  assert.equal((await get(`?${range}`,"all-missing")).status,422,"All-scope expert without extension is not an administrator");
  const helperBundle = path.join(root, "user-extension.mjs");
  await build({
    stdin: { contents: `export {saveUserVoipExtension} from './src/lib/user-voip-extension.ts';export{callExtensions}from'./src/lib/simotel.ts';export{CreateUserBody,UpdateUserBody}from'@workspace/api-zod';`, resolveDir: path.resolve(".") },
    outfile: helperBundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "fixture-user-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        const db=globalThis.simotelFixtureDb;export const queryRow=(s,p=[])=>db.prepare(s).get(...p);
        export const executeChanges=(s,p=[])=>db.prepare(s).run(...p).changes;
      ` }));
    } }],
  });
  const helper = await import(pathToFileURL(helperBundle).href);
  assert.equal(helper.UpdateUserBody.parse({ voipExtension: null }).voipExtension, null);
  assert.equal(helper.CreateUserBody.parse({ username: "fixture", password: "synthetic-password", role: "salesperson", voipExtension: "201" }).voipExtension, "201");
  assert.equal(helper.UpdateUserBody.safeParse({ voipExtension: "../secret" }).success, false);
  assert.equal(helper.callExtensions(row(99, "agent000002", "09120000003"), ["agent000002"]).includes("agent000002"), true);
  assert.equal((await get("", null)).status, 401);
  assert.equal((await get("", "blocked")).status, 403);
  assert.equal((await get("", "unmapped")).status, 422);
  assert.equal((await get("?from=2026-02-30&to=2026-10-04")).status, 400);
  assert.equal((await get("?recordedOnly=garbage")).status, 400);
  const admin = await (await get(`?${range}`)).json();
  assert.equal(admin.total, 7);
  assert.equal(admin.items.length, 7, "Do not merge distinct rows with the same cuid");
  assert.equal(admin.recordedTotal, 6);
  assert.ok(admin.items[0].startedAt.startsWith("2026-"), "Jalali provider time must not become Gregorian year 1405");
  assert.equal(JSON.stringify(admin).includes("audioLink"), false);
  assert.equal(JSON.stringify(admin).includes("test.mp3"), false);
  const own = await (await get(`?${range}`, "agent")).json();
  assert.deepEqual(own.items.map(x => x.id), ["1", "4", "5"], "Exclude other extensions and even own-extension calls to another owner's customer");
  assert.equal((await get(`/2/audio?${range}`, "agent")).status, 404);
  assert.equal((await get(`/3/audio?${range}`, "agent")).status, 404);
  assert.equal((await get(`/5/audio?${range}`, "agent")).status, 404);
  const filtered = await (await get(`?${range}&recordedOnly=false&status=NO%20ANSWER`)).json();
  assert.equal(filtered.total, 1, "String false must not be coerced to true");
  const audio = await get(`/1/audio?${range}`, "agent");
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-disposition"), 'attachment; filename="call-1.mp3"');
  assert.equal(audio.headers.get("cache-control"), "private, no-store");
  assert.equal(Buffer.from(await audio.arrayBuffer()).subarray(0, 3).toString(), "ID3");
  const requestsBefore = network.length;
  assert.equal((await get(`/6/audio?${range}`)).status, 502, "Reject private-host audio URLs");
  assert.equal(network.slice(requestsBefore).some(x => x.url.hostname === "127.0.0.1"), false);
  assert.equal((await get(`/7/audio?${range}`)).status, 502, "Reject traversal filenames before contacting provider");
  assert.equal((await (await get(`?${range}&page=2`)).json()).items.length, 0);
  assert.throws(() => helper.saveUserVoipExtension(2, "202", 1), /voip_extension_conflict/);
  assert.equal(db.prepare("SELECT extension FROM voip_extensions WHERE user_id=2").get().extension, "201");
  helper.saveUserVoipExtension(2, null, 1);
  assert.equal(db.prepare("SELECT authorization_username FROM voip_extensions WHERE user_id=2").get().authorization_username, "preserved-sip-login");
  assert.equal((await get(`?${range}`, "agent")).status, 422, "Clearing the mapping revokes recording access immediately");
  helper.saveUserVoipExtension(3, "201", 1);
  const reassigned = await (await get(`?${range}`)).json();
  assert.deepEqual(reassigned.items.find(x => x.id === "1").expertNames, ["کارشناس دیگر"], "Same mapping drives report/recording attribution, even with provider rows cached");
  helper.saveUserVoipExtension(3, null, 1);
  helper.saveUserVoipExtension(2, "201", 1);
  assert.deepEqual((await (await get(`?${range}`)).json()).items.find(x => x.id === "1").expertNames, ["کارشناس آزمایشی"]);
  const customersBeforeHide = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  db.prepare("INSERT INTO voip_call_display_exclusions(phone) VALUES(?)").run("09120000003");
  const excluded = await (await get(`?${range}`)).json();
  assert.equal(excluded.items.some(x => x.id === "4"), false, "Configured phone is hidden even for administrators");
  assert.equal(excluded.total, 6, "Excluded calls are removed before totals and pagination");
  assert.equal((await get(`/4/audio?${range}`)).status, 404, "Excluded recording is not exposed through a direct URL");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers").get().n, customersBeforeHide, "Display filtering never deletes customers");
  console.log("PASS: report permissions, ownership, filters, non-destructive display exclusions, duplicate-cuid rows, private downloads, v4.1 audioLink, SSRF, traversal and Jalali time.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
  db.close();
  delete globalThis.simotelFixtureDb;
  await rm(root, { recursive: true, force: true });
}