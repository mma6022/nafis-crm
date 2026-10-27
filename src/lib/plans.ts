/**
 * Pure plan logic shared by SSR (hero facts, keyword pages) and islands (PlanFinder, wizard).
 * Algorithm follows UX-SPEC §6 as implemented in the designer's mockup
 * (/workspace/nafis-design/mockups/hero-finder-mobile.src.html):
 *   score = base 30 + payout band 40 (adjacent 20) + priority 30 (the base replaced the old «type» component:
 *   legal 2026-10-24, the customer is never asked cash/goods, so every eligible plan of every type competes);
 *   ranking is lexicographic [preset guarantee] > band > priority (priority relaxed first, then band);
 *   de-duplicated by plan name; always 1–3 cards, never "not found".
 */
import { qualifiesFor, type GuaranteePage, type GuaranteeType } from '../data/plan-guarantees';
import { monthlyInstallment, type LoanPlan } from './loan-plans';

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (v: string | number) => String(v).replace(/\d/g, (d) => FA[+d]!);
/** «حدود ۳۱۵ میلیون»: whole millions at 100M or more, one decimal below that (decimal mark «٫»). */
export const millionsFa = (v: number) => {
  const m = v / 1e6;
  const r = m >= 100 ? Math.round(m) : Math.round(m * 10) / 10;
  return fa(String(r).replace('.', '٫'));
};

/** «سهیل» → «طرح سهیل», tidies spacing in «ترنم ( بازنشسته ها )». */
export function cleanPlanName(n: string) {
  const s = n
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)\s*/g, ')')
    .replace('بازنشسته ها', 'بازنشسته‌ها')
    .replace(/\s+/g, ' ')
    .trim();
  return s.startsWith('طرح') ? s : `طرح ${s}`;
}

/* ---------------- facts (no hand-typed numbers anywhere) ---------------- */

/** Annuity installment (designer site.js `installment`): r = annual/100/12; r = 0 → P/n. */
export const installment = monthlyInstallment;

/**
 * Bank-count rule (PM-approved, designer site.js `normBank`/`bankSet`): split composite names on - | / ، , +,
 * ZWNJ → space, collapse spaces, drop a leading «بانک», dedupe. «بانک ملی» = «ملی».
 */
export const normBank = (b: string) =>
  b.replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim().replace(/^بانک\s+/, '');
export const splitBanks = (bankName: string) =>
  String(bankName || '')
    .split(/\s*[-–|/،,+]\s*/)
    .map(normBank)
    .filter(Boolean);
export const bankNames = (plans: LoanPlan[]) => new Set(plans.flatMap((p) => splitBanks(p.bankName)));

export function planFacts(plans: LoanPlan[]) {
  const terms = plans.flatMap((p) => p.installmentTerms.map((t) => t.installments));
  const has = plans.length > 0;
  /** مبلغ واریزی (payout) over the plan finder's default pool: every plan × term, retiree-only plans excluded
   *  (the finder adds them only for «بازنشسته هستم»). Same per-term payout (CRM export) as the finder. */
  const payouts = combos(plans)
    .filter((c) => !c.retirees)
    .map((c) => c.payout);
  const hasPay = payouts.length > 0;
  return {
    planCount: new Set(plans.map((p) => p.id)).size,
    goodsCount: plans.filter((p) => p.loanType === 'goods').length,
    cashCount: plans.filter((p) => p.loanType === 'score').length,
    bankCount: bankNames(plans).size,
    minTerm: has ? Math.min(...terms) : 0,
    maxTerm: has ? Math.max(...terms) : 0,
    hasFast: plans.some((p) => p.grantDays === 'under_7'),
    fastCount: plans.filter((p) => p.grantDays === 'under_7').length,
    onlineCount: plans.filter((p) => p.processMode === 'both' || p.processMode === 'online').length,
    /** «۶۰» / «۲۹۰» (مبلغ واریزی in million تومان, Persian digits; Mohammad 2026-10-28: never the principal) */
    minAmount: hasPay ? millionsFa(Math.min(...payouts)) : '',
    maxAmount: hasPay ? millionsFa(Math.max(...payouts)) : '',
    /** «از ۶۰ تا ۲۹۰ میلیون تومان» (مبلغ واریزی, same pool as the plan finder) */
    amountRange: hasPay ? `از ${millionsFa(Math.min(...payouts))} تا ${millionsFa(Math.max(...payouts))} میلیون تومان` : '',
    /** «مبلغ واریزی از ۶۰ تا ۲۹۰ میلیون تومان» (home hero; payout-based like the plan finder) */
    payoutRange: hasPay ? `مبلغ واریزی از ${millionsFa(Math.min(...payouts))} تا ${millionsFa(Math.max(...payouts))} میلیون تومان` : '',
    /** «بازپرداخت ۱۲ تا ۴۸ ماهه» */
    termRange: has ? `بازپرداخت ${fa(Math.min(...terms))} تا ${fa(Math.max(...terms))} ماهه` : '',
  };
}
export type PlanFacts = ReturnType<typeof planFacts>;

