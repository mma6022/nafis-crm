/**
 * Pure plan logic shared by SSR (hero facts, keyword pages) and islands (PlanFinder, wizard).
 * Algorithm follows UX-SPEC §6 as implemented in the designer's mockup
 * (/workspace/nafis-design/mockups/hero-finder-mobile.src.html):
 *   score = type 30 + payout band 40 (adjacent 20) + priority 30;
 *   ranking is lexicographic [preset guarantee] > type > band > priority, which equals the spec's relaxation
 *   order (priority dropped first, then band, then type; a page preset last);
 *   de-duplicated by plan name; always 1–3 cards, never "not found".
 */
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
  const principals = plans.map((p) => p.principalAmount);
  const terms = plans.flatMap((p) => p.installmentTerms.map((t) => t.installments));
  const has = plans.length > 0;
  return {
    planCount: new Set(plans.map((p) => p.id)).size,
    goodsCount: plans.filter((p) => p.loanType === 'goods').length,
    cashCount: plans.filter((p) => p.loanType === 'score').length,
    bankCount: bankNames(plans).size,
    minPrincipal: has ? Math.min(...principals) : 0,
    maxPrincipal: has ? Math.max(...principals) : 0,
    minTerm: has ? Math.min(...terms) : 0,
    maxTerm: has ? Math.max(...terms) : 0,
    hasFast: plans.some((p) => p.grantDays === 'under_7'),
    fastCount: plans.filter((p) => p.grantDays === 'under_7').length,
    onlineCount: plans.filter((p) => p.processMode === 'both' || p.processMode === 'online').length,
    /** «از ۱۰۰ تا ۷۰۰ میلیون تومان» (nominal principal) */
    amountRange: has ? `از ${millionsFa(Math.min(...principals))} تا ${millionsFa(Math.max(...principals))} میلیون تومان` : '',
    /** «بازپرداخت ۱۲ تا ۴۸ ماهه» */
    termRange: has ? `بازپرداخت ${fa(Math.min(...terms))} تا ${fa(Math.max(...terms))} ماهه` : '',
  };
}
export type PlanFacts = ReturnType<typeof planFacts>;

/* ---------------- combos (plan × term) ---------------- */

export type Guarantee = 'cheque' | 'digital_cheque' | 'guarantor' | 'promissory' | 'none';

export interface Combo {
  id: number;
  name: string;
  type: string;
  mode: string;
  days: string;
  bank: string;
  platform: string;
  principal: number;
  rate: number;
  term: number;
  prepay: number;
  payout: number;
  inst: number;
  guarantees?: Guarantee[];
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
      principal: p.principalAmount,
      rate: p.annualInterest,
      term: t.installments,
      prepay: t.prepaymentPercent,
      payout: (p.principalAmount * t.depositPercent) / 100,
      inst: monthlyInstallment(p.principalAmount, p.annualInterest, t.installments),
      guarantees: p.guaranteeTypes,
    })),
  );
}

/** Highest-payout combo of a plan (designer `byId`), e.g. the hero sample card and blog mini cards. */
export const byId = (all: Combo[], id: number): Combo | undefined =>
  all.filter((c) => c.id === id).sort((a, b) => b.payout - a.payout)[0];

/* ---------------- finder ---------------- */

export type FinderType = 'cash' | 'goods' | 'any';
export type FinderBand = 0 | 1 | 2;
export type FinderPrio = 'fast' | 'cheap' | 'online';
export interface FinderAnswers {
  type: FinderType;
  band: FinderBand;
  prio: FinderPrio;
}
/** Keyword-page preset. Guarantee presets only bite once the CRM export carries guaranteeTypes. */
export interface FinderPreset {
  type?: FinderType;
  prio?: FinderPrio;
  /** e.g. «بدون ضامن» → exclude 'guarantor'; «با سفته» → require 'promissory' */
  guarantee?: { require?: Guarantee[]; exclude?: Guarantee[]; label: string };
}

