import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const ACTIVE_STAGES = [
  "draft",
  "primary_contract_pending_signature",
  "customer_documents_upload",
  "customer_documents_review",
  "guarantor_registration",
  "guarantor_documents_upload",
  "guarantor_documents_review",
  "collateral_upload",
  "collateral_review",
  "expert_approval",
  "funder_amendment_pending_signature",
  "funder_amendment_review",
  "funder_result_review",
  "funder_documents_correction",
  "physical_documents_review",
  "physical_documents_correction",
  "wallet_charge_pending",
  "admin_approval",
  "final_invoice_pending_signature",
];
const RESET_ACTION = "legacy-applications-reopened-for-initial-provider-approval";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const backupArg = args.find((arg) => arg.startsWith("--backup="))?.slice("--backup=".length);
const manifestArg = args.find((arg) => arg.startsWith("--manifest="))?.slice("--manifest=".length);
const writeManifestArg = args.find((arg) => arg.startsWith("--write-manifest="))?.slice("--write-manifest=".length);
const databasePath = process.env.CRM_DATABASE_PATH;
const EXPECTED_INVENTORY = {
  active: 24,
  signed: 15,
  linked: 22,
  walletPosted: 0,
  previouslyInitialApproved: 0,
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (!databasePath) fail("CRM_DATABASE_PATH must explicitly identify the intended database.");
if (args.some((arg) => !["--apply"].includes(arg) && !arg.startsWith("--backup=") &&
    !arg.startsWith("--manifest=") && !arg.startsWith("--write-manifest="))) {
  fail("Usage: CRM_DATABASE_PATH=/path/to/db node scripts/reopen-legacy-loans.mjs --write-manifest=/new/manifest.json | --manifest=/manifest.json [--apply --backup=/new/backup/path.db]");
}
if (APPLY && (!backupArg || !manifestArg || writeManifestArg)) fail("--apply requires --manifest and --backup; manifest generation is dry-run only.");
if (!APPLY && backupArg) fail("--backup is accepted only with --apply.");
if (manifestArg && writeManifestArg) fail("Use either --manifest or --write-manifest, not both.");
if (!manifestArg && !writeManifestArg) fail("--manifest or --write-manifest is required; broad implicit apply is forbidden.");
if (writeManifestArg && APPLY) fail("--write-manifest cannot be combined with --apply.");

const resolvedDatabase = path.resolve(databasePath);
const db = new DatabaseSync(resolvedDatabase);
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const requiredAppColumns = [
  "stage", "status", "deleted_at", "updated_at", "initial_approval_at",
  "current_primary_generation_id", "legacy_reopen_prior_stage",
];
const appColumns = columns("loan_applications");
if (requiredAppColumns.some((column) => !appColumns.includes(column))) {
  fail("Required additive schema migration is not present; deploy the API migration before this one-time script.");
}
const tableExists = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
if (!tableExists("loan_application_stage_history") || !tableExists("loan_application_generated_documents") ||
    !tableExists("contract_generations") || !tableExists("wallet_ledger_v2")) {
  fail("Required workflow or wallet tables are missing; refusing to proceed.");
}
const stageHistoryColumns = columns("loan_application_stage_history");
if (!stageHistoryColumns.includes("actor_id") || !stageHistoryColumns.includes("reason")) {
  fail("Stage history cannot record the required system actor provenance.");
}
const walletLedgerColumns = columns("wallet_ledger_v2");
if (!walletLedgerColumns.includes("application_id")) fail("Wallet ledger cannot be safely checked.");
const legacyWalletTable = tableExists("wallet_ledger") && columns("wallet_ledger").includes("application_id");

const historyAlreadyRecorded = (id) => db.prepare(`
  SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action=? LIMIT 1
`).get(id, RESET_ACTION);
const hasInitialProviderApproval = (application) =>
  Boolean(application.initial_approval_at) ||
  Boolean(db.prepare(`SELECT 1 FROM loan_application_stage_history
    WHERE application_id=? AND action='funder-initial-approve' LIMIT 1`).get(application.id));
const hasWalletPosting = (id) =>
  Boolean(db.prepare("SELECT 1 FROM wallet_ledger_v2 WHERE application_id=? LIMIT 1").get(id)) ||
  (legacyWalletTable && Boolean(db.prepare("SELECT 1 FROM wallet_ledger WHERE application_id=? LIMIT 1").get(id)));
const hasLinkedPrimary = (id) => Boolean(db.prepare(`SELECT 1 FROM loan_application_generated_documents
  WHERE application_id=? AND kind='primary' AND contract_generation_id IS NOT NULL LIMIT 1`).get(id));
const latestLinkedPrimaryGenerationId = (id) => {
  const row = db.prepare(`SELECT contract_generation_id FROM loan_application_generated_documents
    WHERE application_id=? AND kind='primary' AND contract_generation_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
  return row ? Number(row.contract_generation_id) : null;
};
const hasSignedPrimary = (id) => Boolean(db.prepare(`SELECT 1 FROM loan_application_generated_documents d
  JOIN contract_generations g ON g.id=d.contract_generation_id
  WHERE d.application_id=? AND d.kind='primary' AND d.link LIKE 'signed:%' AND g.status='signed' LIMIT 1`).get(id));
const broadCandidateRows = () => db.prepare(`
  SELECT * FROM loan_applications
  WHERE deleted_at IS NULL AND status IN ('requested','reviewing')
    AND stage IN (${ACTIVE_STAGES.map(() => "?").join(",")})
    AND stage<>'funder_initial_approval'
  ORDER BY id
`).all(...ACTIVE_STAGES);
const applicationById = db.prepare("SELECT * FROM loan_applications WHERE id=?");
const inventoryFor = (applications) => ({
  active: applications.length,
  signed: applications.filter((application) => hasSignedPrimary(application.id)).length,
  linked: applications.filter((application) => hasLinkedPrimary(application.id)).length,
  walletPosted: applications.filter((application) => hasWalletPosting(application.id)).length,
  previouslyInitialApproved: applications.filter(hasInitialProviderApproval).length,
});
const assertExpectedInventory = (inventory) => {
  assert.deepEqual(inventory, EXPECTED_INVENTORY, "manifest inventory differs from the approved 24/15/22/0/0 baseline");
};
const makeManifest = (applications) => ({
  version: 3,
  inventory: inventoryFor(applications),
  applications: applications.map((application) => ({
    id: Number(application.id),
    stage: application.stage,
    status: application.status,
    updatedAt: application.updated_at,
    currentPrimaryGenerationId: application.current_primary_generation_id == null
      ? null : Number(application.current_primary_generation_id),
    latestPrimaryGenerationId: latestLinkedPrimaryGenerationId(application.id),
  })),
});
function validateManifest(manifest) {
  assert.equal(manifest?.version, 3, "unsupported manifest version");
  assert.deepEqual(manifest?.inventory, EXPECTED_INVENTORY, "manifest does not declare the approved 24/15/22/0/0 inventory");
  assert.ok(Array.isArray(manifest?.applications) && manifest.applications.length === EXPECTED_INVENTORY.active,
    "manifest must contain exactly 24 application entries");
  const ids = manifest.applications.map((entry) => Number(entry.id));
  assert.ok(ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length,
    "manifest IDs must be unique positive integers");

  const rows = manifest.applications.map((entry) => {
    const application = applicationById.get(Number(entry.id));
    assert.ok(application, `manifest application missing:${entry.id}`);
    assert.equal(application.stage, entry.stage, `stage drift:${entry.id}`);
    assert.equal(application.status, entry.status, `status drift:${entry.id}`);
    assert.equal(application.updated_at, entry.updatedAt, `updated_at drift:${entry.id}`);
    assert.ok(Object.hasOwn(entry, "currentPrimaryGenerationId"), `manifest current primary marker missing:${entry.id}`);
    const expectedPrimaryId = entry.currentPrimaryGenerationId;
    assert.ok(expectedPrimaryId === null || (Number.isSafeInteger(expectedPrimaryId) && expectedPrimaryId > 0),
      `manifest current primary marker is invalid:${entry.id}`);
    assert.equal(application.current_primary_generation_id ?? null, expectedPrimaryId, `current primary marker drift:${entry.id}`);
    const latestPrimaryId = latestLinkedPrimaryGenerationId(application.id);
    assert.ok(Object.hasOwn(entry, "latestPrimaryGenerationId"), `manifest latest primary generation missing:${entry.id}`);
    assert.ok(entry.latestPrimaryGenerationId === null ||
      (Number.isSafeInteger(entry.latestPrimaryGenerationId) && entry.latestPrimaryGenerationId > 0),
    `manifest latest primary generation is invalid:${entry.id}`);
    assert.equal(latestPrimaryId, entry.latestPrimaryGenerationId, `latest primary generation drift:${entry.id}`);
    assert.ok(expectedPrimaryId === null || expectedPrimaryId === latestPrimaryId,
      `current primary marker is not latest linked primary:${entry.id}`);
    assert.equal(application.deleted_at, null, `application deleted:${entry.id}`);
    assert.ok(ACTIVE_STAGES.includes(application.stage) && application.stage !== "funder_initial_approval",
      `application stage is not eligible:${entry.id}`);
    assert.ok(["requested", "reviewing"].includes(application.status), `application status is not eligible:${entry.id}`);
    assert.equal(application.initial_approval_at, null, `initial approval already exists:${entry.id}`);
    assert.equal(application.legacy_reopen_prior_stage, null, `legacy reopen marker already exists:${entry.id}`);
    assert.equal(Boolean(historyAlreadyRecorded(application.id)), false, `application already reset:${entry.id}`);
    assert.equal(hasInitialProviderApproval(application), false, `initial approval history exists:${entry.id}`);
    assert.equal(hasWalletPosting(application.id), false, `wallet posting exists:${entry.id}`);
    assert.ok(typeof entry.updatedAt === "string" && entry.updatedAt.length > 0, `manifest updatedAt is invalid:${entry.id}`);
    return application;
  });
  assertExpectedInventory(inventoryFor(rows));
  return rows;
}

let manifest;
let manifestPath;
if (writeManifestArg) {
  manifestPath = path.resolve(writeManifestArg);
  if (fs.existsSync(manifestPath)) fail("Manifest destination must be new; refusing to overwrite.");
  const applications = broadCandidateRows();
  manifest = makeManifest(applications);
  assertExpectedInventory(manifest.inventory);
  validateManifest(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
} else {
  manifestPath = path.resolve(manifestArg);
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

const validatedRows = validateManifest(manifest);
process.stdout.write(JSON.stringify({
  mode: APPLY ? "apply" : "dry-run",
  database: resolvedDatabase,
  manifest: manifestPath,
  eligibleCount: validatedRows.length,
  eligible: manifest.applications,
  inventory: manifest.inventory,
}, null, 2) + "\n");

if (!APPLY) {
  db.close();
  process.exit(0);
}

const backupPath = path.resolve(backupArg);
if (backupPath === resolvedDatabase || fs.existsSync(backupPath)) fail("Backup destination must be new and distinct from the database.");
if (!fs.existsSync(path.dirname(backupPath))) fail("Backup parent directory must already exist.");
validateManifest(manifest);
await backup(db, backupPath);
const checkBackup = new DatabaseSync(backupPath, { readOnly: true });
try {
  assert.equal(checkBackup.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "backup integrity check failed");
} finally {
  checkBackup.close();
}
process.stdout.write(`Verified pre-change backup: ${backupPath}\n`);

const now = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  const currentRows = validateManifest(manifest);
  const changedApplications = [];
  for (const application of currentRows) {
    const documents = db.prepare(`SELECT id,kind,contract_generation_id,link,COALESCE(status,'pending') status
      FROM loan_application_generated_documents WHERE application_id=? ORDER BY id`).all(application.id);
    const generations = db.prepare(`SELECT id,loan_application_id,template_id,loan_plan_id,customer_id,status,provider_contract_id,
      provider_status,pdf_sha256,superseded_at,deleted_at
      FROM contract_generations WHERE loan_application_id=? OR id IN
        (SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND contract_generation_id IS NOT NULL)
      ORDER BY id`).all(application.id, application.id);
    const audit = {
      provenance: "system:one-time-legacy-reopen; no user impersonation",
      priorStage: application.stage,
      priorStatus: application.status,
      priorUpdatedAt: application.updated_at,
      priorPrimaryGenerationId: application.current_primary_generation_id ?? null,
      priorFinancialDecision: {
        approvedAmount: application.approved_amount ?? null,
        netAmount: application.net_amount ?? null,
        approvedAmountSource: application.approved_amount_source ?? null,
        approvedAmountGenerationId: application.approved_amount_generation_id ?? null,
        initialApprovalAt: application.initial_approval_at ?? null,
        initialApprovalByUserId: application.initial_approval_by_user_id ?? null,
        initialApprovalReason: application.initial_approval_reason ?? null,
        funderDecision: application.funder_decision ?? null,
        funderReason: application.funder_reason ?? null,
        expertReviewedAt: application.expert_reviewed_at ?? null,
        adminApprovedAt: application.admin_approved_at ?? null,
      },
      documentReferences: documents,
      generationReferences: generations,
      feesAndWalletsChanged: false,
    };
    const updated = db.prepare(`UPDATE loan_applications
      SET stage='funder_initial_approval',status='reviewing',legacy_reopen_prior_stage=?,
          current_primary_generation_id=NULL,updated_at=?
      WHERE id=? AND stage=? AND status=? AND updated_at=? AND deleted_at IS NULL
        AND initial_approval_at IS NULL AND current_primary_generation_id IS ?`)
      .run(application.stage, now, application.id, application.stage, application.status, application.updated_at,
        application.current_primary_generation_id ?? null);
    if (Number(updated.changes) !== 1) throw new Error(`application_changed_during_reopen:${application.id}`);
    db.prepare(`INSERT INTO loan_application_stage_history
      (application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,0,?)`)
      .run(application.id, application.stage, "funder_initial_approval", RESET_ACTION, JSON.stringify(audit), now);
    changedApplications.push(Number(application.id));
  }
  db.exec("COMMIT");
  process.stdout.write(JSON.stringify({ appliedCount: changedApplications.length, applicationIds: changedApplications }, null, 2) + "\n");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}