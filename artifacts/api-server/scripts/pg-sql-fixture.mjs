import { rewriteStatement, splitStatements, classifyPragma, rewritePlaceholders, rewriteConcat, rewriteIntTruth, rewriteRowid } from "../src/lib/pg-sql.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(rewritePlaceholders("SELECT * FROM t WHERE a=? AND b=?") === "SELECT * FROM t WHERE a=$1 AND b=$2", "placeholders");
assert(rewritePlaceholders("SELECT '?' AS x, a=?") === "SELECT '?' AS x, a=$1", "placeholders ignore string");
assert(rewriteStatement("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").includes("ON CONFLICT DO NOTHING"), "or ignore");
assert(rewriteStatement("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").includes("$1"), "or ignore $1");
assert(rewriteStatement("BEGIN IMMEDIATE") === "BEGIN", "begin immediate");
assert(rewriteStatement("SELECT * FROM main.sqlite_master WHERE name=?").includes("sqlite_master") && rewriteStatement("SELECT * FROM main.sqlite_master WHERE name=?").includes("$1"), "sqlite_master");
assert(rewriteStatement("SELECT * FROM t WHERE phone GLOB '[0-9]*'").includes("sqlite_glob"), "glob");
const ddl = rewriteStatement(`CREATE TABLE IF NOT EXISTS customer_dossier (
    customer_id INTEGER PRIMARY KEY,
    amount_toman INTEGER,
    city TEXT
  )`);
assert(ddl.includes("BIGINT PRIMARY KEY"), `dossier pk: ${ddl}`);
assert(ddl.includes("amount_toman BIGINT"), `dossier amount: ${ddl}`);
assert(classifyPragma("PRAGMA busy_timeout=5000")?.kind === "noop", "pragma noop");
assert(classifyPragma("PRAGMA table_info(customers)")?.kind === "table_info", "table_info");
assert(classifyPragma('PRAGMA table_info("customers")')?.kind === "table_info", "table_info quoted");
assert(splitStatements("BEGIN; INSERT INTO t(a) VALUES (1); COMMIT;").length === 3, "split");

assert(rewriteIntTruth("WHERE ((e.recipient_user_id IS NULL AND 1 ) OR x=1)") .includes("AND TRUE"), "and 1 -> TRUE");
assert(!rewriteIntTruth("AND 1=1").includes("TRUE=1"), "do not rewrite AND 1=1");
const concat = rewriteConcat("SELECT customer_id || ':' || owner_salesperson_id k FROM t");
assert(/customer_id\s*::text/.test(concat) && concat.includes("||") && /owner_salesperson_id\s*::text\s+k\b/.test(concat), "concat casts: "+concat);
assert(rewriteRowid("ORDER BY MIN(rowid)").includes("MIN(ctid)"), "rowid");
assert(rewriteStatement("SELECT a || ':' || b FROM t WHERE x=?").includes("$1"), "concat+placeholder");
assert(/\ba\s*::text/.test(rewriteStatement("SELECT a || ':' || b FROM t WHERE x=?")), "concat in rewriteStatement");
console.log("pg-sql fixture OK");
