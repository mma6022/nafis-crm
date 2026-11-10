/**
 * گزارش عملکرد فروش UI (Armita v1.0). DOM renderer used by the React page and local shots.
 * Class names and structure follow src/sp.css / HANDOFF.md. Numbers are live (no «نمونه» label).
 */
import type { SpCell, SpDelta, SpExpert, SpMe, SpReport, SpTeam } from './api';

export type SpView = 'overview' | 'range-custom' | 'expert' | 'ranks' | 'score' | 'team' | 'compare' | 'self' | 'trainee' | 'empty' | 'loading' | 'error';

export type SpUiState = {
  view: SpView;
  me: SpMe;
  report?: SpReport | null;
  period?: 'day' | 'week' | 'month' | 'custom';
  customFrom?: string;
  customTo?: string;
  rankMetric?: 'calls' | 'avgDuration' | 'duration' | 'score';
  expertId?: number | null;
  errorMessage?: string;
};

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const fd = (v: unknown) => String(v ?? '').replace(/[0-9]/g, (d) => FD[Number(d)]);

const I_UP = '<svg class="i" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 3v8M3.5 6.5 7 3l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I_DOWN = '<svg class="i" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11V3M3.5 7.5 7 11l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I_FLAT = '<svg class="i" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

export function formatDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return fd(h) + ' ساعت و ' + fd(m) + ' دقیقه';
  if (h) return fd(h) + ' ساعت';
  return fd(m) + ' دقیقه';
}
function formatValue(key: string, value: number, expert?: SpExpert): string {
  if (key === 'duration') return formatDuration(value);
  if (key === 'avgDuration') return fd(value) + ' دقیقه';
  if (key === 'ansPct') return fd(value) + '٪';
  if (key === 'wallet') return fd(value) + ' شارژ';
  if (key === 'filedOrAdvanced' && expert) return fd(value) + ' (ثبت‌شده ' + fd(expert.metrics.filed?.value ?? 0) + '، جلوبرده ' + fd(expert.metrics.advanced?.value ?? 0) + ')';
  return fd(value);
}

export const METRIC_COLS: Array<[string, string]> = [
  ['calls', 'تماس‌ها'], ['unique', 'شماره‌های یکتا'], ['duration', 'مدت کل'], ['avgDuration', 'میانگین مدت'],
  ['inbound', 'ورودی'], ['outbound', 'خروجی'], ['answered', 'جواب‌داده‌شده'], ['noAnswer', 'جواب‌نداده‌شده'],
  ['answeredInbound', 'ورودی جواب‌داده‌شده'], ['noAnswerInbound', 'ورودی جواب‌نداده‌شده'],
  ['filed', 'پروندهٔ ثبت‌شده'], ['advanced', 'پروندهٔ جلوبرده'], ['done', 'فروش موفق'], ['wallet', 'شارژ کیف پول'],
];

function deltaHtml(d: SpDelta | undefined, incomplete?: boolean): string {
  const inc = incomplete ? '<span class="sp-inc">داده‌ی ناقص</span>' : '';
  if (!d || d.kind === 'none') return `<span class="sp-d none">بدون دادهٔ بازهٔ قبل</span>${inc}`;
  if (d.kind === 'unit') {
    const up = d.pct > 0, k = up ? 'up' : (d.pct < 0 ? 'down' : 'flat');
    const sign = d.pct > 0 ? '+' : (d.pct < 0 ? '−' : '');
    const lab = d.pct > 0 ? 'افزایش' : (d.pct < 0 ? 'کاهش' : 'بدون تغییر');
    const ic = k === 'up' ? I_UP : k === 'down' ? I_DOWN : I_FLAT;
    return `<span class="sp-d ${k}">${ic} <span aria-hidden="true">${sign}${fd(Math.abs(d.pct))} واحد</span><span class="sr">${lab} ${fd(Math.abs(d.pct))} واحد نسبت به بازهٔ قبل</span></span>${inc}`;
  }
  if (d.kind === 'flat') return `<span class="sp-d flat">${I_FLAT} <span aria-hidden="true">۰٪</span><span class="sr">بدون تغییر نسبت به بازهٔ قبل</span></span>${inc}`;
  const sign = d.kind === 'up' ? '+' : '−';
  const lab = d.kind === 'up' ? 'افزایش' : 'کاهش';
  const ic = d.kind === 'up' ? I_UP : I_DOWN;
  return `<span class="sp-d ${d.kind}">${ic} <span aria-hidden="true">${sign}${fd(d.pct)}٪</span><span class="sr">${lab} ${fd(d.pct)} درصد نسبت به بازهٔ قبل</span></span>${inc}`;
}
const cell = (val: string, c?: SpCell) => `<div class="sp-cell"><span class="sp-val">${val}</span>${c ? deltaHtml(c.delta, c.incomplete) : ''}</div>`;