/* ---------------- combos (plan × term) ---------------- */

export type Guarantee = GuaranteeType;

export interface Combo {
  id: number;
  name: string;
  type: string;
  mode: string;
  days: string;
  bank: string;
  platform: string;
  term: number;
  payout: number;
  inst: number;
  guarantees?: Guarantee[];
  guaranteeOptions?: Guarantee[][];
  guaranteePages?: GuaranteePage[];
  /** offered only to retirees (finder/calculator show it only when «بازنشسته هستم» is on) */
  retirees?: boolean;
}

export function combos(plans: LoanPlan[]): Combo[] {
  return plans.flatMap((p) =>
    p.installmentTerms.map((t) => ({
      id: p.id,
      name: cleanPlanName(p.name),
      type: p.loanType,
      mode: p.processMode,
      days: p.grantDays,
      bank: p.bankName.replace(/\s+/g, ' ').trim(),
      platform: p.platformName.replace(/\s+/g, ' ').trim(),
      term: t.installments,
      payout: t.payout,
      inst: t.installment,
      guarantees: p.guaranteeTypes,
      guaranteeOptions: p.guaranteeOptions,
      guaranteePages: p.guaranteePages,
      retirees: !!p.retireesOnly,
    })),
  );
}

/** Highest-payout combo of a plan (designer `byId`), e.g. the hero sample card and blog mini cards. */
export const byId = (all: Combo[], id: number): Combo | undefined =>
  all.filter((c) => c.id === id).sort((a, b) => b.payout - a.payout)[0];

/** Home hero sample card: plan 19 at its best payout; if 19 is not in the live export (inactive), the first active
 *  plan in export order (retiree-only plans never: they are not in the finder's default pool). */
export const SAMPLE_PLAN_ID = 19;
export function heroSample(all: Combo[], id: number = SAMPLE_PLAN_ID): Combo | undefined {
  const own = byId(all, id);
  if (own) return own;
  const first = all.find((c) => !c.retirees) ?? all[0];
  return first ? byId(all, first.id) : undefined;
}

/**
 * /vam-fori cards from data: the plans reviewed in under 7 days (best payout first, ≤3). When there are fewer than
 * 3 of them, the remaining slots are «از سریع‌ترین‌ها»: the plans of the next-fastest grantDays bucket (DAYS_RANK),
 * best payout first, retiree-only plans excluded.
 */
export function fastPlanGroups(plans: LoanPlan[], max = 3) {
  const best = (ps: LoanPlan[]) =>
    [...new Set(ps.map((p) => p.id))]
      .map((id) => byId(combos(ps), id))
      .filter((c): c is Combo => !!c && !c.retirees)
      .sort((a, b) => b.payout - a.payout);
  const fast = best(plans.filter((p) => p.grantDays === 'under_7')).slice(0, max);
  const ranks = [...new Set(plans.filter((p) => p.grantDays !== 'under_7').map((p) => DAYS_RANK[p.grantDays] ?? 99))].sort((a, b) => a - b);
  const nextRank = ranks[0];
  const nextPlans = nextRank === undefined ? [] : plans.filter((p) => p.grantDays !== 'under_7' && (DAYS_RANK[p.grantDays] ?? 99) === nextRank);
  const rest = fast.length < max ? best(nextPlans).slice(0, max - fast.length) : [];
  return { fast, rest, restDays: rest[0] ? (DAYS_LABEL[rest[0].days] ?? '') : '' };
}

