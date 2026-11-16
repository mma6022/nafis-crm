/**
 * Multi-team v1 (flag.multi_team_v1 default OFF): seed, validation, resolver, lead split, trainees,
 * lockdown map, cursor isolation, and the dry-run/apply team-2 case-move script on a throwaway copy.
 *
 * Usage:
 *   MULTI_TEAM_FIXTURE_DB=/path/masked-copy.db node scripts/run-bundled-fixture.mjs scripts/multi-team-fixture.mjs
 * Falls back to a known local masked dump if the env var is unset.
 * Never touches the live database.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const candidates = [
  process.env.MULTI_TEAM_FIXTURE_DB,
  "/tmp/dci-r3-masked-848350.db",
  "/tmp/dci-masked-r2-20261110T145303Z.db",
  "/tmp/dci-masked-20261110T143804Z.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) {
  console.log("SKIP (set MULTI_TEAM_FIXTURE_DB to a masked DB copy)");
  process.exit(0);
}
const src = path.resolve(candidates[0]);
if (src === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-team-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE/i.test(k)) delete process.env[k];
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const { queryRow, queryRows, execute, runImmediateTransaction, crmDb } = await import("../src/lib/crm-db.ts");
const { isBotExpert } = await import("../src/lib/bale-bot.ts");
const { managerExperts } = await import("../src/lib/assistant-manager.ts");
const { expertOverview } = await import("../src/lib/expert-intro-sms-core.ts");
const { grantLeadAnnotator, isLeadAnnotatorBlockedSalesperson } = await import("../src/lib/lead-annotator.ts");
const { validateDefaultSourceBySeller } = await import("../src/lib/lead-intake.ts");
const { assistantBellBlocked, ensureAssistantSchema } = await import("../src/lib/assistants.ts");
const { financeRoles } = await import("../src/lib/gl-reports.ts");
const mt = await import("../src/lib/multi-team.ts");
const admin = await import("../src/lib/sales-teams-admin.ts");
const ts = await import("../src/lib/team-sales.ts");
const { elUsers } = await import("../src/lib/expert-lockdown.ts");
const urgent = await import("../src/lib/customer-urgent.ts");
const { runMoveTeam2Priorities, assertSafeDbPath, LIVE_DB, SOURCE } = await import("./team-sales/move-team2-priorities.mjs");

const snapSettings = () => ({
  cfg: queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value ?? null,
  cursor: queryRow("SELECT value FROM notification_settings WHERE key='team_sales_closer_cursor'")?.value ?? null,
});
const setFlag = (on) => {
  execute(
    `INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [mt.MT_FLAG, on ? "1" : "0", new Date().toISOString()],
  );
};
const mem = (m) => ({
  teamId: m.teamId ?? 0, salespersonId: m.salespersonId, isLead: !!m.isLead,
  ownsNone: !!m.ownsNone, ownsP1: !!m.ownsP1, ownsP2: !!m.ownsP2, ownsP3: !!m.ownsP3, sortOrder: m.sortOrder ?? 0,
});

const before = snapSettings();
const beforeCfg = ts.getTeamSalesConfig();
assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key=?", [mt.MT_FLAG])?.value, undefined);
assert.equal(mt.mtFlagOn(), false);

ok("flag off: getTeamSalesConfig is the legacy single team", () => {
  assert.equal(beforeCfg.enabled, true);
  assert.equal(beforeCfg.qualifierSalespersonId, 6);
  assert.deepEqual(beforeCfg.closerSalespersonIds, [3, 4]);
  assert.deepEqual(ts.teamConfigFor({ salespersonId: 5 }), beforeCfg);
  assert.equal(mt.isTraineeSalesperson(5), true);
  assert.equal(mt.isTraineeSalesperson(20), true);
  assert.equal(mt.isTraineeSalesperson(19), true);
  assert.deepEqual(elUsers(), { 8: 6, 2: 3, 3: 4 });
});

const cursorBeforeAdvance = mt.readLegacyCloserCursor();
let offFirst, offSecond;
runImmediateTransaction(() => {
  offFirst = ts.nextCloserSalespersonId(beforeCfg);
  offSecond = ts.nextCloserSalespersonId(beforeCfg);
});
ok("flag off: closer cursor advances notification_settings only", () => {
  assert.equal(offFirst, cursorBeforeAdvance % 2 === 0 ? 3 : 4);
  assert.equal(offSecond, offFirst === 3 ? 4 : 3);
  assert.equal(mt.readLegacyCloserCursor(), cursorBeforeAdvance + 2);
  assert.equal(queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='sales_teams'")?.x, undefined);
});

// Restore the cursor so seed copies the original snapshot value, then migrate.
execute(
  "UPDATE notification_settings SET value=? WHERE key='team_sales_closer_cursor'",
  [String(cursorBeforeAdvance)],
);
const seedSnap = snapSettings();
mt.resetMultiTeamSchemaCache();
const firstSeed = mt.migrateMultiTeam();
const secondSeed = mt.migrateMultiTeam();
const afterSeed = snapSettings();

ok("migrate is idempotent and does not touch notification_settings", () => {
  assert.deepEqual(firstSeed.seeded.sort(), ["team1", "team2", "lead_split_state"].sort());
  assert.deepEqual(secondSeed.seeded, []);
  assert.deepEqual(afterSeed, seedSnap);
  assert.equal(afterSeed.cursor, String(cursorBeforeAdvance));
});

ok("seeded teams match t963s4018 ticks (no fixed roles, P1 1–2 owners)", () => {
  const t1 = mt.loadTeam(1);
  const t2 = mt.loadTeam(2);
  assert.equal(t1.p1Cursor, cursorBeforeAdvance);
  assert.equal(t1.leadSplitQuota, 1);
  assert.equal(mt.teamCommissionMode(t1), "inherit");
  assert.deepEqual(t1.members.map((m) => [m.salespersonId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, m.sortOrder]), [
    [6, true, true, false, true, true, 0],
    [3, false, false, true, false, false, 1],
    [4, false, false, true, false, false, 2],
  ]);
  assert.equal(mt.validateStoredTeam(t1).length, 0);
  assert.equal(t2.p1Cursor, 0);
  assert.equal(t2.leadSplitQuota, 0);
  assert.equal(mt.teamCommissionMode(t2), "zero");
  assert.deepEqual(t2.members.map((m) => [m.salespersonId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, m.sortOrder]), [
    [20, true, true, false, true, true, 0],
    [5, false, false, true, false, false, 1],
  ]);
  assert.equal(mt.validateStoredTeam(t2).length, 0);
  assert.equal(t1.name, "تیم فروش ۱");
  assert.equal(t2.name, "تیم فروش ۲");
  assert.equal(mt.teamUiDisplayName(20, "صالح"), "حسین خردکار");
  const intake = mt.loadAllIntakeSplits();
  assert.deepEqual(intake.map((r) => [r.source, r.shares.map((x) => [x.teamId, x.percent])]), [
    ["new_customers", [[1, 100], [2, 0]]],
    ["site_leads", [[1, 100], [2, 0]]],
  ]);
});

ok("legacy seed titles are renamed to the official names", () => {
  execute("UPDATE sales_teams SET name=? WHERE id=1", ["تیم ۱ — کاظمی، حسنی، قاسمی"]);
  execute("UPDATE sales_teams SET name=? WHERE id=2", ["تیم ۲ — خردکار، اصلانیان"]);
  assert.equal(mt.renameLegacyTeamNames(), true);
  assert.equal(mt.loadTeam(1).name, "تیم فروش ۱");
  assert.equal(mt.loadTeam(2).name, "تیم فروش ۲");
  assert.equal(mt.renameLegacyTeamNames(), false);
});

ok("validation: size, one lead, unique members, priority owners", () => {
  const base = [
    mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 }),
    mem({ salespersonId: 3, ownsP1: true, sortOrder: 1 }),
  ];
  assert.ok(mt.validateTeamMembers([base[0]]).some((e) => e.field === "members"));
  assert.ok(mt.validateTeamMembers([...base, mem({ salespersonId: 4 }), mem({ salespersonId: 5 }), mem({ salespersonId: 20 }), mem({ salespersonId: 19 })]).some((e) => e.field === "members"));
  assert.ok(mt.validateTeamMembers([mem({ salespersonId: 6, ownsNone: true, ownsP2: true, ownsP3: true }), mem({ salespersonId: 3, ownsP1: true })]).some((e) => e.field === "is_lead"));
  assert.ok(mt.validateTeamMembers([
    mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true }),
    mem({ salespersonId: 3, isLead: true, ownsP1: true }),
  ]).some((e) => e.field === "is_lead"));
  assert.ok(mt.validateTeamMembers([
    mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true }),
    mem({ salespersonId: 6, ownsP1: true }),
  ]).some((e) => e.field === "salesperson_id"));
  assert.ok(mt.validateTeamMembers(base, { otherTeamSalespersonIds: new Set([3]) }).some((e) => e.field === "salesperson_id"));
  assert.ok(mt.validateTeamMembers([
    mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP1: true, ownsP2: true, ownsP3: true }),
    mem({ salespersonId: 3, ownsNone: true }),
  ]).some((e) => e.field === "owns_none"));
  const noP1 = [mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true }), mem({ salespersonId: 3 })];
  assert.ok(mt.validateTeamMembers(noP1).some((e) => e.field === "owns_p1"));
  const threeP1 = [
    mem({ salespersonId: 6, isLead: true, ownsNone: true, ownsP1: true, ownsP2: true, ownsP3: true }),
    mem({ salespersonId: 3, ownsP1: true }),
    mem({ salespersonId: 4, ownsP1: true }),
  ];
  assert.ok(mt.validateTeamMembers(threeP1).some((e) => e.field === "owns_p1"));
  assert.equal(mt.validateTeamMembers([
    mem({ salespersonId: 20, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true }),
    mem({ salespersonId: 5, ownsP1: true }),
  ]).length, 0);
});

ok("flag still off after seed: resolver and cursor stay on the legacy path", () => {
  assert.equal(mt.mtFlagOn(), false);
  assert.deepEqual(ts.getTeamSalesConfig().closerSalespersonIds, [3, 4]);
  assert.equal(ts.teamConfigFor({ salespersonId: 20 }).qualifierSalespersonId, 6);
  const c0 = mt.readLegacyCloserCursor();
  const t1c0 = mt.loadTeam(1).p1Cursor;
  let chosen;
  runImmediateTransaction(() => { chosen = ts.nextCloserSalespersonId(ts.getTeamSalesConfig()); });
  assert.ok(chosen === 3 || chosen === 4);
  assert.equal(mt.readLegacyCloserCursor(), c0 + 1);
  assert.equal(mt.loadTeam(1).p1Cursor, t1c0);
  execute("UPDATE notification_settings SET value=? WHERE key='team_sales_closer_cursor'", [String(c0)]);
});

const aslanian = { id: 6, role: "salesperson", salesperson_id: 5, active: 1 };
const kheradkar = { id: 28, role: "salesperson", salesperson_id: 20, active: 1 };
const younesi = { id: 27, role: "salesperson", salesperson_id: 19, active: 1 };
const hasani = { id: 2, role: "salesperson", salesperson_id: 3, active: 1 };
const traineeFlag = (id) => managerExperts(crmDb).find((e) => e.salespersonId === id)?.trainee;
const introKind = (id) => expertOverview(crmDb, 6, [3, 4]).find((e) => e.salespersonId === id)?.kind;
const triggerSql = () => String(queryRow("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_assistant_bell_recipient_guard'")?.sql ?? "");

ok("flag off: remaining trainee lists still treat 5/19/20 (Younesi always) as trainees", () => {
  ensureAssistantSchema(crmDb);
  mt.installAssistantBellGuard(crmDb);
  assert.deepEqual(mt.traineeSalespersonIdsOn(crmDb), [5, 19, 20]);
  assert.equal(isBotExpert(aslanian), false);
  assert.equal(isBotExpert(kheradkar), false);
  assert.equal(isBotExpert(younesi), false);
  assert.equal(isBotExpert(hasani), true);
  assert.equal(traineeFlag(5), true);
  assert.equal(traineeFlag(20), true);
  assert.equal(traineeFlag(19), true);
  assert.equal(traineeFlag(3), false);
  assert.equal(introKind(5), "trainee");
  assert.equal(introKind(20), "trainee");
  assert.equal(introKind(19), "trainee");
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 5), true);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 20), true);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 19), true);
  assert.throws(() => grantLeadAnnotator(crmDb, 6, "multi-team-fixture"), /user_not_allowed/);
  assert.throws(() => grantLeadAnnotator(crmDb, 27, "multi-team-fixture"), /user_not_allowed/);
  assert.throws(() => grantLeadAnnotator(crmDb, 28, "multi-team-fixture"), /user_not_allowed/);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "5": "instagram" }).ok, false);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "20": "instagram" }).ok, false);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "19": "instagram" }).ok, false);
  assert.equal(assistantBellBlocked(aslanian, crmDb), true);
  assert.equal(assistantBellBlocked(kheradkar, crmDb), true);
  assert.equal(assistantBellBlocked(younesi, crmDb), true);
  assert.equal(assistantBellBlocked(hasani, crmDb), false);
  const sql = triggerSql();
  assert.match(sql, /salesperson_id IN \(5,19,20\)/);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 19), true);
});

setFlag(true);
ok("flag on: team 1 config unchanged; team 2 routes by ticks", () => {
  const t1 = ts.teamConfigFor({ salespersonId: 6 });
  assert.equal(t1.qualifierSalespersonId, 6);
  assert.deepEqual(t1.closerSalespersonIds, [3, 4]);
  assert.deepEqual(ts.teamConfigFor({ salespersonId: 3 }).closerSalespersonIds, [3, 4]);
  const t2 = ts.teamConfigFor({ salespersonId: 20 });
  assert.equal(t2.qualifierSalespersonId, 20);
  assert.deepEqual(t2.closerSalespersonIds, [5]);
  assert.deepEqual(ts.teamConfigFor({ salespersonId: 5 }).closerSalespersonIds, [5]);
  const team2 = mt.teamOfSalesperson(20);
  assert.equal(mt.ownerForPriority(team2, null), 20);
  assert.equal(mt.ownerForPriority(team2, 2), 20);
  assert.equal(mt.ownerForPriority(team2, 3), 20);
  assert.equal(mt.ownerForPriority(team2, 1), 5);
  assert.equal(mt.isTraineeSalesperson(5), false);
  assert.equal(mt.isTraineeSalesperson(20), false);
  assert.equal(mt.isTraineeSalesperson(19), true);
  assert.equal(mt.isTraineeUser(6), false);
  assert.equal(mt.isTraineeUser(28), false);
  assert.equal(mt.isTraineeUser(27), true);
  const map = elUsers();
  assert.equal(map[8], 6);
  assert.equal(map[2], 3);
  assert.equal(map[3], 4);
  assert.equal(map[6], 5);
  assert.equal(map[28], 20);
});

ok("flag on: team 1 P1 cursor advances per-team only; global cursor untouched", () => {
  const global0 = mt.readLegacyCloserCursor();
  const t1c0 = mt.loadTeam(1).p1Cursor;
  const expected = [3, 4][t1c0 % 2];
  const expected2 = expected === 3 ? 4 : 3;
  let a, b;
  runImmediateTransaction(() => {
    a = ts.nextCloserSalespersonId(ts.getTeamSalesConfig(), { salespersonId: 6 });
    b = ts.nextCloserSalespersonId(ts.getTeamSalesConfig(), { salespersonId: 3 });
  });
  assert.equal(a, expected);
  assert.equal(b, expected2);
  assert.equal(mt.readLegacyCloserCursor(), global0);
  assert.equal(mt.loadTeam(1).p1Cursor, t1c0 + 2);
});

ok("flag on: team 2 P1 is always Aslanian and has its own cursor", () => {
  const global0 = mt.readLegacyCloserCursor();
  const t1c0 = mt.loadTeam(1).p1Cursor;
  let a, b;
  runImmediateTransaction(() => {
    a = ts.nextCloserSalespersonId(ts.getTeamSalesConfig(), { salespersonId: 20 });
    b = ts.nextCloserSalespersonId(ts.getTeamSalesConfig(), { salespersonId: 5 });
  });
  assert.equal(a, 5);
  assert.equal(b, 5);
  assert.equal(mt.loadTeam(2).p1Cursor, 2);
  assert.equal(mt.loadTeam(1).p1Cursor, t1c0);
  assert.equal(mt.readLegacyCloserCursor(), global0);
});

ok("lead split stays 100% team 1 until quotas change", () => {
  const global0 = mt.readLegacyCloserCursor();
  const t1c0 = mt.loadTeam(1).p1Cursor;
  let noneOwner, p1Owner;
  runImmediateTransaction(() => {
    noneOwner = mt.assignLeadOwner(null);
    p1Owner = mt.assignLeadOwner(1);
  });
  assert.equal(noneOwner.team.id, 1);
  assert.equal(noneOwner.salespersonId, 6);
  assert.equal(p1Owner.team.id, 1);
  assert.ok(p1Owner.salespersonId === 3 || p1Owner.salespersonId === 4);
  assert.equal(mt.loadTeam(1).p1Cursor, t1c0 + 1);
  assert.equal(mt.readLegacyCloserCursor(), global0);
});

ok("t969s4061: intake seed is 100/0 per source and idempotent", () => {
  const snap = () => queryRows("SELECT source, team_id, percent, deficit FROM sales_intake_shares ORDER BY source, team_id");
  const first = snap();
  assert.deepEqual(first.map((r) => [r.source, r.team_id, r.percent]), [
    ["new_customers", 1, 100], ["new_customers", 2, 0],
    ["site_leads", 1, 100], ["site_leads", 2, 0],
  ]);
  assert.deepEqual(mt.seedIntakeSplitIfNeeded(), []);
  const again = mt.seedMultiTeamIfNeeded();
  assert.ok(!again.seeded.some((k) => String(k).startsWith("intake:")));
  assert.deepEqual(snap(), first);
});

ok("t969s4061: 70/30 over 100 leads is exactly 70/30 and isolated per source", () => {
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 70 }, { teamId: 2, percent: 30 }]);
  const counts = { 1: 0, 2: 0 };
  for (let i = 0; i < 100; i++) counts[mt.nextLeadSplitTeam(new Date(), "new_customers").id]++;
  assert.deepEqual(counts, { 1: 70, 2: 30 });
  const site = [];
  for (let i = 0; i < 10; i++) site.push(mt.nextLeadSplitTeam(new Date(), "site_leads").id);
  assert.deepEqual(site, Array(10).fill(1));
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
});

ok("t969s4061: intake percents must be integers that sum to 100", () => {
  const catchSave = (shares) => {
    try { mt.saveIntakeShares("new_customers", shares); return null; }
    catch (e) { return e; }
  };
  const sum = catchSave([{ teamId: 1, percent: 70 }, { teamId: 2, percent: 20 }]);
  assert.equal(sum?.status, 422);
  assert.match(String(sum?.message), /۱۰۰/);
  const range = catchSave([{ teamId: 1, percent: 101 }, { teamId: 2, percent: 0 }]);
  assert.equal(range?.status, 422);
  const frac = catchSave([{ teamId: 1, percent: 70.5 }, { teamId: 2, percent: 29.5 }]);
  assert.equal(frac?.status, 422);
  const via = admin.putIntake({ sources: [{ source: "new_customers", teams: [{ teamId: 1, percent: 90 }, { teamId: 2, percent: 20 }] }] });
  assert.equal(via.ok, false);
  assert.equal(via.status, 422);
  assert.match(String(via.message), /۱۰۰/);
  const ok = mt.loadIntakeSplit("new_customers");
  assert.deepEqual(ok.shares.map((s) => [s.teamId, s.percent]), [[1, 100], [2, 0]]);
});


ok("urgent bells: team members are not no-bell; extra recipient is the team's none-owner", () => {
  const kId = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=20 AND merged_into_customer_id IS NULL LIMIT 1").id);
  const aId = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=5 AND merged_into_customer_id IS NULL LIMIT 1").id);
  const hId = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL LIMIT 1").id);
  assert.equal(urgent.urgentOwnerUser(crmDb, kId), 28);
  assert.deepEqual(urgent.urgentBellRecipients(crmDb, kId).sort((a, b) => a - b), [28]);
  assert.equal(urgent.urgentOwnerUser(crmDb, aId), 6);
  assert.deepEqual(urgent.urgentBellRecipients(crmDb, aId).sort((a, b) => a - b), [6, 28]);
  assert.equal(urgent.urgentOwnerUser(crmDb, hId), 2);
  assert.deepEqual(urgent.urgentBellRecipients(crmDb, hId).sort((a, b) => a - b), [2, 8]);
  const y = queryRow("SELECT id FROM customers WHERE salesperson_id=19 AND merged_into_customer_id IS NULL LIMIT 1");
  if (y) {
    assert.equal(urgent.urgentOwnerUser(crmDb, Number(y.id)), null);
    assert.deepEqual(urgent.urgentBellRecipients(crmDb, Number(y.id)), [8]);
  }
});


ok("move script refuses the live database path", () => {
  assert.throws(() => assertSafeDbPath(LIVE_DB), /live database/i);
  assert.throws(() => runMoveTeam2Priorities({ dbPath: LIVE_DB, executeWrites: false }), /live database/i);
  const script = path.resolve("/workspace/team-model/src/artifacts/api-server/scripts/team-sales/move-team2-priorities.mjs");
  const r = spawnSync(process.execPath, [script, "--dry-run"], {
    env: { ...process.env, CRM_DATABASE_PATH: LIVE_DB }, encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match((r.stdout || "") + (r.stderr || ""), /live database/i);
});

const dry = runMoveTeam2Priorities({ dbPath, executeWrites: false });
ok("move script dry-run reports P1→Aslanian and non-P1→Kheradkar and writes nothing", () => {
  assert.equal(dry.applied, false);
  assert.equal(dry.dryRun, true);
  const p1Count = Number(queryRow("SELECT COUNT(*) n FROM customers WHERE merged_into_customer_id IS NULL AND status='in_progress' AND salesperson_id=20 AND priority=1").n);
  const nonCount = Number(queryRow("SELECT COUNT(*) n FROM customers WHERE merged_into_customer_id IS NULL AND status='in_progress' AND salesperson_id=5 AND (priority IS NULL OR priority IN (2,3))").n);
  assert.equal(dry.p1ToAslanian.count + dry.p1ToAslanian.skippedOpen, p1Count);
  assert.equal(dry.nonP1ToKheradkar.count + dry.nonP1ToKheradkar.skippedOpen, nonCount);
  assert.ok(dry.p1ToAslanian.count > 0);
  assert.ok(dry.nonP1ToKheradkar.count > 0);
  const hist = Number(queryRow("SELECT COUNT(*) n FROM customer_priority_history WHERE source=?", [SOURCE]).n);
  assert.equal(hist, 0);
});

const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-team-move-"));
const moveDb = path.join(moveDir, "customers.db");
fs.copyFileSync(dbPath, moveDb);
const applied = runMoveTeam2Priorities({ dbPath: moveDb, executeWrites: true });
ok("move script --execute on a copy swaps the selected books only", () => {
  assert.equal(applied.applied, true);
  const d = new DatabaseSync(moveDb);
  try {
    for (const id of applied.p1ToAslanian.ids) {
      const row = d.prepare("SELECT salesperson_id sp, priority p FROM customers WHERE id=?").get(id);
      assert.equal(Number(row.sp), 5);
      assert.equal(Number(row.p), 1);
    }
    for (const id of applied.nonP1ToKheradkar.ids) {
      const row = d.prepare("SELECT salesperson_id sp, priority p FROM customers WHERE id=?").get(id);
      assert.equal(Number(row.sp), 20);
      assert.ok(row.p == null || Number(row.p) === 2 || Number(row.p) === 3);
    }
    const hist = d.prepare("SELECT customer_id FROM customer_priority_history WHERE source=?").all(SOURCE);
    assert.equal(hist.length, applied.p1ToAslanian.count + applied.nonP1ToKheradkar.count);
  } finally { d.close(); }
  assert.equal(Number(queryRow("SELECT COUNT(*) n FROM customer_priority_history WHERE source=?", [SOURCE]).n), 0);
});

ok("flag on: team members leave trainee lists; Younesi stays a trainee everywhere", () => {
  mt.migrateMultiTeam();
  mt.installAssistantBellGuard(crmDb);
  const traineeIds = mt.traineeSalespersonIdsOn(crmDb);
  assert.ok(traineeIds.includes(19));
  assert.ok(!traineeIds.includes(5) && !traineeIds.includes(20) && !traineeIds.includes(3));
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 5), false);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 20), false);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 19), true);
  assert.equal(mt.isTraineeUserOn(crmDb, 6), false);
  assert.equal(mt.isTraineeUserOn(crmDb, 28), false);
  assert.equal(mt.isTraineeUserOn(crmDb, 27), true);
  assert.equal(isBotExpert(aslanian), true);
  assert.equal(isBotExpert(kheradkar), true);
  assert.equal(isBotExpert(younesi), false);
  assert.equal(isBotExpert(hasani), true);
  assert.equal(traineeFlag(5), false);
  assert.equal(traineeFlag(20), false);
  assert.equal(traineeFlag(19), true);
  assert.equal(introKind(5), "other");
  assert.equal(introKind(20), "other");
  assert.equal(introKind(19), "trainee");
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 5), false);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 20), false);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 19), true);
  assert.throws(() => grantLeadAnnotator(crmDb, 27, "multi-team-fixture"), /user_not_allowed/);
  const granted = grantLeadAnnotator(crmDb, 6, "multi-team-fixture");
  assert.ok(granted === "granted" || granted === "already");
  assert.equal(validateDefaultSourceBySeller(crmDb, { "5": "instagram" }).ok, true);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "20": "instagram" }).ok, true);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "19": "instagram" }).ok, false);
  assert.equal(assistantBellBlocked(aslanian, crmDb), false);
  assert.equal(assistantBellBlocked(kheradkar, crmDb), false);
  assert.equal(assistantBellBlocked(younesi, crmDb), true);
  const sql = triggerSql();
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /sales_team_members/);
  assert.doesNotMatch(sql, /salesperson_id IN \(5,19,20\)/);
  financeRoles(crmDb); // still a trainee-safe read; Younesi/team-2 are salespersons, not finance roles
});


ok("t965s4040: flag-on trainee follows enabled-team membership, including Younesi", () => {
  setFlag(true);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 19), true);
  const extras = queryRows("SELECT id FROM salespersons WHERE active=1 AND id NOT IN (3,4,5,6,20)");
  for (const r of extras) assert.equal(mt.isTraineeSalespersonOn(crmDb, Number(r.id)), true, `sp ${r.id} should be a trainee`);
  execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(2,19,0,0,0,0,0,2)");
  mt.installAssistantBellGuard(crmDb);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 19), false);
  assert.equal(mt.isTraineeUserOn(crmDb, 27), false);
  execute("DELETE FROM sales_team_members WHERE salesperson_id=19");
  mt.installAssistantBellGuard(crmDb);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 19), true);
  assert.equal(mt.isTraineeUserOn(crmDb, 27), true);
});

ok("t969s4061: user 31 / sp 22 is a trainee when not on an enabled team", () => {
  setFlag(true);
  const sp = queryRow("SELECT id, active FROM salespersons WHERE id=22");
  const user = queryRow("SELECT id, role, active, salesperson_id FROM users WHERE id=31");
  assert.equal(Number(sp?.id), 22);
  assert.equal(Number(sp?.active), 1);
  assert.equal(Number(user?.id), 31);
  assert.equal(user?.role, "salesperson");
  assert.equal(Number(user?.active), 1);
  assert.equal(Number(user?.salesperson_id), 22);
  assert.equal(mt.isTraineeSalesperson(22), true);
  assert.equal(mt.isTraineeSalespersonOn(crmDb, 22), true);
  assert.equal(mt.isTraineeUser(31), true);
  assert.equal(mt.isTraineeUserOn(crmDb, 31), true);
  setFlag(false);
  assert.equal(mt.isTraineeSalesperson(22), false);
  assert.equal(mt.isTraineeUser(31), false);
  setFlag(true);
});

ok("t965s4040: cannot disable a team that is an intake destination", () => {
  const blocked = admin.disableTeam(1);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, "intake_destination");
  assert.match(String(blocked.message), /۰٪/);
  assert.equal(mt.loadTeam(1).enabled, true);
  assert.equal(mt.loadTeam(1).members.length, 3);
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 0 }, { teamId: 2, percent: 100 }]);
  mt.saveIntakeShares("site_leads", [{ teamId: 1, percent: 0 }, { teamId: 2, percent: 100 }]);
  const off = admin.disableTeam(1);
  assert.equal(off.ok, true);
  assert.equal(mt.loadTeam(1).enabled, false);
  assert.equal(mt.loadTeam(1).members.length, 0);
  const still = admin.disableTeam(2);
  assert.equal(still.ok, false);
  const en = admin.enableTeam(1, [
    { salespersonId: 6, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 },
    { salespersonId: 3, ownsP1: true, sortOrder: 1 },
    { salespersonId: 4, ownsP1: true, sortOrder: 2 },
  ]);
  assert.equal(en.ok, true);
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
  mt.saveIntakeShares("site_leads", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
});

ok("t969s4061: disabling a team with more than 0% is rejected; disabled teams cannot go above 0%", () => {
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 70 }, { teamId: 2, percent: 30 }]);
  mt.saveIntakeShares("site_leads", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
  const blocked = admin.disableTeam(2);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, "intake_destination");
  assert.equal(mt.loadTeam(2).enabled, true);
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
  const off = admin.disableTeam(2);
  assert.equal(off.ok, true);
  assert.equal(mt.loadTeam(2).enabled, false);
  const put = admin.putIntake({ sources: [{ source: "new_customers", teams: [{ teamId: 1, percent: 70 }, { teamId: 2, percent: 30 }] }] });
  assert.equal(put.ok, false);
  assert.equal(put.status, 422);
  assert.match(String(put.message), /غیرفعال/);
  const en = admin.enableTeam(2, [
    { salespersonId: 20, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 },
    { salespersonId: 5, ownsP1: true, sortOrder: 1 },
  ]);
  assert.equal(en.ok, true);
  mt.saveIntakeShares("new_customers", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
  mt.saveIntakeShares("site_leads", [{ teamId: 1, percent: 100 }, { teamId: 2, percent: 0 }]);
});

ok("t969s4061: picker marks user 31 / sp 22 as a trainee and greys members of other teams", () => {
  const people = admin.pickerPeople();
  const byId = (id) => people.find((p) => p.salespersonId === id);
  assert.equal(byId(22).isTrainee, true);
  assert.equal(byId(22).available, true);
  assert.equal(byId(19).isTrainee, true);
  assert.equal(byId(20).isTrainee, false);
  assert.equal(byId(20).available, false);
  assert.match(String(byId(20).reason), /تیم فروش ۲/);
  assert.equal(byId(5).available, false);
  assert.equal(byId(6).available, false);
});

ok("t969s4061: server rejects members who already belong to another team", () => {
  const bad = admin.createTeam("تیم آزمایش", [
    { salespersonId: 20, isLead: true, ownsNone: true, ownsP2: true, ownsP3: true, sortOrder: 0 },
    { salespersonId: 19, ownsP1: true, sortOrder: 1 },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.match(String(bad.message), /تیم دیگری/);
  assert.equal(mt.loadTeam(1).members.length, 3);
  assert.equal(mt.loadTeam(2).members.length, 2);
});

ok("t965s4040: team UI display names do not write users or salespersons", () => {
  const beforeU = queryRow("SELECT full_name n FROM users WHERE id=28")?.n;
  const beforeS = queryRow("SELECT name n FROM salespersons WHERE id=20")?.n;
  assert.equal(admin.presentTeam(mt.loadTeam(2)).members.find((m) => m.salespersonId === 20).displayName, "حسین خردکار");
  assert.equal(queryRow("SELECT full_name n FROM users WHERE id=28")?.n, beforeU);
  assert.equal(queryRow("SELECT name n FROM salespersons WHERE id=20")?.n, beforeS);
});

ok("flag on then off restores trainee + legacy config behaviour", () => {
  setFlag(false);
  mt.installAssistantBellGuard(crmDb);
  assert.equal(mt.mtFlagOn(), false);
  assert.equal(mt.isTraineeSalesperson(5), true);
  assert.equal(mt.isTraineeSalesperson(20), true);
  assert.equal(mt.isTraineeSalesperson(19), true);
  assert.deepEqual(mt.traineeSalespersonIdsOn(crmDb), [5, 19, 20]);
  assert.equal(isBotExpert(aslanian), false);
  assert.equal(isBotExpert(younesi), false);
  assert.equal(traineeFlag(5), true);
  assert.equal(traineeFlag(19), true);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 5), true);
  assert.equal(isLeadAnnotatorBlockedSalesperson(crmDb, 19), true);
  assert.equal(validateDefaultSourceBySeller(crmDb, { "5": "instagram" }).ok, false);
  assert.equal(assistantBellBlocked(aslanian, crmDb), true);
  assert.match(triggerSql(), /salesperson_id IN \(5,19,20\)/);
  assert.equal(ts.teamConfigFor({ salespersonId: 20 }).qualifierSalespersonId, 6);
  assert.deepEqual(elUsers(), { 8: 6, 2: 3, 3: 4 });
  const final = snapSettings();
  assert.equal(final.cfg, before.cfg);
  assert.equal(final.cursor, String(cursorBeforeAdvance));
});

console.log(`\n${passed} passed`);