export const FINDER_TYPES: FinderType[] = ['cash', 'goods', 'any'];
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
  if (!all.length) return { exact: false, cards: [], presetUnknown: false };
  const g = preset.guarantee;
  const hasGuaranteeData = all.some((c) => Array.isArray(c.guarantees));
  const guaranteeOk = (c: Combo) => {
    if (!g || !hasGuaranteeData) return true;
    const list = c.guarantees ?? [];
    if (g.require?.length && !g.require.some((x) => list.includes(x))) return false;
    if (g.exclude?.length && g.exclude.some((x) => list.includes(x))) return false;
    return true;
  };
  const typeOk = (c: Combo) => a.type === 'any' || (a.type === 'cash' ? c.type === 'score' : c.type === 'goods');
  const bandScore = (c: Combo) => {
    const d = Math.abs(bandOf(c.payout) - a.band);
    return d === 0 ? 40 : d === 1 ? 20 : 0;
  };
  const base = all.map((c) => {
    const t = typeOk(c) ? 30 : 0;
    const b = bandScore(c);
    return { ...c, t, b, g: guaranteeOk(c) ? 1 : 0, s: t + b };
  });
  const best = Math.max(...base.map((c) => c.s));
  const minInst = Math.min(...base.filter((c) => c.s === best).map((c) => c.inst));
  const prioOk = (c: Combo) =>
    a.prio === 'fast' ? c.days === 'under_7' : a.prio === 'online' ? c.mode === 'both' || c.mode === 'online' : c.inst <= minInst * 1.2;
  const scored = base
    .map((c) => ({ ...c, p: prioOk(c) ? 30 : 0 }))
    .map((c) => ({ ...c, s: c.s + c.p }))
    .sort(
      (x, y) =>
        y.g - x.g ||
        y.t - x.t ||
        y.b - x.b ||
        y.p - x.p ||
        (a.prio === 'cheap' ? x.inst - y.inst : y.payout - x.payout) ||
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
  return { exact: top.s === 100 && top.g === 1, cards: keep.map(toPick), presetUnknown: !!g && !hasGuaranteeData };
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
  type: {
    title: 'وام را برای چه می‌خواهید؟',
    step: 'هدف وام',
    lbl: 'هدف',
    hint: 'یکی را انتخاب کنید؛ بعداً هم می‌توانید عوضش کنید.',
    opts: [
      { v: 'cash', icon: 'cash', title: 'پول نقد', sub: 'وام نقدی بر پایه اعتبارسنجی' },
      { v: 'goods', icon: 'cart', title: 'خرید کالا قسطی', sub: 'کالا را می‌گیرید و قسطی پرداخت می‌کنید' },
      { v: 'any', icon: 'both', title: 'فرقی نمی‌کند', sub: 'هر دو را به من نشان بده' },
    ],
  },
  band: {
    title: 'حدوداً چقدر لازم دارید؟',
    step: 'حدود مبلغ',
    lbl: 'مبلغ',
    hint: 'منظور مبلغی است که به دست شما می‌رسد، نه مبلغ اسمی وام.',
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
  type: { cash: 'پول نقد', goods: 'خرید کالا قسطی', any: 'نقد یا کالا' } as Record<FinderType, string>,
  band: ['کمتر از ۱۰۰ میلیون', '۱۰۰ تا ۲۰۰ میلیون', 'بیش از ۲۰۰ میلیون'],
  prio: { fast: 'زودتر برسد', cheap: 'قسط کمتر', online: 'بدون مراجعه حضوری' } as Record<FinderPrio, string>,
};
export const DAYS_LABEL: Record<string, string> = { under_7: 'کمتر از ۷ روز', '10_to_15': '۱۰ تا ۱۵ روز' };
export const MODE_LABEL: Record<string, string> = { both: 'آنلاین یا حضوری', in_person: 'حضوری', online: 'آنلاین' };
export const TYPE_LABEL: Record<string, string> = { goods: 'خرید کالا قسطی', score: 'وام نقدی' };

/* ---------------- content presets (MDX `<PlanFinder preset={{…}} />`, `<PlanCards filter="…" />`) ---------------- */

export type ContentPreset = { guarantee?: string; need?: string; priority?: string };
export const GUARANTEE_PRESETS: Record<string, NonNullable<FinderPreset['guarantee']>> = {
  'no-guarantor': { exclude: ['guarantor'], label: 'بدون ضامن' },
  'no-cheque': { exclude: ['cheque', 'digital_cheque'], label: 'بدون چک' },
  cheque: { require: ['cheque', 'digital_cheque'], label: 'با چک' },
  promissory: { require: ['promissory'], label: 'با سفته' },
};
/** Maps the content team's preset vocabulary to the finder's. Unknown keys are ignored (never break a page). */
export function toFinderPreset(p: ContentPreset = {}): FinderPreset {
  const out: FinderPreset = {};
  if (p.need === 'goods' || p.need === 'cash') out.type = p.need;
  if (p.priority === 'fast' || p.priority === 'cheap' || p.priority === 'online') out.prio = p.priority;
  if (p.guarantee && GUARANTEE_PRESETS[p.guarantee]) out.guarantee = GUARANTEE_PRESETS[p.guarantee];
  return out;
}
/** `<PlanCards filter>` names → plan predicate; `null` = the data can't answer yet (guarantee fields missing). */
export function planFilter(name: string, plans: LoanPlan[]): ((p: LoanPlan) => boolean) | null {
  const g = { noGuarantor: 'no-guarantor', noCheque: 'no-cheque', cheque: 'cheque', promissory: 'promissory' }[name];
  if (g) {
    if (!plans.some((p) => Array.isArray(p.guaranteeTypes))) return null;
    const rule = GUARANTEE_PRESETS[g]!;
    return (p) => {
      const l = p.guaranteeTypes ?? [];
      return (!rule.require || rule.require.some((x) => l.includes(x))) && !(rule.exclude ?? []).some((x) => l.includes(x));
    };
  }
  if (name === 'goods') return (p) => p.loanType === 'goods';
  if (name === 'cash') return (p) => p.loanType === 'score';
  if (name === 'fast') return (p) => p.grantDays === 'under_7';
  return () => true;
}
/** One value for `<PlanFact>`; null when the plan/term is gone (caller keeps the snapshot text). */
export function planFactValue(plans: LoanPlan[], id: number, field: string, term?: number): string | null {
  const p = plans.find((x) => x.id === id);
  if (!p) return null;
  const t = term ? p.installmentTerms.find((x) => x.installments === term) : p.installmentTerms[0];
  if (!t) return null;
  switch (field) {
    case 'principal':
      return `${millionsFa(p.principalAmount)} میلیون تومان`;
    case 'payout':
      return `${millionsFa((p.principalAmount * t.depositPercent) / 100)} میلیون تومان`;
    case 'installment':
      return `${millionsFa(monthlyInstallment(p.principalAmount, p.annualInterest, t.installments))} میلیون تومان`;
    case 'term':
      return `${fa(t.installments)} ماه`;
    case 'rate':
      return `${fa(String(p.annualInterest).replace('.', '٫'))}٪`;
    case 'prepayment':
      return `${fa(String(t.prepaymentPercent).replace('.', '٫'))}٪`;
    case 'speed':
      return DAYS_LABEL[p.grantDays] ?? null;
    case 'mode':
      return MODE_LABEL[p.processMode] ?? null;
    default:
      return null;
  }
}
/** Replaces {planCount} {goodsCount} {cashCount} {bankCount} {fastCount} {minTerm} {maxTerm} {amountRange} {termRange} in frontmatter strings. */
export const fillFacts = (s: string, f: PlanFacts) =>
  s.replace(/\{(planCount|goodsCount|cashCount|bankCount|fastCount|minTerm|maxTerm|amountRange|termRange)\}/g, (_, k: keyof PlanFacts) =>
    typeof f[k] === 'number' ? fa(f[k] as number) : String(f[k]),
  );
/**
 * Landing hero lead (frontmatter `lead`): escapes HTML, `**x**` → <strong>, fact tokens → live-refreshable
 * `data-plan-count` spans, placeholder markers → `.ph` spans (kept verbatim so the strict marker check still sees them).
 */
export const leadHtml = (s: string, f: PlanFacts) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\{(planCount|goodsCount|cashCount|bankCount|fastCount|minTerm|maxTerm|amountRange|termRange)\}/g, (t, k: string) => `<span data-plan-count="${k}">${fillFacts(t, f)}</span>`)
    .replace(/\[((?:تأیید|تایید) محمد|جای‌خالی)([^\]]*)\]/g, '<span class="ph">[$1$2]</span>');
export type AmountBand = (typeof REQ_BAND_KEYS)[number];
