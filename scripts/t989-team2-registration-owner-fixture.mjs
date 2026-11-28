/**
 * t989: when a team-2 expert (Aslanian, user 6 / sp 5) registers a customer, the
 * owner is the team-2 lead (Khordkar, sp 20), not Kazemi (sp 6). Team-1 experts
 * still go to Kazemi for none/P2/P3. System / off-team registrars still follow
 * the new_customers lead split. Throwaway COPY of a masked DB only; never live.
 *
 * Usage:
 *   T989_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t989-team2-registration-owner-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE = "/var/lib/nafisvam/customers.db";
const src = process.env.T989_FIXTURE_DB
  || ["/workspace/t861/masked.db", "/workspace/q-480000/mdb/m.db"].find((p) => fs.existsSync(p));
if (!src) { console.log("SKIP (set T989_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === LIVE || (fs.existsSync(LIVE) && fs.realpathSync(src) === fs.realpathSync(LIVE))) {
  throw new Error("REFUSE_LIVE_DB");
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t989-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t989 fixture"); };

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

const { queryRow, queryRows, execute, runImmediateTransaction } = await import("../src/lib/crm-db.ts");
const mt = await import("../src/lib/multi-team.ts");
const cc = await import("../src/lib/customer-create.ts");
// Install the live intake hook (conv-default-owner → team 1 / Kazemi) the same way production does.
await import("../src/lib/sales-admin-merge.ts");

const ASLANIAN_USER = 6;
const ASLANIAN_SP = 5;
const KAZEMI_SP = 6;
const KHORDKAR_SP = 20;
const HASANI_USER = 2;
const GHASEMI_USER = 3;
const SARINA_USER = 7;
const YOUNESI_USER = 27;
const KHORDKAR_USER = 28;

const snapProtected = () => ({
  tsc: queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value ?? null,
  cursor: queryRow("SELECT value FROM notification_settings WHERE key='team_sales_closer_cursor'")?.value ?? null,
  shares: JSON.stringify(queryRows("SELECT source, team_id, percent, deficit FROM sales_intake_shares ORDER BY source, team_id")),
  members: JSON.stringify(queryRows("SELECT team_id, salesperson_id, is_lead, owns_none, owns_p1, owns_p2, owns_p3 FROM sales_team_members ORDER BY team_id, sort_order")),
});
const beforeProtected = snapProtected();

const setFlag = (key, on) => {
  execute(
    `INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, on ? "1" : "0", new Date().toISOString()],
  );
};

// Mirror live: multi-team + sales-admin merge + SMC on; قانون ثبت itself is OFF;
// new_customers split is 100% team 1. The hook (conv-default-owner) still points at Kazemi.
setFlag("flag.multi_team_v1", true);
setFlag("flag.sales_manager_console_v1", true);
setFlag("flag.sales_admin_merge_v12", true);
execute(
  `INSERT INTO default_owner_rule_settings(key,value,updated_at,updated_by_user_id) VALUES('config',?,?,NULL)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  [JSON.stringify({ enabled: false, ownerSalespersonId: 6, registrarMode: "all", registrarUserIds: [], sourceMode: "all", sources: [] }), new Date().toISOString()],
);
for (const [source, teamId, percent] of [["new_customers", 1, 100], ["new_customers", 2, 0], ["site_leads", 1, 100], ["site_leads", 2, 0]]) {
  execute("UPDATE sales_intake_shares SET percent=?, deficit=0 WHERE source=? AND team_id=?", [percent, source, teamId]);
}

assert.equal(mt.mtFlagOn(), true);
assert.equal(queryRow("SELECT salesperson_id FROM users WHERE id=?", [ASLANIAN_USER])?.salesperson_id, ASLANIAN_SP);
assert.equal(queryRow("SELECT team_id FROM sales_team_members WHERE salesperson_id=?", [ASLANIAN_SP])?.team_id, 2);
assert.equal(queryRow("SELECT team_id, is_lead FROM sales_team_members WHERE salesperson_id=?", [KHORDKAR_SP])?.team_id, 2);

let seq = 0;
const phone = () => `0900${String(8000000 + (seq++)).slice(-7)}`;
const sharesSnap = () => JSON.stringify(queryRows("SELECT source, team_id, percent, deficit FROM sales_intake_shares ORDER BY source, team_id"));
const splitAt = () => queryRow("SELECT updated_at FROM sales_intake_split WHERE source='new_customers'")?.updated_at ?? null;
const create = (input) => runImmediateTransaction(() => cc.insertCustomerRecord({
  name: "مشتری نمونه t989",
  phone: phone(),
  registrationSource: "staff_form",
  ...input,
}));
const ownerOf = (id) => Number(queryRow("SELECT salesperson_id FROM customers WHERE id=?", [id])?.salesperson_id);
const firstHist = (id) => queryRow(
  "SELECT source, old_salesperson_id, new_salesperson_id, actor_user_id, reason FROM customer_priority_history WHERE customer_id=? ORDER BY id LIMIT 1",
  [id],
);

ok("Aslanian none-priority registration goes to Khordkar, not Kazemi", () => {
  const shares0 = sharesSnap();
  const at0 = splitAt();
  const id = create({ registeredByUserId: ASLANIAN_USER, priority: null });
  assert.equal(ownerOf(id), KHORDKAR_SP);
  const h = firstHist(id);
  assert.equal(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(h.old_salesperson_id, null);
  assert.equal(Number(h.new_salesperson_id), KHORDKAR_SP);
  assert.equal(Number(h.actor_user_id), ASLANIAN_USER);
  assert.equal(h.reason, mt.REGISTRAR_TEAM_OWNER_REASON);
  assert.equal(sharesSnap(), shares0, "intake split cursor must not move");
  assert.equal(splitAt(), at0, "sales_intake_split.updated_at must not change");
});

ok("Aslanian P2 and P3 also go to Khordkar", () => {
  assert.equal(ownerOf(create({ registeredByUserId: ASLANIAN_USER, priority: 2 })), KHORDKAR_SP);
  assert.equal(ownerOf(create({ registeredByUserId: ASLANIAN_USER, priority: 3 })), KHORDKAR_SP);
  const h = firstHist(queryRow("SELECT id FROM customers WHERE registered_by=? ORDER BY id DESC LIMIT 1", [ASLANIAN_USER]).id);
  assert.equal(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(Number(h.new_salesperson_id), KHORDKAR_SP);
});

ok("Aslanian P1 stays with Aslanian himself (registrar owns his own P1)", () => {
  const id = create({ registeredByUserId: ASLANIAN_USER, priority: 1 });
  assert.equal(ownerOf(id), ASLANIAN_SP);
  const h = firstHist(id);
  assert.equal(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(Number(h.new_salesperson_id), ASLANIAN_SP);
});

ok("Khordkar's own none-priority registration stays with Khordkar", () => {
  const id = create({ registeredByUserId: KHORDKAR_USER, priority: null });
  assert.equal(ownerOf(id), KHORDKAR_SP);
});

ok("Hasani none and P3 (team 1) still go to Kazemi", () => {
  assert.equal(ownerOf(create({ registeredByUserId: HASANI_USER, priority: null })), KAZEMI_SP);
  assert.equal(ownerOf(create({ registeredByUserId: HASANI_USER, priority: 3 })), KAZEMI_SP);
  const h = firstHist(queryRow("SELECT id FROM customers WHERE registered_by=? ORDER BY id DESC LIMIT 1", [HASANI_USER]).id);
  assert.equal(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(Number(h.new_salesperson_id), KAZEMI_SP);
});

ok("Hasani / Ghasemi P1 stay with the registrar himself (no P1 rotation)", () => {
  const a = ownerOf(create({ registeredByUserId: HASANI_USER, priority: 1 }));
  const b = ownerOf(create({ registeredByUserId: GHASEMI_USER, priority: 1 }));
  assert.equal(a, queryRow("SELECT salesperson_id s FROM users WHERE id=?", [HASANI_USER]).s, `Hasani P1 owner ${a}`);
  assert.equal(b, queryRow("SELECT salesperson_id s FROM users WHERE id=?", [GHASEMI_USER]).s, `Ghasemi P1 owner ${b}`);
});

ok("Khordkar's own P1 stays with Khordkar", () => {
  assert.equal(ownerOf(create({ registeredByUserId: KHORDKAR_USER, priority: 1 })), KHORDKAR_SP);
});

ok("Sarina (registrar, no team) still follows the 100% team-1 lead split → Kazemi", () => {
  const at0 = splitAt();
  const id = create({ registeredByUserId: SARINA_USER, priority: null });
  assert.equal(ownerOf(id), KAZEMI_SP);
  const h = firstHist(id);
  // Hook (conv-default-owner → e6) and the lead split both yield Kazemi, so the
  // history source is the hook's default_owner_rule label, or multi_team_lead_split
  // if the hook did not match. Either way the owner is Kazemi — never registrar_team_owner.
  assert.notEqual(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(Number(h.new_salesperson_id), KAZEMI_SP);
  assert.ok(h.source === "default_owner_rule" || h.source === "multi_team_lead_split", h.source);
  // assignLeadOwner still runs for off-team registrars (100% team 1 keeps deficit at 0
  // but updates sales_intake_split.updated_at).
  assert.notEqual(splitAt(), at0);
});

ok("Younesi (trainee, not on a team) still goes to Kazemi via the global split/hook", () => {
  const id = create({ registeredByUserId: YOUNESI_USER, priority: null });
  assert.equal(ownerOf(id), KAZEMI_SP);
  const h = firstHist(id);
  assert.notEqual(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
  assert.equal(Number(h.new_salesperson_id), KAZEMI_SP);
});

ok("system intake (no registrar) still follows the global new_customers split → Kazemi", () => {
  const id = create({ registeredByUserId: null, priority: null, registrationSource: "site_lead" });
  assert.equal(ownerOf(id), KAZEMI_SP);
  const h = firstHist(id);
  assert.notEqual(h.source, mt.REGISTRAR_TEAM_OWNER_SOURCE);
});

ok("skipDefaultOwnerRule keeps the assigned expert (incoming-call path unchanged)", () => {
  const id = create({
    registeredByUserId: ASLANIAN_USER,
    assignedSalespersonId: ASLANIAN_SP,
    skipDefaultOwnerRule: true,
    priority: null,
    intake: { leadSource: "inbound_call" },
  });
  assert.equal(ownerOf(id), ASLANIAN_SP);
  assert.equal(firstHist(id), undefined);
});

ok("flag off: registrar-team helper is a no-op", () => {
  setFlag("flag.multi_team_v1", false);
  assert.equal(mt.assignRegistrarTeamOwner(ASLANIAN_USER, null), null);
  setFlag("flag.multi_team_v1", true);
});

ok("team_sales_config, closer cursor, members and intake percents are unchanged", () => {
  const after = snapProtected();
  assert.equal(after.tsc, beforeProtected.tsc);
  assert.equal(after.cursor, beforeProtected.cursor);
  assert.equal(after.members, beforeProtected.members);
  const shares = JSON.parse(after.shares);
  const before = JSON.parse(beforeProtected.shares);
  // percents must stay 100/0; deficit may have moved only for off-team/system creates
  assert.deepEqual(
    shares.map(({ source, team_id, percent }) => ({ source, team_id, percent })),
    before.map(({ source, team_id, percent }) => ({ source, team_id, percent })),
  );
});

console.log(`t989-team2-registration-owner ${passed}/${passed} passed`);
fs.rmSync(dir, { recursive: true, force: true });