function hrefOf(st: SpUiState, patch: Partial<SpUiState>): string {
  const view = patch.view ?? st.view;
  const period = patch.period ?? st.period ?? 'day';
  const p = new URLSearchParams();
  if (period && period !== 'day') p.set('period', period);
  if (period === 'custom') {
    const fr = patch.customFrom ?? st.customFrom; const to = patch.customTo ?? st.customTo;
    if (fr) p.set('from', fr); if (to) p.set('to', to);
  }
  if (view === 'ranks' || view === 'score') p.set('view', view === 'score' ? 'score' : 'ranks');
  if (view === 'team' || view === 'compare') p.set('view', view);
  if ((patch.rankMetric ?? st.rankMetric) && view === 'ranks') p.set('metric', patch.rankMetric ?? st.rankMetric ?? 'calls');
  const expertId = patch.expertId !== undefined ? patch.expertId : (view === 'expert' ? st.expertId : null);
  if (view === 'expert' && expertId) return `/sales-performance/expert/${expertId}${p.toString() ? `?${p}` : ''}`;
  const s = p.toString();
  return `/sales-performance${s ? `?${s}` : ''}`;
}

function badges(p: SpExpert): string {
  return `${p.roleLabel ? `<span class="sp-badge ${p.role === 'p1' ? 'p1' : 'role'}">${p.roleLabel}</span>` : ''}${p.trainee ? '<span class="sp-badge tr">کارآموز</span>' : ''}`;
}
function scoreCell(p: SpExpert, labeled = false): string {
  const lab = labeled ? '<span class="sp-k">امتیاز عملکرد</span>' : '';
  return p.trainee
    ? `<div class="sp-cell">${lab}<span class="sp-val">—</span><span class="sp-d none">در رتبه‌بندی نیست</span></div>`
    : `<div class="sp-cell">${lab}<span class="sp-val">${fd(p.score ?? 0)} از ۱۰۰</span></div>`;
}

