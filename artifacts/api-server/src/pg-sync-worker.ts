import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import {
  PRAGMA_SQL,
  classifyPragma,
  isInsert,
  rewriteStatement,
  splitStatements,
  withReturning,
} from "./lib/pg-sql";

type Req =
  | { op: "connect"; config: Record<string, string> }
  | { op: "exec"; sql: string }
  | { op: "query"; sql: string; params?: unknown[] }
  | { op: "run"; sql: string; params?: unknown[] }
  | { op: "close" };

type Res = {
  ok: boolean;
  rows?: Record<string, unknown>[];
  lastInsertRowid?: number | string;
  changes?: number;
  error?: string;
  code?: string;
};

if (!parentPort) throw new Error("pg-sync-worker must run as a worker thread");

const { Client } = pg;
// BIGINT -> number (CRM ids fit in 2^53). Booleans -> 0/1 like SQLite.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(21, (v: string) => Number(v));
pg.types.setTypeParser(23, (v: string) => Number(v));
pg.types.setTypeParser(16, (v: string) => (v === "t" || v === "true" ? 1 : 0));


const sab: SharedArrayBuffer | undefined = workerData && workerData.sab;
function writeResult(res: Res): void {
  if (!sab) throw new Error("pg-sync-worker missing sab in workerData");
  const payload = Buffer.from(JSON.stringify(res), "utf8");
  if (8 + payload.length > sab.byteLength) {
    writeResult({ ok: false, error: `result too large (${payload.length} bytes)` });
    return;
  }
  new Uint8Array(sab).set(payload, 8);
  const i32 = new Int32Array(sab);
  Atomics.store(i32, 1, payload.length);
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
}

let client: pg.Client | null = null;
let inTxn = false;

function isBeginSql(sql: string): boolean {
  return /^\s*BEGIN\b/i.test(sql);
}
function isCommitSql(sql: string): boolean {
  return /^\s*COMMIT\b/i.test(sql);
}
function isRollbackSql(sql: string): boolean {
  return /^\s*ROLLBACK\b/i.test(sql) && !/^\s*ROLLBACK\s+TO\b/i.test(sql);
}
function isSavepointSql(sql: string): boolean {
  return /^\s*SAVEPOINT\b/i.test(sql);
}

async function queryWithTxn(sql: string, params?: unknown[]) {
  if (!client) throw new Error("not connected");
  if (isSavepointSql(sql) && !inTxn) {
    await client.query("BEGIN");
    inTxn = true;
  }
  const r = params !== undefined ? await client.query(sql, params) : await client.query(sql);
  if (isBeginSql(sql)) inTxn = true;
  if (isCommitSql(sql) || isRollbackSql(sql)) inTxn = false;
  return r;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else if (typeof v === "bigint") out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function lastIdFromRow(row: Record<string, unknown> | undefined): number {
  if (!row) return 0;
  if (typeof row.id === "number") return row.id;
  if (typeof row.id === "string" && row.id !== "" && !Number.isNaN(Number(row.id))) return Number(row.id);
  for (const v of Object.values(row)) {
    if (typeof v === "number" && Number.isInteger(v)) return v;
  }
  return 0;
}

const SKIP_COMPAT = /(?:^|\/)(all_triggers\.sql|julianday_index\.sql)$/i;

function isCompatSql(file: string): boolean {
  const base = path.basename(file);
  if (!base.endsWith(".sql")) return false;
  if (SKIP_COMPAT.test(file)) return false;
  // Load function/compat SQL only. Trigger install files persist in the database.
  return (
    base === "sqlite_compat.sql" ||
    base.startsWith("zz-") ||
    base.includes("compat") ||
    base.includes("alias") ||
    base.includes("udf") ||
    base.includes("function")
  );
}

function findCompatFiles(extraDir?: string): string[] {
  const candidates: string[] = [];
  const env = process.env.NAFIS_PG_COMPAT_SQL;
  if (env) candidates.push(env);
  const dirs = [
    extraDir,
    process.env.NAFIS_PG_SQL_DIR,
    "/root/pg-migration/sql",
    path.resolve(process.cwd(), "db/pg"),
    path.resolve(process.cwd(), "../../db/pg"),
  ].filter(Boolean) as string[];
  const files: string[] = [];
  for (const c of candidates) if (c && fs.existsSync(c) && !SKIP_COMPAT.test(c)) files.push(c);
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (isCompatSql(full)) files.push(full);
    }
  }
  return [...new Set(files)];
}

