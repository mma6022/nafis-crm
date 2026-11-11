import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker } from "node:worker_threads";

export type SqlValue = string | number | null;

type Res = {
  ok: boolean;
  rows?: Record<string, unknown>[];
  lastInsertRowid?: number | string;
  changes?: number;
  error?: string;
  code?: string;
};

const RESULT_BYTES = 4 * 1024 * 1024;
const HEADER_INTS = 2; // [status, length]
const CALL_TIMEOUT_MS = 60_000;

function workerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fs = createRequire(import.meta.url)("fs") as typeof import("fs");
  const candidates = [
    path.join(here, "pg-sync-worker.cjs"),
    path.join(here, "pg-sync-worker.mjs"),
    path.join(here, "pg-sync-worker.ts"),
    path.join(here, "../pg-sync-worker.cjs"),
    path.join(here, "../pg-sync-worker.mjs"),
    path.join(here, "../src/pg-sync-worker.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function pgConfigFromEnv(): Record<string, string> {
  const keys = [
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGSSLMODE",
    "NAFIS_PG_COMPAT_SQL",
    "NAFIS_PG_SQL_DIR",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

class PgBridge {
  private worker: Worker;
  private sab: SharedArrayBuffer;
  private i32: Int32Array;
  private dead: Error | null = null;

  constructor() {
    this.sab = new SharedArrayBuffer(RESULT_BYTES);
    this.i32 = new Int32Array(this.sab);
    const wp = workerPath();
    this.worker = new Worker(wp, {
      execArgv: wp.endsWith(".ts") ? ["--experimental-strip-types"] : [],
      workerData: { sab: this.sab },
    });
    this.worker.on("error", (err) => {
      this.dead = err;
    });
    this.worker.on("exit", (code) => {
      if (!this.dead && code !== 0) this.dead = new Error(`pg worker exited ${code}`);
    });
  }

  call(req: object): Res {
    if (this.dead) throw this.dead;
    Atomics.store(this.i32, 0, 0);
    Atomics.store(this.i32, 1, 0);
    this.worker.postMessage(req);
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    while (Atomics.load(this.i32, 0) === 0) {
      if (this.dead) throw this.dead;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("pg worker timed out");
      Atomics.wait(this.i32, 0, 0, Math.min(100, remaining));
    }
    const len = Atomics.load(this.i32, 1);
    if (len <= 0 || 8 + len > this.sab.byteLength) {
      throw new Error(`pg worker bad result length ${len}`);
    }
    const bytes = new Uint8Array(this.sab, 8, len);
    return JSON.parse(new TextDecoder().decode(bytes)) as Res;
  }

  close(): void {
    try {
      this.call({ op: "close" });
    } catch {
      /* ignore */
    }
    void this.worker.terminate();
  }
}

export type RunResult = { lastInsertRowid: number; changes: number };

export class PgStatement {
  constructor(
    private readonly bridge: PgBridge,
    private readonly sql: string,
  ) {}

  all(...params: SqlValue[]): Record<string, unknown>[] {
    const res = this.bridge.call({ op: "query", sql: this.sql, params });
    if (!res.ok) throw pgError(res);
    return res.rows || [];
  }

  get(...params: SqlValue[]): Record<string, unknown> | undefined {
    return this.all(...params)[0];
  }

  run(...params: SqlValue[]): RunResult {
    const res = this.bridge.call({ op: "run", sql: this.sql, params });
    if (!res.ok) throw pgError(res);
    return {
      lastInsertRowid: Number(res.lastInsertRowid || 0),
      changes: Number(res.changes || 0),
    };
  }
}

export class PgDatabase {
  private readonly bridge: PgBridge;
  constructor(config?: Record<string, string>) {
    this.bridge = new PgBridge();
    const res = this.bridge.call({ op: "connect", config: { ...pgConfigFromEnv(), ...(config || {}) } });
    if (!res.ok) throw pgError(res);
  }

  exec(sql: string): void {
    const res = this.bridge.call({ op: "exec", sql });
    if (!res.ok) throw pgError(res);
  }

  prepare(sql: string): PgStatement {
    return new PgStatement(this.bridge, sql);
  }

  // JS UDFs are installed as SQL in sqlite_compat; keep a no-op for call-site compatibility.
  function(_name: string, _fn: (...args: unknown[]) => unknown): void {
    /* no-op */
  }

  close(): void {
    this.bridge.close();
  }
}

function pgError(res: Res): Error {
  const err = new Error(res.error || "postgres error") as Error & { code?: string };
  if (res.code) err.code = res.code;
  return err;
}

export function openPgDatabase(config?: Record<string, string>): PgDatabase {
  return new PgDatabase(config);
}
