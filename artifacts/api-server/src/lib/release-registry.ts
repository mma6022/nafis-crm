// Release 84(A): read-only release registry (site releases + CRM release metadata).
//
// Storage choice: two small JSON files OUTSIDE every release directory
// (default /var/lib/nafisvam/release-registry/, root:www-data 0640), not a DB table:
//   * no schema change in customers.db (a new table would itself be a schema change and
//     would move the CRM rollback cut-off);
//   * the CRM never writes them; only root deploy scripts append (release-registry/append.py);
//   * survives every CRM/site relink because it lives in neither release tree;
//   * a missing or broken file only makes the tab say «در دسترس نیست»; nothing else breaks.
// Pure helpers are exported for the unit fixture (scripts/release-registry-fixture.mjs).
import { promises as fs } from "node:fs";
import path from "node:path";

export const TEHRAN_OFFSET_MINUTES = 210; // Iran: UTC+03:30 all year (no DST since 2022)
export const RID_RE = /^\d{14}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const MAX_FILE_BYTES = 512 * 1024;

export function registryDir(): string {
  return process.env.NAFISVAM_RELEASE_REGISTRY_DIR || "/var/lib/nafisvam/release-registry";
}
export function siteRoot(): string {
  return process.env.NAFISVAM_SITE_ROOT || "/opt/nafisvam-site";
}

/** "20261028212415" (UTC) -> Date, or null when not a real UTC timestamp. */
export function ridToDate(rid: string): Date | null {
  if (typeof rid !== "string" || !RID_RE.test(rid)) return null;
  const n = (a: number, b: number) => Number(rid.slice(a, b));
  const [y, mo, d, h, mi, s] = [n(0, 4), n(4, 6), n(6, 8), n(8, 10), n(10, 12), n(12, 14)];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d
    || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
  return dt;
}

/** RID (UTC) -> "2026-10-29 00:54:15" Tehran wall clock, or null. */
export function ridToTehran(rid: string): string | null {
  const dt = ridToDate(rid);
  if (!dt) return null;
  const t = new Date(dt.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, max) : null;
};

export type SiteRelease = {
  rid: string;
  commit: string | null;
  branch: string | null;
  description: string | null;
  rollback: string | null;
  notes: string | null;
  /** Release number when known from a fact (e.g. "55" from /root/site55); never invented. */
  releaseNo: string | null;
};

const RELNO_RE = /^\d{1,4}[a-z]?$/;
export const cleanReleaseNo = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return RELNO_RE.test(s) ? s : null;
};

export function normalizeSiteEntry(raw: unknown): { ok: true; entry: SiteRelease } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not_object" };
  const r = raw as Record<string, unknown>;
  const rid = typeof r.rid === "string" ? r.rid.trim() : "";
  if (!ridToDate(rid)) return { ok: false, error: "rid_invalid" };
  const commit = r.commit == null || r.commit === "" ? null : String(r.commit).trim().toLowerCase();
  if (commit !== null && !COMMIT_RE.test(commit)) return { ok: false, error: "commit_invalid" };
  const branch = r.branch == null || r.branch === "" ? null : String(r.branch).trim();
  if (branch !== null && !BRANCH_RE.test(branch)) return { ok: false, error: "branch_invalid" };
  return {
    ok: true,
    entry: {
      rid,
      commit,
      branch,
      description: cleanText(r.description, 200),
      rollback: cleanText(r.rollback, 500),
      notes: cleanText(r.notes, 300),
      releaseNo: cleanReleaseNo(r.releaseNo),
    },
  };
}

