/**
 * REFERENCE ONLY (tests): the pure logic of the designer's mockup runtime, copied verbatim from
 * /workspace/nafis-design/mockups/src/site.js (phase 2, PM-approved), lines 5–31 and 48–61, wrapped so that
 * PLANS is a parameter. DOM/QS code is left out. Do not edit except to re-sync with the designer's file.
 */
export function designer(PLANS) {
const fa = s => String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const millions = v => { const m = v / 1e6; const r = m >= 100 ? Math.round(m) : Math.round(m * 10) / 10; return fa(String(r).replace('.', '٫')); };
const installment = (P, annual, n) => { const r = annual / 100 / 12; return r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n)); };
const cleanName = n => { n = n.replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')').replace('بازنشسته ها', 'بازنشسته‌ها').trim(); return n.startsWith('طرح') ? n : 'طرح ' + n; };
const BAND_EDGES = [100e6, 200e6];
// Request-wizard amount bands (received amount). Edges are a fixed scale; which bands show, and the open top band,
// are computed from plan data: empty bands auto-hide.
const REQ_EDGES = [100e6, 200e6, 300e6, 500e6, 1000e6];
function reqBands(list = combos) {
  const lab = v => fa(v / 1e6);
  const raw = [[0, REQ_EDGES[0]], ...REQ_EDGES.slice(1).map((e, i) => [REQ_EDGES[i], e]), [REQ_EDGES[REQ_EDGES.length - 1], Infinity]];
  return raw.map(([lo, hi]) => {
    const ids = new Set(list.filter(c => c.payout > lo && c.payout <= hi).map(c => c.id));
    const label = lo === 0 ? `تا ${lab(hi)} میلیون تومان` : hi === Infinity ? `بیش از ${lab(lo)} میلیون تومان` : `${lab(lo)} تا ${lab(hi)} میلیون تومان`;
    return { key: `${lo / 1e6}-${hi === Infinity ? 'up' : hi / 1e6}`, lo, hi, label, n: ids.size };
  }).filter(b => b.n > 0);
}
const bandOf = v => v < BAND_EDGES[0] ? 0 : v <= BAND_EDGES[1] ? 1 : 2;
const combos = PLANS.flatMap(p => p.installmentTerms.map(t => ({
  id: p.id, name: cleanName(p.name), type: p.loanType, mode: p.processMode, days: p.grantDays,
  bank: p.bankName.replace(/\s+/g, ' ').trim(), platform: p.platformName, principal: p.principalAmount, rate: p.annualInterest,
  term: t.installments, prepay: t.prepaymentPercent, payout: p.principalAmount * t.depositPercent / 100,
  inst: installment(p.principalAmount, p.annualInterest, t.installments)
})));
// Bank count (PM-approved rule): split composite names on - | / ، + , drop a leading «بانک», collapse spaces/ZWNJ, dedupe.
const normBank = b => b.replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim().replace(/^بانک\s+/, '');
const bankSet = new Set(PLANS.flatMap(p => String(p.bankName || '').split(/\s*[-|/،,+]\s*/).map(normBank).filter(Boolean)));
// ----- recommend (UX-SPEC §6) -----
function recommend(a) {
  const typeOk = c => a.type === 'any' || (a.type === 'cash' ? c.type === 'score' : c.type === 'goods');
  const bandScore = c => { const d = Math.abs(bandOf(c.payout) - a.band); return d === 0 ? 40 : d === 1 ? 20 : 0; };
  const base = combos.map(c => ({ ...c, t: typeOk(c) ? 30 : 0, b: bandScore(c), s: (typeOk(c) ? 30 : 0) + bandScore(c) }));
  const best = Math.max(...base.map(c => c.s));
  const minInst = Math.min(...base.filter(c => c.s === best).map(c => c.inst));
  const prioOk = c => a.prio === 'fast' ? c.days === 'under_7' : a.prio === 'online' ? c.mode === 'both' : c.inst <= minInst * 1.2;
  const scored = base.map(c => ({ ...c, p: prioOk(c) ? 30 : 0, s: c.s + (prioOk(c) ? 30 : 0) }))
    .sort((x, y) => y.t - x.t || y.b - x.b || y.p - x.p || (a.prio === 'cheap' ? x.inst - y.inst : y.payout - x.payout));
  const seen = new Set(), out = [];
  for (const c of scored) { if (seen.has(c.name)) continue; seen.add(c.name); out.push(c); if (out.length === 3) break; }
  const top = out[0];
  return { exact: top.s === 100, cards: [top, ...out.slice(1).filter(c => c.t === top.t && c.s >= Math.max(50, top.s - 30))] };
}
  return { fa, millions, installment, cleanName, reqBands, bandOf, combos, normBank, bankSet, recommend };
}
