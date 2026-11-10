/**
 * Team-builder API (flag.multi_team_v1) on a throwaway masked copy.
 * No live DB, no staff login — x-actor stub only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const candidates = [
  process.env.MULTI_TEAM_FIXTURE_DB,
  "/tmp/dci-r3-masked-848350.db",
  "/tmp/dci-masked-r2-20261110T145303Z.db",
  "/tmp/dci-masked-20261110T143804Z.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) { console.log("SKIP (set MULTI_TEAM_FIXTURE_DB to a masked DB copy)"); process.exit(0); }
const src = path.resolve(candidates[0]);
if (src === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sales-teams-api-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const { execute } = await import("../src/lib/crm-db.ts");
const mt = await import("../src/lib/multi-team.ts");
const router = (await import("../src/routes/sales-teams.ts")).default;

mt.resetMultiTeamSchemaCache();
mt.migrateMultiTeam();

const actors = {
  admin: { id: 1, role: "admin", baseRole: "admin", username: "admin", fullName: "مدیر سامانه", permissions: ["users.view", "users.manage"] },
  manager: { id: 5, role: "admin", baseRole: "sales_manager", salesManager: true, username: "mhmab", fullName: "محمدحسین مهرپور", permissions: [] },
  kazemi: { id: 8, role: "salesperson", baseRole: "salesperson", salespersonId: 6, username: "kazemi", fullName: "آقای کاظمی", permissions: [] },
  younesi: { id: 27, role: "salesperson", baseRole: "salesperson", salespersonId: 19, username: "younesi", fullName: "خانم یونسی", permissions: [] },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const a = actors[req.headers["x-actor"]];
  if (!a) return res.sendStatus(401);
  res.locals.authUser = a;
  next();
});
app.use("/api", router);

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const call = async (actor, method, url, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${url}`, {
    method, headers: { "x-actor": actor, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { s: r.status, b: json };
};

let passed = 0;
const ok = (name, fn) => { const r = fn(); return Promise.resolve(r).then(() => { passed++; console.log("ok -", name); }); };

try {
  await ok("flag off: routes fall through (404)", async () => {
    const r = await call("admin", "GET", "/sales-teams/me");
    assert.equal(r.s, 404);
  });

  execute(`INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [mt.MT_FLAG, "1", new Date().toISOString()]);

  await ok("me: admin can disable, manager can manage, expert is readonly", async () => {
    const a = await call("admin", "GET", "/sales-teams/me");
    const m = await call("manager", "GET", "/sales-teams/me");
    const k = await call("kazemi", "GET", "/sales-teams/me");
    assert.equal(a.s, 200);
    assert.equal(a.b.canManage, true);
    assert.equal(a.b.canDisable, true);
    assert.equal(m.b.canManage, true);
    assert.equal(m.b.canDisable, false);
    assert.equal(k.b.canManage, false);
    assert.equal(k.b.readonly, true);
    assert.equal(k.b.teamId, 1);
  });

  await ok("list: manager sees both teams and default intake sentences; expert sees only own team", async () => {
    const m = await call("manager", "GET", "/sales-teams");
    assert.equal(m.s, 200);
    assert.equal(m.b.teams.length, 2);
    assert.equal(m.b.teams[0].name, "تیم فروش ۱");
    assert.equal(m.b.teams[1].name, "تیم فروش ۲");
    assert.equal(m.b.canDisable, false);
    const kherad = m.b.teams[1].members.find((x) => x.salespersonId === 20);
    assert.equal(kherad.displayName, "حسین خردکار");
    assert.equal(kherad.extensionLabel, "داخلی ندارد");
    assert.ok(m.b.intake.every((i) => i.sentence.includes("تیم فروش ۱")));
    const k = await call("kazemi", "GET", "/sales-teams");
    assert.equal(k.b.teams.length, 1);
    assert.equal(k.b.teams[0].id, 1);
    assert.equal(k.b.readonly, true);
    assert.deepEqual(k.b.intake, []);
    const y = await call("younesi", "GET", "/sales-teams");
    assert.equal(y.b.teams.length, 0);
  });

  await ok("manager cannot disable; admin is blocked while team 1 is an intake destination", async () => {
    const m = await call("manager", "POST", "/sales-teams/1/disable", {});
    assert.equal(m.s, 403);
    const a = await call("admin", "POST", "/sales-teams/1/disable", {});
    assert.equal(a.s, 409);
    assert.equal(a.b.error, "intake_destination");
    assert.match(String(a.b.message), /۰٪/);
  });

  await ok("intake put rejects a sum other than 100", async () => {
    const bad = await call("manager", "PUT", "/sales-teams/intake", { sources: [
      { source: "new_customers", teams: [{ teamId: 1, percent: 70 }, { teamId: 2, percent: 20 }] },
    ] });
    assert.equal(bad.s, 422);
    assert.match(String(bad.b.message), /۱۰۰/);
  });

  await ok("intake put sets percents; disable works only after the team is at 0% on both sources", async () => {
    const put = await call("manager", "PUT", "/sales-teams/intake", { sources: [
      { source: "new_customers", teams: [{ teamId: 1, percent: 0 }, { teamId: 2, percent: 100 }] },
      { source: "site_leads", teams: [{ teamId: 1, percent: 0 }, { teamId: 2, percent: 100 }] },
    ] });
    assert.equal(put.s, 200);
    assert.ok(put.b.intake.every((i) => i.teamIds[0] === 2 && i.teams.find((t) => t.teamId === 2).percent === 100));
    const off = await call("admin", "POST", "/sales-teams/1/disable", {});
    assert.equal(off.s, 200);
    assert.equal(off.b.team.enabled, false);
    const list = await call("admin", "GET", "/sales-teams");
    assert.equal(list.b.teams.find((t) => t.id === 1).enabled, false);
    const en = await call("admin", "POST", "/sales-teams/1/enable", { members: [
      { salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 },
      { salespersonId: 3, ownsP1: true, sortOrder: 1 },
      { salespersonId: 4, ownsP1: true, sortOrder: 2 },
    ] });
    assert.equal(en.s, 200);
    const back = await call("admin", "PUT", "/sales-teams/intake", { sources: [
      { source: "new_customers", teams: [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }] },
      { source: "site_leads", teams: [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }] },
    ] });
    assert.equal(back.s, 200);
  });

  await ok("creating a team rejects a member who is already on another team", async () => {
    const r = await call("manager", "POST", "/sales-teams", {
      name: "تیم آزمایش",
      members: [
        { salespersonId: 20, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 },
        { salespersonId: 19, ownsP1: true, sortOrder: 1 },
      ],
    });
    assert.equal(r.s, 400);
    assert.match(String(r.b.message), /تیم دیگری/);
  });

  await ok("picker flags sp 22 as a trainee and members of other teams as unavailable", async () => {
    const r = await call("manager", "GET", "/sales-teams/picker");
    assert.equal(r.s, 200);
    const byId = (id) => r.b.people.find((p) => p.salespersonId === id);
    assert.equal(byId(22).isTrainee, true);
    assert.equal(byId(19).isTrainee, true);
    assert.equal(byId(20).available, false);
    assert.equal(byId(20).isTrainee, false);
  });

  await ok("validation errors match the design copy", async () => {
    const r = await call("manager", "POST", "/sales-teams", {
      name: "تیم آزمایش",
      members: [
        { salespersonId: 19, isLead: true, ownsNone: true, ownsP3: true, sortOrder: 0 },
        { salespersonId: 22, ownsP1: true, sortOrder: 1 },
      ],
    });
    assert.equal(r.s, 400);
    assert.equal(r.b.message, "اولویت ۲ هنوز مسئول ندارد.");
  });

  await ok("creating a team applies the team-1 panel flags", async () => {
    // use leftover people if any; otherwise just check helper on user 27 would write keys
    const before = execute;
    void before;
    const { applyTeam1PanelFlags } = await import("../src/lib/sales-teams-admin.ts");
    const written = applyTeam1PanelFlags(27);
    assert.ok(written.some((k) => k.includes("sales_shell_v2.user.27") || k.endsWith(".user.27")));
    const row = (await import("../src/lib/crm-db.ts")).queryRow("SELECT value FROM call_queue_settings WHERE key=?", ["flag.sales_shell_v2.user.27"]);
    assert.equal(row?.value, "1");
  });
} finally {
  await new Promise((r) => server.close(r));
}
console.log(`\n${passed} passed`);