/* ---------------- /calculator ---------------- */

/**
 * /calculator results (UX-SPEC §7, ANSWERS-1 §9): 1–3 plans for band → term over EVERY eligible plan (no plan-type
 * filter: legal 2026-10-24). Rank: band match, then exact/nearest term, then lower installment, then smaller id; one
 * card per plan (its combo closest to the term).
 */
export function calcPicks(all: Combo[], band: FinderBand, term: number, max = 3, retired = false): Combo[] {
  const eligible = all.filter((c) => retired || !c.retirees);
  const list = eligible
    .slice()
    .sort(
      (x, y) =>
        Number(bandOf(y.payout) === band) - Number(bandOf(x.payout) === band) ||
        Math.abs(x.term - term) - Math.abs(y.term - term) ||
        x.inst - y.inst ||
        x.id - y.id,
    );
  const seen = new Set<number>();
  const out: Combo[] = [];
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- finder ---------------- */

export type FinderBand = 0 | 1 | 2;
export type FinderPrio = 'fast' | 'cheap' | 'online';
export interface FinderAnswers {
  band: FinderBand;
  prio: FinderPrio;
  /** «بازنشسته هستم»: retiree-only plans (21) are offered only then */
  retired?: boolean;
}
/** Keyword-page preset. A guarantee preset is a HARD filter (unknown guarantee = not qualifying, never relaxed). */
export interface FinderPreset {
  prio?: FinderPrio;
  /** e.g. «بدون ضامن» → page 'no-guarantor' (data/plan-guarantees.ts qualifiesFor) */
  guarantee?: { page: GuaranteePage; label: string };
}

export const FINDER_BANDS: FinderBand[] = [0, 1, 2];
export const FINDER_PRIOS: FinderPrio[] = ['fast', 'cheap', 'online'];

/** Payout bands: <100M, 100–200M, >200M. */
export const PAYOUT_EDGES = [100e6, 200e6] as const;
export const bandOf = (payout: number): FinderBand =>
  payout < PAYOUT_EDGES[0] ? 0 : payout <= PAYOUT_EDGES[1] ? 1 : 2;

export interface Pick extends Combo {
  score: number;
  /** false only when a page preset (guarantee) had to be relaxed for this card */
  presetOk: boolean;
}
export interface Recommendation {
  exact: boolean;
  cards: Pick[];
  /** a guarantee preset was requested, but plan data has no guarantee fields yet */
  presetUnknown: boolean;
}

export function recommend(all: Combo[], a: FinderAnswers, preset: FinderPreset = {}): Recommendation {
  const g = preset.guarantee;
  // retiree-only plans need «بازنشسته هستم»; a guarantee preset is a hard filter (never relaxed, unknown = out)
  all = all.filter((c) => (a.retired || !c.retirees) && (!g || comboQualifies(c, g.page)));
  if (!all.length) return { exact: false, cards: [], presetUnknown: false };
  const guaranteeOk = (_c: Combo) => true;
  // legal 2026-10-24: no plan-type question; every plan gets the same base (keeps the 100 = exact scale)
  const BASE = 30;
  const bandScore = (c: Combo) => {
    const d = Math.abs(bandOf(c.payout) - a.band);
    return d === 0 ? 40 : d === 1 ? 20 : 0;
  };
  const base = all.map((c) => {
    const t = BASE;
    const b = bandScore(c);
    return { ...c, t, b, g: guaranteeOk(c) ? 1 : 0, s: t + b };
  });
  const best = Math.max(...base.map((c) => c.s));
  const minInst = Math.min(...base.filter((c) => c.s === best).map((c) => c.inst));
  const prioOk = (c: Combo) =>
    // «بدون مراجعه حضوری» = processMode 'both' (ANSWERS-1 §4: the data has no fully-online flag)
    a.prio === 'fast' ? c.days === 'under_7' : a.prio === 'online' ? c.mode === 'both' : c.inst <= minInst * 1.2;
  const scored = base
    .map((c) => ({ ...c, p: prioOk(c) ? 30 : 0 }))
    .map((c) => ({ ...c, s: c.s + c.p }))
    .sort(
      (x, y) =>
        y.g - x.g ||
        y.t - x.t ||
        y.b - x.b ||
        y.p - x.p ||
        // ties (ANSWERS-1 §4): higher received amount, then lower installment, then smaller id (cheap: installment first)
        (a.prio === 'cheap' ? x.inst - y.inst || y.payout - x.payout : y.payout - x.payout || x.inst - y.inst) ||
        x.id - y.id ||
        x.term - y.term,
    );
  const seen = new Set<string>();
  const out: typeof scored = [];
  for (const c of scored) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
    if (out.length === 3) break;
  }
  const top = out[0]!;
  const keep = [top, ...out.slice(1).filter((c) => c.t === top.t && c.g === top.g && c.s >= Math.max(50, top.s - 30))];
  const toPick = (c: (typeof scored)[number]): Pick => {
    const rest: Partial<typeof c> = { ...c };
    delete rest.t;
    delete rest.b;
    delete rest.p;
    delete rest.g;
    delete rest.s;
    return { ...(rest as Omit<typeof c, 't' | 'b' | 'p' | 'g' | 's'>), score: c.s, presetOk: c.g === 1 };
  };
  return { exact: top.s === 100 && top.g === 1, cards: keep.map(toPick), presetUnknown: false };
}

