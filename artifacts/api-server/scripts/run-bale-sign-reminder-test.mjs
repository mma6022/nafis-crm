#!/usr/bin/env node
/** Copy a masked DB to a temp scratch and run the bale-sign-reminder fixture.
 *  Never uses the live DB. Never prints phones or tokens.
 */
import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIVE = "/var/lib/nafisvam/customers.db";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.SR_MASKED_DB,
  process.env.CRM_DATABASE_PATH,
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/signrem/scratch.db",
].filter(Boolean);

function resolveSrc() {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error("no masked source DB (set SR_MASKED_DB or CRM_DATABASE_PATH)");
}

const src = resolveSrc();
const srcReal = realpathSync(src);
if (srcReal === LIVE) {
  console.error("REFUSING_LIVE_DB");
  process.exit(5);
}
const dir = mkdtempSync(path.join(tmpdir(), "sr-fixture-"));
const dest = path.join(dir, "scratch.db");
const py = spawnSync("python3", ["-c",
  "import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);print(d.execute('PRAGMA integrity_check').fetchone()[0]);d.close()",
  srcReal, dest], { encoding: "utf8" });
if (py.status !== 0 || !py.stdout.trim().split("\n").pop().includes("ok")) {
  rmSync(dir, { recursive: true, force: true });
  console.error("SCRATCH_DB_COPY_FAIL");
  process.exit(5);
}
const run = spawnSync(process.execPath, [
  path.join(root, "scripts/run-bundled-fixture.mjs"),
  "scripts/bale-sign-reminder-fixture.mjs",
], {
  stdio: "inherit",
  env: { ...process.env, CRM_DATABASE_PATH: dest, BALE_BOT_WORKER: "0", NODE_ENV: "production", LOG_LEVEL: process.env.LOG_LEVEL || "silent" },
  cwd: root,
  timeout: 120000,
});
rmSync(dir, { recursive: true, force: true });
process.exit(run.status ?? 1);
