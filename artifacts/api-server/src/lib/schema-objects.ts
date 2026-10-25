import type { DatabaseSync } from "node:sqlite";

/*
 * Startup DDL must leave the schema untouched when nothing changed.
 *
 * Every DROP/CREATE of a persistent trigger, index or view bumps SQLite's
 * PRAGMA schema_version (the "schema cookie"), even when it recreates the
 * identical object. The release manager treats a changed cookie as "the new
 * build migrated the DB", so a failed health check then ends in
 * manual_recovery_required instead of an automatic rollback.
 * `CREATE … IF NOT EXISTS` on an existing object and `DROP … IF EXISTS` on a
 * missing one do NOT bump it (verified with node:sqlite).
 *
 * ensureSchemaObject() recreates an object only when it is missing or its
 * stored definition differs from the wanted one. SQLite stores the CREATE text
 * verbatim except that it canonicalises the leading "CREATE [UNIQUE|TEMP] KIND"
 * keywords, so both sides are compared after that and after whitespace folding.
 */
export type SchemaObjectType = "trigger" | "index" | "view";

export function normalizeSchemaSql(sql: string): string {
  return sql
    .trim()
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .replace(/^create (unique |temp |temporary )?(trigger|index|view) /i, (m) => m.toUpperCase());
}

export function storedSchemaSql(db: DatabaseSync, type: SchemaObjectType, name: string): string | null {
  const row = db.prepare("SELECT sql FROM main.sqlite_master WHERE type=? AND name=?").get(type, name) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function schemaObjectMatches(db: DatabaseSync, type: SchemaObjectType, name: string, createSql: string): boolean {
  const current = storedSchemaSql(db, type, name);
  return current !== null && normalizeSchemaSql(current) === normalizeSchemaSql(createSql);
}

/** Returns true when the object was (re)created, false when it already matched. */
export function ensureSchemaObject(db: DatabaseSync, type: SchemaObjectType, name: string, createSql: string): boolean {
  if (!/^\s*CREATE\s/i.test(createSql)) throw new Error(`ensureSchemaObject(${name}): CREATE statement expected`);
  if (schemaObjectMatches(db, type, name, createSql)) return false;
  db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name.replace(/"/g, '""')}"`);
  db.exec(createSql.trim().replace(/;\s*$/, ""));
  return true;
}