/* ---------------- request wizard amount bands ---------------- */
/**
 * Bands = received amount (payout), designer site.js `reqBands`. The edges are a fixed scale; which bands show
 * (and the open top band) follow the plan data: a band is listed only when ≥1 plan pays out inside (lo, hi].
 * `key` ("0-100", "100-200", …, "1000-up") is sent to the CRM as `amountBand`.
 */
export const REQ_EDGES = [100e6, 200e6, 300e6, 500e6, 1000e6] as const;
export interface ReqBand {
  key: string;
  lo: number;
  hi: number;
  label: string;
  /** number of distinct plans in the band */
  n: number;
}
export function reqBands(list: Combo[]): ReqBand[] {
  const lab = (v: number) => fa(v / 1e6);
  const raw: [number, number][] = [
    [0, REQ_EDGES[0]],
    ...REQ_EDGES.slice(1).map((e, i): [number, number] => [REQ_EDGES[i]!, e]),
    [REQ_EDGES[REQ_EDGES.length - 1]!, Infinity],
  ];
  return raw
    .map(([lo, hi]) => {
      const ids = new Set(list.filter((c) => c.payout > lo && c.payout <= hi).map((c) => c.id));
      const label =
        lo === 0
          ? `تا ${lab(hi)} میلیون تومان`
          : hi === Infinity
            ? `بیش از ${lab(lo)} میلیون تومان`
            : `${lab(lo)} تا ${lab(hi)} میلیون تومان`;
      return { key: `${lo / 1e6}-${hi === Infinity ? 'up' : hi / 1e6}`, lo, hi, label, n: ids.size };
    })
    .filter((b) => b.n > 0);
}
/** Every key the wizard may send (CRM `AMOUNT_BANDS` accepts these + legacy keys + "unsure"). */
export const REQ_BAND_KEYS = ['0-100', '100-200', '200-300', '300-500', '500-1000', '1000-up'] as const;

/* ---------------- labels ---------------- */

