#!/usr/bin/env node
// Prebuild: refresh src/data/loan-plans.snapshot.json from the CRM's live public export, so the prerendered HTML
// (what crawlers and no-JS visitors see) carries the live plans and counts. Fails (exit 1) when the export is
// unavailable or malformed — the build stops; the old snapshot is left untouched.
// Writes src/data/loan-plans.snapshot.meta.json (source, fetchedAt, count, ids, sha256) for the tests and guard.
// Run: node scripts/refresh-plans.mjs   (PLANS_EXPORT_URL overrides the source)
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EXPORT_URL, fetchExport, idsOf } from './plans-export.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const SNAP = join(ROOT, 'src/data/loan-plans.snapshot.json');
const META = join(ROOT, 'src/data/loan-plans.snapshot.meta.json');

try {
  const { data, lastModified } = await fetchExport();
  const body = JSON.stringify(data) + '\n';
  const before = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : [];
  const ids = idsOf(data);
  const meta = {
    source: EXPORT_URL,
    fetchedAt: new Date().toISOString(),
    exportLastModified: lastModified,
    count: data.length,
    ids,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const prevMeta = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : null;
  if (prevMeta?.sha256 === meta.sha256 && existsSync(SNAP) && readFileSync(SNAP, 'utf8') === body) {
    console.log(`refresh-plans: ${data.length} live plans [${ids.join(',')}] — identical to the snapshot (fetched ${prevMeta.fetchedAt}), nothing written`);
    process.exit(0);
  }
  writeFileSync(SNAP + '.tmp', body);
  renameSync(SNAP + '.tmp', SNAP);
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
  const old = idsOf(before);
  const gone = old.filter((i) => !ids.includes(i));
  const added = ids.filter((i) => !old.includes(i));
  console.log(`refresh-plans: ${data.length} live plans [${ids.join(',')}]` + (gone.length || added.length ? ` (was ${old.length}; removed ${gone.join(',') || '-'}; added ${added.join(',') || '-'})` : ' (ids unchanged)'));
} catch (e) {
  console.error(`refresh-plans: FAILED — ${e.message}. Build stopped; snapshot not changed.`);
  process.exit(1);
}
