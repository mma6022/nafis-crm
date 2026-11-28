#!/usr/bin/env node
/** t979: copy a MASKED DB to a temp scratch (never live) and run the bundled fixture with workers off and the network blocked. */
import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const LIVE = "/var/lib/nafisvam/customers.db";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = [process.env.T979_MASKED_DB, process.env.BWS_MASKED_DB, "/workspace/sam-v12/shots-masked-live-510000.db", "/workspace/t861/masked.db"].find((c) => c && existsSync(c));
if (!src) { console.error("NO_MASKED_DB"); process.exit(2); }
if (realpathSync(src) === LIVE) { console.error("REFUSING_LIVE_DB"); process.exit(2); }
const dir = mkdtempSync(path.join(tmpdir(), "t979-qr-"));
const db = path.join(dir, "scratch.db");
try {
  const s = new DatabaseSync(src, { readOnly: true });
  s.exec(`VACUUM INTO '${db.replace(/'/g, "''")}'`); s.close();
  const r = spawnSync(process.execPath, [path.join(root, "scripts/run-bundled-fixture.mjs"), "scripts/t979-quick-replies-fixture.mjs"], {
    cwd: root, stdio: "inherit", timeout: 180000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", CRM_DATABASE_PATH: db, NODE_ENV: "production", LOG_LEVEL: "warn", BALE_BOT_WORKER: "0", BALE_WORKER: "0", SMS_DISABLED: "1", SAB_FEEDER: "0",
      BALE_BOT_FILES_DIR: path.join(dir, "bot-files"), BWS_FILES_DIR: path.join(dir, "bws-files"), BALE_BOT_KEY_FILE: path.join(dir, "bot.key"),
      SESSION_SECRET: "fixture-only-not-a-secret", TZ: "UTC" },
  });
  process.exitCode = r.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