/** Finder questions, copy and icons verbatim from the designer's site.js `Q`. */
export const FINDER_Q = {
  band: {
    title: 'حدوداً چقدر لازم دارید؟',
    step: 'حدود مبلغ',
    lbl: 'مبلغ',
    hint: 'منظور مبلغی است که به حسابتان واریز می‌شود.',
    opts: [
      { v: 0, icon: 's', title: 'کمتر از ۱۰۰ میلیون تومان', sub: '' },
      { v: 1, icon: 'm', title: '۱۰۰ تا ۲۰۰ میلیون تومان', sub: '' },
      { v: 2, icon: 'l', title: 'بیش از ۲۰۰ میلیون تومان', sub: '' },
    ],
  },
  prio: {
    title: 'کدام برایتان مهم‌تر است؟',
    step: 'اولویت شما',
    lbl: 'اولویت',
    hint: 'طرحی را بالاتر نشان می‌دهیم که این مورد را بهتر دارد.',
    opts: [
      { v: 'fast', icon: 'clock', title: 'زودتر برسد', sub: 'طرح‌هایی با بررسی کمتر از ۷ روز' },
      { v: 'cheap', icon: 'coins', title: 'قسط ماهانه کمتر', sub: 'فشار کمتر روی خرج ماهانه' },
      { v: 'online', icon: 'online', title: 'بدون مراجعه حضوری', sub: 'کارها آنلاین انجام شود' },
    ],
  },
} as const;

export const FINDER_LABEL = {
  band: ['کمتر از ۱۰۰ میلیون', '۱۰۰ تا ۲۰۰ میلیون', 'بیش از ۲۰۰ میلیون'],
  prio: { fast: 'زودتر برسد', cheap: 'قسط کمتر', online: 'بدون مراجعه حضوری' } as Record<FinderPrio, string>,
};
export const DAYS_LABEL: Record<string, string> = { under_7: 'کمتر از ۷ روز', '10_to_15': '۱۰ تا ۱۵ روز' };
/** Card «روش» label. Never «کاملاً آنلاین»: there is no data for it (ANSWERS-1 §4). */
export const MODE_LABEL: Record<string, string> = { both: 'آنلاین یا حضوری', in_person: 'حضوری', online: 'آنلاین' };

/* ---------------- content presets (MDX `<PlanFinder preset={{…}} />`, `<PlanCards filter="…" />`) ---------------- */

export type ContentPreset = { guarantee?: string; need?: string; priority?: string };
export const GUARANTEE_PRESETS: Record<string, NonNullable<FinderPreset['guarantee']>> = {
  'no-guarantor': { page: 'no-guarantor', label: 'بدون ضامن' },
  'no-cheque': { page: 'no-cheque', label: 'بدون چک' },
  cheque: { page: 'cheque', label: 'با چک' },
  promissory: { page: 'promissory', label: 'با سفته' },
};
/** A combo/plan meets a guarantee page's condition (data/plan-guarantees.ts). */
export const comboQualifies = (c: Combo, page: GuaranteePage) =>
  qualifiesFor({ id: c.id, grantDays: c.days, guaranteeOptions: c.guaranteeOptions, guaranteePages: c.guaranteePages }, page);
export const planQualifies = (p: LoanPlan, page: GuaranteePage) => qualifiesFor(p, page);
/** Plans of a guarantee page, in a stable order (id). */
export const guaranteePagePlans = (plans: LoanPlan[], page: GuaranteePage) =>
  plans.filter((p) => qualifiesFor(p, page)).sort((a, b) => a.id - b.id);
/** review-time order of the CRM's grantDays buckets (smaller = faster) */
export const DAYS_RANK: Record<string, number> = { under_7: 0, '10_to_15': 1 };
/**
 * «فوری بدون چک / بدون ضامن» (PM 2026-10-23; copy A2/A3 2026-10-28): never empty. The plans meeting the base
 * guarantee condition (no-cheque / no-guarantor), max 3, sorted by the real review-time data (grantDays, DAYS_RANK).
 * Page-restricted plans (17: «بسته به رتبه‌ی اعتباری») stay out of the fast sections.
 * - no-guarantor ties: highest مبلغ واریزی obtainable WITHOUT a guarantor (planNoGuarantorPayout), then id; a plan
 *   base name is never repeated (A3 note 1).
 * - no-cheque ties: CRM id (unchanged).
 * No time is promised on those sections.
 */