function filters(st: SpUiState, opts: { range: string; view: string; picker?: boolean }): string {
  const isSelf = st.view === 'self' || st.view === 'trainee' || st.me.access !== 'manager';
  const range = opts.range;
  const items: Array<[string, string, SpView, 'day' | 'week' | 'month' | 'custom']> = [
    ['today', 'امروز', 'overview', 'day'], ['week', 'این هفته', 'overview', 'week'],
    ['month', 'این ماه', 'overview', 'month'], ['custom', 'بازهٔ دلخواه', 'range-custom', 'custom'],
  ];
  const rangeChips = `<div class="sp-row" role="group" aria-label="بازه">${items.map(([id, lb, view, period]) =>
    `<a class="sp-chip" href="${hrefOf(st, { view: st.view === 'team' || st.view === 'ranks' || st.view === 'score' || st.view === 'compare' ? st.view : view, period })}" aria-pressed="${range === id ? 'true' : 'false'}">${lb}</a>`).join('')}</div>`;
  const views = isSelf ? '' : `<div class="sp-views" role="group" aria-label="نمای گزارش">${
    [['overview', 'کارشناسان', 'overview'], ['team', 'تیم‌ها', 'team'], ['ranks', 'رتبه‌بندی', 'ranks']].map(([sc, lb]) =>
      `<a class="sp-chip" href="${hrefOf(st, { view: sc as SpView, period: st.period })}" aria-pressed="${opts.view === sc || (opts.view === 'score' && sc === 'ranks') || (opts.view === 'compare' && sc === 'team') ? 'true' : 'false'}">${lb}</a>`).join('')
  }</div>`;
  const custom = range === 'custom';
  const customBox = custom ? `<div class="sp-custom">
    <div class="sp-field"><label for="sp-from">از</label><input class="inp" id="sp-from" data-sp-from type="date" value="${st.customFrom || st.report?.range.from || ''}"></div>
    <div class="sp-field"><label for="sp-to">تا</label><input class="inp" id="sp-to" data-sp-to type="date" value="${st.customTo || st.report?.range.to || ''}"></div>
    <button class="btn pri" type="button" data-sp-apply>اعمال بازه</button>
  </div>` : '';
  const pickerBtn = isSelf ? '' : `<div class="sp-row"><span class="sp-lab">فهرست</span>
    <a class="sp-pick" href="${hrefOf(st, { view: 'range-custom', period: 'custom' })}" aria-pressed="${opts.picker ? 'true' : 'false'}">همهٔ کارشناسان</a>
    <a class="sp-pick" href="${hrefOf(st, { view: 'team' })}" aria-pressed="${opts.view === 'team' || opts.view === 'compare' ? 'true' : 'false'}">همهٔ تیم‌ها</a>
  </div>`;
  const experts = st.report?.experts ?? [];
  const picker = opts.picker && !isSelf ? `<ul class="sp-picker" role="listbox" aria-label="انتخاب کارشناس">
    <li><a class="sp-ex" href="${hrefOf(st, { view: 'overview' })}" aria-pressed="true"><span class="sp-ex-id"><b>همهٔ کارشناسان</b></span></a></li>
    ${experts.map((p) => `<li><a class="sp-ex" href="${p.trainee ? hrefOf(st, { view: 'overview' }) : hrefOf(st, { view: 'expert', expertId: p.salespersonId })}"><span><b>${p.name}</b>${p.trainee ? ' <span class="sp-badge tr">کارآموز</span>' : ''}<small>${p.roleLabel || 'بدون نقش امتیاز'}${p.teamName ? '، ' + p.teamName : ''}</small></span></a></li>`).join('')}
  </ul>` : '';
  const cmp = st.report
    ? `<p class="sp-cmp">بازه: ${st.report.range.label}. نسبت به ${st.report.range.previousLabel}.</p>`
    : '';
  return `<div class="sp-filters">${views}${rangeChips}${customBox}${pickerBtn}${picker}${cmp}</div>`;
}

