/**
 * Idempotent multi-team schema + seed. LOCAL / copy only.
 * Usage: CRM_DATABASE_PATH=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/multi-team-migrate.mjs
 * Never writes notification_settings or team_sales_config. Does not turn the flag on.
 */
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
import path from "node:path";

const dbPath = process.env.CRM_DATABASE_PATH;
if (!dbPath) { console.error("Set CRM_DATABASE_PATH to a database COPY (not the live file)."); process.exit(2); }
const resolved = path.resolve(dbPath);
if (resolved === "/var/lib/nafisvam/customers.db") {
  console.error("Refusing to run against the live database.");
  process.exit(2);
}

const { migrateMultiTeam, loadAllTeams, readLegacyCloserCursor, readLegacyTeamSalesConfig, resetMultiTeamSchemaCache } = await import("../src/lib/multi-team.ts");
resetMultiTeamSchemaCache();
const beforeCursor = readLegacyCloserCursor();
const beforeCfg = readLegacyTeamSalesConfig();
const result = migrateMultiTeam();
const teams = loadAllTeams();
const afterCursor = readLegacyCloserCursor();
const afterCfg = JSON.stringify(readLegacyTeamSalesConfig());
console.log(JSON.stringify({
  db: resolved,
  seeded: result.seeded,
  teams: teams.map((t) => ({
    id: t.id, name: t.name, enabled: t.enabled, leadSplitQuota: t.leadSplitQuota, p1Cursor: t.p1Cursor,
    commissionJson: t.commissionJson,
    members: t.members,
  })),
  legacyCursorUnchanged: beforeCursor === afterCursor,
  legacyCursor: afterCursor,
  legacyConfigUnchanged: JSON.stringify(beforeCfg) === afterCfg,
}, null, 2));