export const fastestGuaranteePlans = (plans: LoanPlan[], base: 'no-cheque' | 'no-guarantor', max = 3) => {
  const pool = guaranteePagePlans(plans, base).filter((p) => !p.guaranteePages || p.guaranteePages.includes(`fast-${base}`));
  const days = (p: LoanPlan) => DAYS_RANK[p.grantDays] ?? 9;
  if (base === 'no-cheque') return pool.slice().sort((a, b) => days(a) - days(b) || a.id - b.id).slice(0, max);
  const sorted = pool.slice().sort((a, b) => days(a) - days(b) || planNoGuarantorPayout(b) - planNoGuarantorPayout(a) || a.id - b.id);
  const used = new Set<string>();
  const out: LoanPlan[] = [];
  for (const p of sorted) {
    const n = planBaseName(p.name);
    if (used.has(n)) continue;
    used.add(n);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
};
/** Highest مبلغ واریزی of a plan over its terms (the same figure the cards show). */
export const planMaxPayout = (p: LoanPlan) => p.installmentTerms.reduce((m, t) => Math.max(m, t.payout), 0);
/**
 * Highest مبلغ واریزی obtainable WITHOUT a guarantor (PM 2026-10-23): when the no-guarantor way has a lower loan cap
 * (plans 3 and 9), the payout scales by that share (data/plan-guarantees.ts noGuarantorShare).
 */
export const planNoGuarantorPayout = (p: LoanPlan) => planMaxPayout(p) * (p.noGuarantorShare && p.noGuarantorShare > 0 ? Math.min(1, p.noGuarantorShare) : 1);
/** Name without its parenthetical note: «ترنم ( بازنشسته ها )» and «ترنم» are both «طرح ترنم». */
export const planBaseName = (n: string) =>
  cleanPlanName(n).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
/**
 * Plan-type order of the per-type fast section. The type is the CRM's `loan_plans.loan_type` (export `loanType`):
 * goods = وام خرید کالا, score = وام امتیازی (اعتبارسنجی). There is no bank-loan value in the CRM today; any other
 * value the CRM adds later (e.g. a بانکی type) becomes its own group after these, so it is picked up automatically.
 */
export const FAST_TYPE_ORDER = ['goods', 'score'];
/**
 * PM 2026-10-23 (after launch): «سریع‌ترین بدون ضامن» lists ONE plan per plan type (loanType), the one with the
 * highest مبلغ واریزی obtainable WITHOUT a guarantor (planNoGuarantorPayout: each plan's no-guarantor loan cap is
 * respected) among the plans meeting the base condition. Plan names never repeat across the section: when a
 * type's best plan has a name already shown, the next best of that type is taken. Ties: faster grantDays, then id.
 * Types in FAST_TYPE_ORDER first, then any other type by name; max 3. Page-restricted plans (17) are left out, as before.
 */
export function topPlanPerType(plans: LoanPlan[], base: 'no-cheque' | 'no-guarantor', max = 3): LoanPlan[] {
  // a plan restricted to some pages (17: «بسته به رتبه‌ی اعتباری», pages ['no-guarantor']) stays out of the fast section
  const pool = guaranteePagePlans(plans, base).filter((p) => !p.guaranteePages || p.guaranteePages.includes(`fast-${base}`));
  const rank = (t: string) => {
    const i = FAST_TYPE_ORDER.indexOf(t);
    return i < 0 ? FAST_TYPE_ORDER.length : i;
  };
  const types = [...new Set(pool.map((p) => p.loanType))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const payout = base === 'no-guarantor' ? planNoGuarantorPayout : planMaxPayout;
  const used = new Set<string>();
  const out: LoanPlan[] = [];
  for (const t of types) {
    const best = pool
      .filter((p) => p.loanType === t && !used.has(planBaseName(p.name)))
      .sort((a, b) => payout(b) - payout(a) || (DAYS_RANK[a.grantDays] ?? 9) - (DAYS_RANK[b.grantDays] ?? 9) || a.id - b.id)[0];
    if (!best) continue;
    used.add(planBaseName(best.name));
    out.push(best);
    if (out.length >= max) break;
  }
  return out;
}
/**
 * Maps the content team's preset vocabulary to the finder's. Unknown keys are ignored (never break a page).
 * `need` (cash/goods) is ignored since legal 2026-10-24: the finder never filters or pre-answers a plan type.
 */
export function toFinderPreset(p: ContentPreset = {}): FinderPreset {
  const out: FinderPreset = {};
  if (p.priority === 'fast' || p.priority === 'cheap' || p.priority === 'online') out.prio = p.priority;
  if (p.guarantee && GUARANTEE_PRESETS[p.guarantee]) out.guarantee = GUARANTEE_PRESETS[p.guarantee];
  return out;
}
/** Kept for callers: a guarantee preset is always backed now (data/plan-guarantees.ts), so it is returned as is. */
export const withoutUnbackedGuarantee = (p: FinderPreset | undefined, _all: Combo[]) => p;
/** `<PlanCards filter>` names → plan predicate. Guarantee names use the strict page rules. */
export function planFilter(name: string, plans: LoanPlan[]): ((p: LoanPlan) => boolean) | null {
  void plans;
  const g = { noGuarantor: 'no-guarantor', noCheque: 'no-cheque', cheque: 'cheque', promissory: 'promissory' }[name] as GuaranteePage | undefined;
  if (g) return (p) => qualifiesFor(p, g);
  if (name === 'goods') return (p) => p.loanType === 'goods';
  if (name === 'cash') return (p) => p.loanType === 'score';
  if (name === 'fast') return (p) => p.grantDays === 'under_7';
  // A1 /vam-ani/: plans that can run without an in-person visit (same rule as the finder's «بدون مراجعه حضوری»)
  if (name === 'online') return (p) => p.processMode === 'both' || p.processMode === 'online';
  return () => true;
}
/** One value for `<PlanFact>`; null when the plan/term is gone (caller keeps the snapshot text). */
export function planFactValue(plans: LoanPlan[], id: number, field: string, term?: number): string | null {
  const p = plans.find((x) => x.id === id);
  if (!p) return null;
  const t = term ? p.installmentTerms.find((x) => x.installments === term) : p.installmentTerms[0];
  if (!t) return null;
  switch (field) {
    case 'payout':
      return `${millionsFa(t.payout)} میلیون تومان`;
    case 'installment':
      return `${millionsFa(t.installment)} میلیون تومان`;
    case 'term':
      return `${fa(t.installments)} ماه`;
    case 'speed':
      return DAYS_LABEL[p.grantDays] ?? null;
    case 'mode':
      return MODE_LABEL[p.processMode] ?? null;
    default:
      return null;
  }
}
/** `{fast:singular|plural}` → singular when exactly one active plan is reviewed in under 7 days, else plural. */
export const pickFastWording = (s: string, f: PlanFacts) => s.replace(/\{fast:([^|{}]*)\|([^{}]*)\}/g, (_, one: string, many: string) => (f.fastCount === 1 ? one : many));
/** Replaces {planCount} {goodsCount} {cashCount} {bankCount} {fastCount} {onlineCount} {minTerm} {maxTerm} {minAmount} {maxAmount} {amountRange} {payoutRange} {termRange} (and `{fast:…|…}`) in frontmatter strings. */
export const fillFacts = (s: string, f: PlanFacts) =>
  pickFastWording(s, f).replace(/\{(planCount|goodsCount|cashCount|bankCount|fastCount|onlineCount|minTerm|maxTerm|minAmount|maxAmount|amountRange|payoutRange|termRange)\}/g, (_, k: keyof PlanFacts) =>
    typeof f[k] === 'number' ? fa(f[k] as number) : String(f[k]),
  );
/**
 * Landing hero lead (frontmatter `lead`): escapes HTML, `**x**` → <strong>, fact tokens → live-refreshable
 * `data-plan-count` spans, placeholder markers → `.ph` spans (kept verbatim so the strict marker check still sees them).
 */
export const leadHtml = (s: string, f: PlanFacts) =>
  pickFastWording(s, f)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\{(planCount|goodsCount|cashCount|bankCount|fastCount|minTerm|maxTerm|amountRange|payoutRange|termRange)\}/g, (t, k: string) => `<span data-plan-count="${k}">${fillFacts(t, f)}</span>`)
    .replace(/\[((?:تأیید|تایید) محمد|جای‌خالی)([^\]]*)\]/g, '<span class="ph">[$1$2]</span>');
export type AmountBand = (typeof REQ_BAND_KEYS)[number];