function tableRow(st: SpUiState, p: SpExpert): string {
  const name = p.trainee ? `<b>${p.name}</b>` : `<a class="sp-name" href="${hrefOf(st, { view: 'expert', expertId: p.salespersonId })}">${p.name}</a>`;
  return `<tr>
    <th class="sp-sticky"><div class="sp-who">${name}<span class="sp-meta">${[p.roleLabel, p.teamName].filter(Boolean).join('، ') || 'بدون تیم'}</span>${badges(p)}</div></th>
    <td>${scoreCell(p)}</td>
    ${METRIC_COLS.map(([id, ]) => `<td>${cell(formatValue(id, p.metrics[id]?.value ?? 0, p), p.metrics[id])}</td>`).join('')}
  </tr>`;
}
function deskTable(st: SpUiState, keys: SpExpert[]): string {
  return `<div class="sp-desk"><div class="sp-table-wrap" tabindex="0" role="region" aria-label="جدول عملکرد کارشناسان، اسکرول افقی در خود جدول">
    <table class="sp-table"><caption class="sr">شاخص‌های عملکرد کارشناسان</caption>
    <thead><tr><th class="sp-sticky">کارشناس</th><th>امتیاز عملکرد</th>${METRIC_COLS.map(([, lb]) => `<th>${lb}</th>`).join('')}</tr></thead>
    <tbody>${keys.map((p) => tableRow(st, p)).join('')}</tbody></table>
  </div></div>`;
}
function cardOf(st: SpUiState, p: SpExpert, isSelf: boolean): string {
  const btn = isSelf || p.trainee ? '' : `<div class="sp-row-acts"><a class="btn pri" href="${hrefOf(st, { view: 'expert', expertId: p.salespersonId })}">جزئیات ${p.name}</a></div>`;
  return `<article class="card sp-card${p.trainee ? ' muted' : ''}">
    <div class="sp-card-hd"><div class="sp-who"><h3>${p.name}</h3><span class="sp-meta">${[p.roleLabel, p.teamName].filter(Boolean).join('، ') || 'بدون تیم'}</span>${badges(p)}</div>${scoreCell(p, true)}</div>
    <div class="sp-grid">${METRIC_COLS.map(([id, lb]) => `<div class="sp-metric"><span class="sp-k">${lb}</span>${cell(formatValue(id, p.metrics[id]?.value ?? 0, p), p.metrics[id])}</div>`).join('')}</div>
    ${btn}
  </article>`;
}
function mobCards(st: SpUiState, keys: SpExpert[], isSelf: boolean): string {
  return `<div class="sp-mob"><div class="sp-cards">${keys.map((p) => cardOf(st, p, isSelf)).join('')}</div></div>`;
}
function head(title: string, sub?: string): string {
  return `<div class="sp-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`;
}
function breakdown(p: SpExpert, hideOthers: boolean): string {
  const rows = (p.breakdown || []).map((r) => {
    const val = formatValue(r.key, r.value, p);
    return `<tr><th scope="row">${r.label}</th><td class="sp-w">${fd(r.weight)}</td><td>${val}</td><td>${fd(Math.round(r.points))}</td></tr>`;
  }).join('');
  const note = hideOthers
    ? 'وزن هر شاخص و امتیاز شما در این بازه. بهترین همان نقش در همین بازه ۱۰۰ می‌گیرد.'
    : 'وزن هر شاخص و امتیاز این کارشناس. بهترین همان نقش در همین بازه ۱۰۰ می‌گیرد.';
  return `<section class="sp-block" aria-label="شکست امتیاز عملکرد">
    <h3 class="sp-sec-title">شکست امتیاز عملکرد</h3>
    <p class="sp-note-line">${note}</p>
    <div class="sp-break-wrap" tabindex="0" role="region" aria-label="جدول وزن و امتیاز">
      <table class="sp-break">
        <thead><tr><th>شاخص</th><th>وزن</th><th>مقدار</th><th>امتیاز</th></tr></thead>
        <tbody>${rows}<tr><th scope="row">جمع</th><td class="sp-w">${fd(100)}</td><td></td><td>${fd(p.score ?? 0)}</td></tr></tbody>
      </table>
    </div>
  </section>`;
}
function metricsGrid(p: SpExpert): string {
  const rial = p.walletRial ? `<div class="sp-metric"><span class="sp-k">مبلغ شارژ کیف پول</span><div class="sp-cell"><span class="sp-val">${fd(p.walletRial.toLocaleString('en-US'))} ریال</span></div></div>` : '';
  return `<section class="sp-block"><h3 class="sp-sec-title">شاخص‌ها</h3>
    <div class="sp-grid">${METRIC_COLS.map(([id, lb]) => `<div class="sp-metric"><span class="sp-k">${lb}</span>${cell(formatValue(id, p.metrics[id]?.value ?? 0, p), p.metrics[id])}</div>`).join('')}
      ${rial}
    </div>
  </section>`;
}

function rangeId(st: SpUiState): string {
  return (st.period ?? st.report?.period ?? 'day') === 'custom' ? 'custom' : (st.period ?? st.report?.period ?? 'day') === 'week' ? 'week' : (st.period ?? st.report?.period ?? 'day') === 'month' ? 'month' : 'today';
}

