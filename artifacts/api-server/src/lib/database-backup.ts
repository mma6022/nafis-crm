import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crmDb, databasePath } from "./crm-db";
import { logger } from "./logger";

const backupDir = process.env.AUTO_BACKUP_DIR
  ? path.resolve(process.env.AUTO_BACKUP_DIR)
  : path.resolve(path.dirname(databasePath), "backups", "daily");

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function createDatabaseBackup(prefix = "daily"): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `${prefix}-${stamp}.db`);
  crmDb.exec(`VACUUM INTO ${sqlString(target)}`);
  return target;
}

export function validateSqliteDatabase(filePath: string): void {
  const candidate = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = candidate.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (result.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const required = candidate.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'customers', 'salespersons')",
    ).get() as { count: number };
    if (Number(required.count) !== 3) throw new Error("Required CRM tables are missing");
  } finally {
    candidate.close();
  }
}

function pruneDailyBackups(): void {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir)
    .filter((name) => /^daily-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const file of files.slice(7)) fs.unlinkSync(path.join(backupDir, file));
}

let lastBackupDate = "";

function tehranDateParts(): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: value("hour"), minute: value("minute") };
}

function runScheduledBackup(): void {
  const now = tehranDateParts();
  if (now.hour !== "00" || now.minute !== "01" || now.date === lastBackupDate) return;
  try {
    const file = createDatabaseBackup();
    pruneDailyBackups();
    lastBackupDate = now.date;
    logger.info({ file }, "daily database backup completed");
  } catch (error) {
    logger.error({ err: error }, "daily database backup failed");
  }
}

export function startDatabaseBackupScheduler(): void {
  fs.mkdirSync(backupDir, { recursive: true });
  pruneDailyBackups();
  runScheduledBackup();
  const timer = setInterval(runScheduledBackup, 30_000);
  timer.unref();
  logger.info({ backupDir, schedule: "00:01 Asia/Tehran", retention: 7 }, "database backup scheduler started");
}