async function connect(config: Record<string, string>) {
  if (client) {
    try { await client.end(); } catch { /* ignore */ }
  }
  const c = new Client({
    connectionString: config.DATABASE_URL || undefined,
    host: config.PGHOST || "127.0.0.1",
    port: Number(config.PGPORT || 5432),
    user: config.PGUSER || "nafisvam",
    password: config.PGPASSWORD,
    database: config.PGDATABASE || "nafisvam",
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  await c.query("SET timezone = 'UTC'");
  await c.query("SET standard_conforming_strings = on");
  client = c;
  inTxn = false;
  for (const file of findCompatFiles(config.NAFIS_PG_SQL_DIR)) {
    const sql = fs.readFileSync(file, "utf8");
    try {
      await c.query(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`compat sql failed ${path.basename(file)}: ${msg}`);
    }
  }
}

async function handlePragma(sql: string): Promise<Res> {
  if (!client) throw new Error("not connected");
  const p = classifyPragma(sql);
  if (!p) return { ok: true, rows: [], changes: 0 };
  if (p.kind === "noop") return { ok: true, rows: p.result || [{ ok: 1 }], changes: 0 };
  if (p.kind === "integrity_check") return { ok: true, rows: [{ integrity_check: "ok" }], changes: 0 };
  if (p.kind === "journal_mode") return { ok: true, rows: [{ journal_mode: "wal" }], changes: 0 };
  if (p.kind === "foreign_key_check") {
    const r = await client.query("SELECT 1 WHERE false");
    return { ok: true, rows: r.rows, changes: 0 };
  }
  if (p.kind === "table_info") {
    const r = await client.query(PRAGMA_SQL.table_info(p.table), [p.table]);
    return { ok: true, rows: r.rows.map(normalizeRow), changes: 0 };
  }
  if (p.kind === "foreign_key_list") {
    const r = await client.query(PRAGMA_SQL.foreign_key_list, [p.table]);
    return { ok: true, rows: r.rows.map(normalizeRow), changes: 0 };
  }
  if (p.kind === "index_list") {
    const r = await client.query(PRAGMA_SQL.index_list, [p.table]);
    return { ok: true, rows: r.rows.map(normalizeRow), changes: 0 };
  }
  if (p.kind === "index_info") {
    const r = await client.query(PRAGMA_SQL.index_info, [p.index]);
    return { ok: true, rows: r.rows.map(normalizeRow), changes: 0 };
  }
  return { ok: true, rows: [], changes: 0 };
}

function isSqliteTriggerDdl(sql: string): boolean {
  // Triggers are installed by migrate.py / install_triggers.py.
  // SQLite DROP TRIGGER has no ON table; PG would fail with "syntax error at end of input".
  return /^\s*(CREATE\s+(TEMP(?:ORARY)?\s+)?TRIGGER|DROP\s+TRIGGER)\b/i.test(sql);
}

async function runOne(sql: string, params: unknown[] = [], mode: "query" | "run"): Promise<Res> {
  if (!client) throw new Error("not connected");
  if (classifyPragma(sql)) return handlePragma(sql);
  if (isSqliteTriggerDdl(sql)) return { ok: true, rows: [], changes: 0 };
  let rewritten = rewriteStatement(sql);
  if (mode === "run" && isInsert(rewritten)) rewritten = withReturning(rewritten);
  const r = await queryWithTxn(rewritten, params);
  const rows = (r.rows || []).map((row) => normalizeRow(row as Record<string, unknown>));
  const changes = r.rowCount ?? rows.length;
  const lastInsertRowid = mode === "run" ? lastIdFromRow(rows[0]) : 0;
  return { ok: true, rows, changes, lastInsertRowid };
}

async function execBatch(sql: string): Promise<Res> {
  if (!client) throw new Error("not connected");
  const stmts = splitStatements(sql);
  let changes = 0;
  let lastInsertRowid = 0;
  let rows: Record<string, unknown>[] = [];
  for (const raw of stmts) {
    if (classifyPragma(raw)) {
      const r = await handlePragma(raw);
      rows = r.rows || [];
      changes += r.changes || 0;
      continue;
    }
    if (isSqliteTriggerDdl(raw)) continue;
    const rewritten = rewriteStatement(raw);
    const r = await queryWithTxn(rewritten);
    const batch = (r.rows || []).map((row) => normalizeRow(row as Record<string, unknown>));
    if (batch.length) rows = batch;
    changes += r.rowCount ?? batch.length;
    if (isInsert(rewritten) && batch[0]) lastInsertRowid = lastIdFromRow(batch[0]);
  }
  return { ok: true, rows, changes, lastInsertRowid };
}

parentPort.on("message", async (req: Req) => {
  const reply = (res: Res) => {
    writeResult(res);
  };
  try {
    if (req.op === "connect") {
      await connect(req.config);
      reply({ ok: true, rows: [], changes: 0 });
      return;
    }
    if (req.op === "close") {
      if (client) {
        await client.end();
        client = null;
        inTxn = false;
      }
      reply({ ok: true, changes: 0 });
      return;
    }
    if (req.op === "exec") {
      reply(await execBatch(req.sql));
      return;
    }
    if (req.op === "query") {
      reply(await runOne(req.sql, req.params || [], "query"));
      return;
    }
    if (req.op === "run") {
      reply(await runOne(req.sql, req.params || [], "run"));
      return;
    }
    reply({ ok: false, error: `unknown op` });
  } catch (err) {
    const e = err as { message?: string; code?: string };
    try {
      const op = (req as { op?: string }).op || "?";
      const sql = "sql" in req && typeof (req as { sql?: string }).sql === "string" ? (req as { sql: string }).sql : "";
      const line = new Date().toISOString() + " " + op + " " + (e.message || String(err)).replace(/\s+/g, " ") + "\nSQL " + sql.replace(/\s+/g, " ").slice(0, 2000) + "\n";
      fs.appendFileSync("/tmp/pg-sql-errors.log", line);
    } catch { /* ignore */ }
    reply({ ok: false, error: e.message || String(err), code: e.code });
  }
});