function viewOverview(st: SpUiState): string {
  const list = st.report?.experts ?? [];
  return `${head('گزارش عملکرد فروش', st.report?.range.label || '')}
    ${filters(st, { view: 'overview', range: rangeId(st) })}
    ${deskTable(st, list)}${mobCards(st, list, false)}`;
}
function viewRange(st: SpUiState): string {
  const list = st.report?.experts ?? [];
  return `${head('گزارش عملکرد فروش', 'بازهٔ دلخواه')}
    ${filters(st, { view: 'overview', range: 'custom', picker: true })}
    ${deskTable(st, list)}${mobCards(st, list, false)}`;
}
function viewExpert(st: SpUiState): string {
  const p = (st.report?.experts ?? []).find((e) => e.salespersonId === st.expertId) || st.report?.self;
  if (!p) return viewEmpty(st);
  return `${head('جزئیات عملکرد', p.name)}
    ${filters(st, { view: 'overview', range: rangeId(st) })}
    <div class="sp-you">
      <h3>امتیاز عملکرد</h3>
      <p class="sp-big">${p.trainee ? 'در رتبه‌بندی نیست' : `${fd(p.score ?? 0)} از ۱۰۰`}</p>
      ${p.trainee ? '<p>چون کارآموز است امتیاز عملکرد و رتبه محاسبه نمی‌شود.</p>' : `<p>رتبهٔ ${fd(p.rank ?? 0)} از ${fd(p.roleN ?? 0)} نفر در نقش ${p.roleLabel || ''}</p>`}
    </div>
    ${p.trainee ? '' : breakdown(p, false)}
    ${metricsGrid(p)}`;
}
function viewRanks(st: SpUiState): string {
  const metric = st.rankMetric ?? 'calls';
  const labels: Record<string, string> = { calls: 'تعداد تماس', avgDuration: 'میانگین مدت', duration: 'مدت کل', score: 'امتیاز عملکرد' };
  const people = (st.report?.experts ?? []).filter((p) => !p.trainee);
  const trainees = (st.report?.experts ?? []).filter((p) => p.trainee);
  const valOf = (p: SpExpert) => metric === 'score' ? (p.score ?? 0) : (p.metrics[metric]?.value ?? 0);
  const fmt = (p: SpExpert) => metric === 'score' ? fd(p.score ?? 0) + ' از ۱۰۰' : formatValue(metric, valOf(p), p);
  const sorted = [...people].sort((a, b) => valOf(b) - valOf(a) || a.salespersonId - b.salespersonId);
  // competition rank
  const ranks: number[] = [];
  let last: number | null = null, lastRank = 0;
  sorted.forEach((p, i) => {
    const v = valOf(p);
    if (last == null || v !== last) { lastRank = i + 1; last = v; }
    ranks.push(lastRank);
  });
  const tabs = `<div class="sp-tabs" role="tablist" aria-label="نوع رتبه‌بندی">
    ${(['calls', 'avgDuration', 'duration', 'score'] as const).map((k) =>
      `<a class="sp-tab" href="${hrefOf(st, { view: k === 'score' ? 'score' : 'ranks', rankMetric: k })}" aria-selected="${(metric === 'score' && k === 'score') || (st.view === 'ranks' && metric === k) ? 'true' : 'false'}">${labels[k]}</a>`).join('')}
  </div>`;
  if (st.view === 'score' || metric === 'score') {
    const first = people.filter((p) => p.role === 'first_call').sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const p1 = people.filter((p) => p.role === 'p1').sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const scoreList = (keys: SpExpert[]) => `<ol class="sp-rank">${keys.map((p) =>
      `<li><span class="sp-pos">${fd(p.rank ?? 0)}</span><div class="sp-who"><b>${p.name}</b><span class="sp-meta">${p.teamName || 'بدون تیم'}</span></div>${cell(fd(p.score ?? 0) + ' از ۱۰۰')}</li>`).join('')}</ol>`;
    return `${head('امتیاز عملکرد', 'رتبه در همان نقش و همان بازه')}
      ${filters(st, { view: 'ranks', range: rangeId(st) })}
      ${tabs}
      <p class="sp-note-line">بهترین همان نقش در این بازه ۱۰۰ می‌گیرد. کارآموزان در رتبه‌بندی نیستند.</p>
      <section class="sp-block card" style="padding:16px 20px"><h3 class="sp-sec-title">نقش تماس اول</h3>${scoreList(first)}</section>
      <section class="sp-block card" style="padding:16px 20px"><h3 class="sp-sec-title">نقش اولویت ۱</h3>${scoreList(p1)}</section>
      <section class="sp-block sp-muted card" style="padding:16px 20px">
        <h3 class="sp-sec-title">کارآموزان، در رتبه‌بندی نیستند</h3>
        <ul class="sp-rank">${trainees.map((p) => `<li><span class="sp-badge tr">کارآموز</span><div class="sp-who"><b>${p.name}</b><span class="sp-meta">چون کارآموز است امتیاز و رتبه ندارد</span></div><span class="sp-d none">بدون امتیاز</span></li>`).join('')}</ul>
      </section>`;
  }
  return `${head('رتبه‌بندی', `${labels[metric]}، به‌جز کارآموزان`)}
    ${filters(st, { view: 'ranks', range: rangeId(st) })}
    ${tabs}
    <p class="sp-note-line">در تساوی، رتبه مشترک است و نفر بعدی با جهش می‌آید.</p>
    <section class="sp-block card" style="padding:16px 20px">
      <h3 class="sp-sec-title">${labels[metric]}</h3>
      <ol class="sp-rank">${sorted.map((p, i) => `<li><span class="sp-pos">${fd(ranks[i])}</span><div class="sp-who"><b>${p.name}</b><span class="sp-meta">${[p.roleLabel, p.teamName].filter(Boolean).join('، ')}</span></div>${cell(fmt(p), p.metrics[metric])}</li>`).join('')}</ol>
    </section>
    <section class="sp-block sp-muted card" style="padding:16px 20px">
      <h3 class="sp-sec-title">کارآموزان، در رتبه‌بندی نیستند</h3>
      <ul class="sp-rank">${trainees.map((p) => `<li><span class="sp-badge tr">کارآموز</span><div class="sp-who"><b>${p.name}</b><span class="sp-meta">چون کارآموز است در رتبه‌بندی نمی‌آید</span></div>${cell(formatValue(metric, p.metrics[metric]?.value ?? 0, p), p.metrics[metric])}</li>`).join('')}</ul>
    </section>`;
}
function teamCard(t: SpTeam): string {
  return `<article class="card sp-card">
    <div class="sp-card-hd"><div><h3>${t.name}</h3><p class="sp-meta">${t.members.map((m) => m.name).join('، ')}</p></div></div>
    <div class="sp-grid">${METRIC_COLS.map(([id, lb]) => `<div class="sp-metric"><span class="sp-k">${lb}</span>${cell(formatValue(id, t.metrics[id]?.value ?? 0), t.metrics[id])}</div>`).join('')}</div>
  </article>`;
}
function viewTeam(st: SpUiState): string {
  const teams = st.report?.teams ?? [];
  return `${head('گزارش تیم‌ها', st.report?.range.label || '')}
    ${filters(st, { view: 'team', range: rangeId(st) })}
    <p class="sp-note-line">امتیاز عملکرد برای تیم محاسبه نمی‌شود؛ امتیاز فقط برای کارشناس در همان نقش است.</p>
    <div class="sp-cards">${teams.map(teamCard).join('')}</div>
    <p class="sp-row-acts" style="margin-top:16px"><a class="btn gh" href="${hrefOf(st, { view: 'compare' })}">مقایسهٔ تیم‌ها</a></p>`;
}
function viewCompare(st: SpUiState): string {
  const teams = st.report?.teams ?? [];
  const a = teams[0], b = teams[1];
  const rows = METRIC_COLS.map(([id, lb]) => `<div class="sp-cmp-row"><div class="sp-cmp-k">${lb}</div>
    <div>${a ? cell(formatValue(id, a.metrics[id]?.value ?? 0), a.metrics[id]) : '—'}</div>
    <div>${b ? cell(formatValue(id, b.metrics[id]?.value ?? 0), b.metrics[id]) : '—'}</div></div>`).join('');
  return `${head('مقایسهٔ تیم‌ها', st.report?.range.label || '')}
    ${filters(st, { view: 'team', range: rangeId(st) })}
    <section class="card" style="padding:16px 20px">
      <div class="sp-cmp-row"><div class="sp-cmp-k"></div><div><b>${a?.name || ''}</b></div><div><b>${b?.name || ''}</b></div></div>
      ${rows}
    </section>`;
}
function viewSelf(st: SpUiState): string {
  const p = st.report?.self;
  if (!p) return viewEmpty(st);
  if (p.trainee) return viewTrainee(st);
  return `${head('گزارش عملکرد شما', st.report?.range.label || '')}
    ${filters(st, { range: rangeId(st), view: 'self' })}
    <div class="sp-you">
      <h3>امتیاز عملکرد</h3>
      <p class="sp-big">${fd(p.score ?? 0)} از ۱۰۰</p>
      <p>رتبه‌ی شما: ${fd(p.rank ?? 0)} از ${fd(p.roleN ?? 0)} نفر</p>
      <p>نقش ${p.roleLabel || ''}</p>
    </div>
    ${breakdown(p, true)}
    ${metricsGrid(p)}`;
}
function viewTrainee(st: SpUiState): string {
  const p = st.report?.self;
  if (!p) return viewEmpty(st);
  return `${head('گزارش عملکرد شما', st.report?.range.label || '')}
    ${filters(st, { range: rangeId(st), view: 'trainee' })}
    <div class="sp-you tr">
      <h3>وضعیت رتبه‌بندی</h3>
      <p class="sp-big">در رتبه‌بندی نیستید</p>
      <p>چون کارآموز هستید، امتیاز عملکرد و رتبه برای شما محاسبه نمی‌شود.</p>
    </div>
    ${metricsGrid(p)}`;
}
function viewEmpty(st: SpUiState): string {
  return `${head('گزارش عملکرد فروش', 'بازهٔ دلخواه')}
    ${filters(st, { range: 'custom', view: 'overview' })}
    <section class="card sp-empty"><h2>در این بازه داده‌ای نیست</h2><p>برای بازهٔ انتخاب‌شده گزارشی نیامد.</p></section>`;
}
function viewLoading(st: SpUiState): string {
  return `${head('گزارش عملکرد فروش', st.report?.range.label || '')}
    ${filters(st, { range: rangeId(st), view: 'overview' })}
    <div class="sp-skel" role="status" aria-live="polite"><span class="sr">در حال بارگذاری</span><i></i><i></i><i></i></div>`;
}
function viewError(st: SpUiState): string {
  return `${head('گزارش عملکرد فروش', '')}
    <section class="card sp-state" role="alert"><h2>گزارش عملکرد الآن نیامد</h2><p>چیزی عوض نشد.</p><a class="btn pri" href="${hrefOf(st, { view: 'overview' })}" data-sp-retry>تلاش دوباره</a></section>`;
}