/** Validates a parsed registry document; invalid rows are dropped (counted), duplicates keep the first. Newest first. */
export function parseSiteRegistry(doc: unknown): { releases: SiteRelease[]; errors: string[] } {
  const list = doc && typeof doc === "object" && Array.isArray((doc as { releases?: unknown }).releases)
    ? (doc as { releases: unknown[] }).releases
    : null;
  if (!list) return { releases: [], errors: ["releases_missing"] };
  const errors: string[] = [];
  const seen = new Set<string>();
  const out: SiteRelease[] = [];
  list.forEach((raw, i) => {
    const n = normalizeSiteEntry(raw);
    if (!n.ok) { errors.push(`row ${i}: ${n.error}`); return; }
    if (seen.has(n.entry.rid)) { errors.push(`row ${i}: duplicate ${n.entry.rid}`); return; }
    seen.add(n.entry.rid);
    out.push(n.entry);
  });
  out.sort((a, b) => b.rid.localeCompare(a.rid));
  return { releases: out, errors };
}

export type CrmMetaEntry = { commit: string | null; branch: string | null; description: string | null; schemaChange: string | null; releaseNo: string | null };
export type CrmMeta = { schemaCutoff: string | null; cutoffSource: "explicit" | "derived" | "none"; releases: Record<string, CrmMetaEntry> };

/**
 * CRM release metadata. schemaCutoff = RID of the newest release that changed the DB schema.
 * An explicit `schemaCutoff` is used only when it is not older than the newest flagged
 * schemaChange (a stale value must never re-open older rollbacks). Unknown -> null, and the UI
 * then blocks every rollback.
 */
export function parseCrmMeta(doc: unknown): CrmMeta {
  const releases: Record<string, CrmMetaEntry> = {};
  let derived: string | null = null;
  const src = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const rows = src.releases && typeof src.releases === "object" && !Array.isArray(src.releases)
    ? (src.releases as Record<string, unknown>) : {};
  for (const [rid, raw] of Object.entries(rows)) {
    if (!ridToDate(rid) || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const commit = typeof r.commit === "string" && COMMIT_RE.test(r.commit.toLowerCase()) ? r.commit.toLowerCase() : null;
    const branch = typeof r.branch === "string" && BRANCH_RE.test(r.branch) ? r.branch : null;
    const schemaChange = cleanText(r.schemaChange, 200);
    releases[rid] = { commit, branch, description: cleanText(r.description, 200), schemaChange, releaseNo: cleanReleaseNo(r.releaseNo) };
    if (schemaChange && (!derived || rid > derived)) derived = rid;
  }
  const explicit = typeof src.schemaCutoff === "string" && ridToDate(src.schemaCutoff) ? src.schemaCutoff : null;
  if (explicit && (!derived || explicit >= derived)) return { schemaCutoff: explicit, cutoffSource: "explicit", releases };
  if (derived) return { schemaCutoff: derived, cutoffSource: "derived", releases };
  return { schemaCutoff: null, cutoffSource: "none", releases };
}

async function readJson(file: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return { ok: false, reason: "not_file" };
    if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, value: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : code === "EACCES" ? "no_access" : e instanceof SyntaxError ? "invalid_json" : "read_error" };
  }
}

export async function loadSiteReleases() {
  const r = await readJson(path.join(registryDir(), "site-releases.json"));
  if (!r.ok) return { available: false as const, reason: r.reason };
  const { releases, errors } = parseSiteRegistry(r.value);
  let current: string | null = null;
  try {
    current = path.basename(await fs.readlink(path.join(siteRoot(), "current")));
    if (!RID_RE.test(current)) current = null;
  } catch { current = null; }
  const rows = await Promise.all(releases.map(async (e) => {
    let onDisk: boolean | null = null;
    try { onDisk = (await fs.stat(path.join(siteRoot(), "releases", e.rid))).isDirectory(); }
    catch (err) { onDisk = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? false : null; }
    return { ...e, tehran: ridToTehran(e.rid), current: current === e.rid, onDisk };
  }));
  return { available: true as const, current, releases: rows, invalidRows: errors.length };
}

export async function loadCrmMeta() {
  const r = await readJson(path.join(registryDir(), "crm-releases-meta.json"));
  if (!r.ok) return { available: false as const, reason: r.reason, schemaCutoff: null, cutoffSource: "none" as const, releases: {} };
  return { available: true as const, ...parseCrmMeta(r.value) };
}
