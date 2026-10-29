// Shared by refresh-plans.mjs (prebuild) and check-plans-live.mjs (build guard): fetch + validate the CRM's live
// public plan export. The export lists ONLY the plans that are active in the CRM, so its length is the live active count.
// Any failure (network, HTTP status, not JSON, wrong shape) throws — the build must stop rather than ship stale counts.
export const EXPORT_URL = process.env.PLANS_EXPORT_URL || 'https://nafisvam.com/data/loan-plans.json';

export function validateExport(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('export is not a non-empty array');
  const ids = new Set();
  for (const p of data) {
    if (!p || typeof p !== 'object') throw new Error('export item is not an object');
    if (!Number.isInteger(p.id) || p.id <= 0) throw new Error(`bad plan id ${JSON.stringify(p.id)}`);
    if (ids.has(p.id)) throw new Error(`duplicate plan id ${p.id}`);
    ids.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`plan ${p.id}: missing name`);
    if (!Array.isArray(p.installmentTerms)) throw new Error(`plan ${p.id}: installmentTerms is not an array`);
  }
  return data;
}

export async function fetchExport({ attempts = 3, timeoutMs = 15000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      return { data: validateExport(JSON.parse(text)), lastModified: r.headers.get('last-modified') };
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
  throw new Error(`live plan export unavailable (${EXPORT_URL}): ${last?.message || last}`);
}

export const idsOf = (data) => data.map((p) => p.id).sort((a, b) => a - b);