function isEmptyReport(r: SpReport | null | undefined): boolean {
  if (!r) return true;
  if (r.self) return false;
  const ex = r.experts ?? [];
  return ex.every((p) => METRIC_COLS.every(([id]) => (p.metrics[id]?.value ?? 0) === 0) && !p.score);
}

export function renderSalesPerformance(st: SpUiState): string {
  const view = st.view;
  if (view === 'loading') return viewLoading(st);
  if (view === 'error') return viewError(st);
  if (view === 'empty' || (st.report && isEmptyReport(st.report) && view !== 'self' && view !== 'trainee')) return viewEmpty(st);
  if (view === 'range-custom') return viewRange(st);
  if (view === 'expert') return viewExpert(st);
  if (view === 'ranks' || view === 'score') return viewRanks(st);
  if (view === 'team') return viewTeam(st);
  if (view === 'compare') return viewCompare(st);
  if (view === 'trainee' || (view === 'self' && st.report?.self?.trainee) || st.me.access === 'trainee') return viewTrainee(st);
  if (view === 'self' || st.me.access === 'expert') return viewSelf(st);
  return viewOverview(st);
}

export type MountHandles = { destroy: () => void };
export function mountSalesPerformance(root: HTMLElement, st: SpUiState, on?: { applyRange?: (from: string, to: string) => void; retry?: () => void }): MountHandles {
  root.innerHTML = `<div class="sp-page">${renderSalesPerformance(st)}</div>`;
  const apply = root.querySelector('[data-sp-apply]');
  const onApply = () => {
    const fr = (root.querySelector('[data-sp-from]') as HTMLInputElement | null)?.value;
    const to = (root.querySelector('[data-sp-to]') as HTMLInputElement | null)?.value;
    if (fr && to) on?.applyRange?.(fr, to);
  };
  apply?.addEventListener('click', onApply);
  const retry = root.querySelector('[data-sp-retry]');
  const onRetry = (e: Event) => { e.preventDefault(); on?.retry?.(); };
  retry?.addEventListener('click', onRetry);
  return {
    destroy() {
      apply?.removeEventListener('click', onApply);
      retry?.removeEventListener('click', onRetry);
      root.innerHTML = '';
    },
  };
}
