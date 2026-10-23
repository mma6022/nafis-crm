export type InstagramLoanPackageOption = {
  installmentCount: number | null;
  customerPayout: number | null;
  installmentAmount: number | null;
  guarantorRequired?: boolean | null;
  customerCollateral?: string[] | null;
  guarantorCollateral?: string[] | null;
};

export type InstagramLoanPackagePlan = {
  name: string;
  options: InstagramLoanPackageOption[];
  customerDocuments: string[] | null;
  guarantorDocuments: string[] | null;
  guarantorRequired?: boolean | null;
  customerCollateral?: string[] | null;
  guarantorCollateral?: string[] | null;
};

export type InstagramAmountParseResult =
  | { status: "amount"; amountToman: number }
  | { status: "ambiguous" }
  | { status: "none" };

export type InstagramLoanPackage = {
  options: Array<{
    planIndex: number;
    optionIndex: number;
    customerPayout: number;
  }>;
  totalCustomerPayout: number;
  hasMore?: boolean;
};

const MAX_PACKAGE_MESSAGES = 10;
const MAX_SEARCH_STATES = 3_000;
const MAX_SEARCH_PLANS = 100;
const MAX_OPTIONS_PER_PLAN = 20;
const MAX_REPLY_BYTES = 900;

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function normalizePersianText(value: string): string {
  return normalizeDigits(value.normalize("NFC"))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ملیون/g, "میلیون")
    .replace(/ملیار(?:د)?/g, "میلیارد")
    .replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/[\u200c\u200d\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function safeAmount(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const AMOUNT_NUMBER = /(?:\d{1,3}(?:[,٬ ]\d{3})+|\d+)(?:\.\d+)?/gu;
const AMOUNT_SCALE = /(?:میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?|هزار|million(?:s)?|billion(?:s)?)/iu;
const MONEY_UNIT = /(?:تومان|تومن|تومانی|ریال|ریالی|toman|rial|irr)/iu;
const REQUEST_CUE =
  /(?:چه\s*مبلغ|چقدر|مبلغ|دریافتی|دریافت(?:\s+کنم|\s+می‌خواهم|\s+میخوام)?|وام.{0,24}(?:می‌خواهم|میخوام|می‌خوام|بگیرم|لازم|نیاز)|(?:می‌خواهم|میخوام|می‌خوام|لازم\s+دارم|نیاز\s+دارم).{0,28}(?:وام|مبلغ|پول)|پول\s+(?:لازم|نیاز)|مقدار\s+وام)/u;
const NON_REQUEST_MONEY_CONTEXT =
  /(?:قسط|اقساط|ماهانه|ماهیانه|در\s+ماه|هر\s+ماه|توان(?:ایی)?\s+(?:پرداخت|قسط)|می‌توانم\s+پرداخت|میتونم\s+قسط|حقوق|درآمد|معاش|حقوقم|درآمدم|حقوق\s+ماهانه)/u;
const SALARY_CONTEXT = /(?:حقوق|درآمد|معاش)/u;
const AFFORDABILITY_CUE =
  /(?:توان(?:ایی)?\s+(?:پرداخت|قسط)|می‌توانم.{0,16}(?:پرداخت|قسط|بدهم)|میتونم.{0,16}(?:پرداخت|قسط|بدم)|قسط.{0,20}(?:می‌توانم|میتونم)|حقوقم|درآمدم)/u;
const DATE_CONTEXT = /(?:تاریخ|روز|سال|ماه|متولد|\/|-)/u;
const PHONE_CONTEXT = /(?:شماره|موبایل|تلفن|تماس|کد\s*(?:ملی|ورود|تایید|تأیید|یکبارمصرف)|رمز|otp)/iu;
const CORRECTION_CONTEXT = /(?:نه|اصلاح|منظورم|درستش|به‌جای|به\s+جای|اشتباه\s+گفتم|تغییر\s+کرد)/u;

function parseNumber(value: string): number | null {
  const normalized = value.replace(/[٬,]/g, "").replace(/ /g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountAt(text: string, match: RegExpExecArray): number | null {
  const raw = match[0];
  const start = match.index;
  const end = start + raw.length;
  const before = text.slice(Math.max(0, start - 36), start);
  const after = text.slice(end, Math.min(text.length, end + 36));
  const near = `${before} ${raw} ${after}`;
  const local = `${text.slice(Math.max(0, start - 14), start)} ${raw} ${text.slice(end, Math.min(text.length, end + 14))}`;
  const suffix = after.trimStart();
  const numeric = parseNumber(raw);
  if (numeric === null) return null;

  const directScale = /^(?:میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?|هزار|million(?:s)?|billion(?:s)?)/iu.exec(suffix);
  const rangedScale = directScale
    ? null
    : /^\s*(?:تا|یا|الی|و)?\s*\d+(?:[,٬ ]\d{3})*(?:\.\d+)?\s*(میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?|هزار|million(?:s)?|billion(?:s)?)/iu.exec(suffix);
  const scaleToken = directScale?.[0] ?? rangedScale?.[1];
  let amount = numeric;
  if (scaleToken) {
    const scale = scaleToken.startsWith("هزار")
      ? 1_000
      : scaleToken.startsWith("میلیارد") || scaleToken.startsWith("بیلیون") ||
        scaleToken.startsWith("billion")
        ? 1_000_000_000
        : 1_000_000;
    amount *= scale;
  }

  const directUnit = /^(?:میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?|هزار|million(?:s)?|billion(?:s)?)?\s*(ریال|ریالی|تومان|تومن|تومانی|toman|rial|irr)/iu.exec(suffix);
  const rangedUnit = directUnit
    ? null
    : /^\s*(?:تا|یا|الی|و)?\s*\d+(?:[,٬ ]\d{3})*(?:\.\d+)?\s*(?:میلیون(?:ی)?|میلیارد(?:ی)?|بیلیون(?:ی)?|هزار|million(?:s)?|billion(?:s)?)?\s*(ریال|ریالی|تومان|تومن|تومانی|toman|rial|irr)/iu.exec(suffix);
  const suffixUnit = directUnit ?? rangedUnit;
  const prefixUnit = /(?:ریال|ریالی|تومان|تومن|تومانی|toman|rial|irr)\s*$/iu.exec(before);
  const unit = suffixUnit?.[1] ?? prefixUnit?.[0]?.trim();
  if (unit && (unit.startsWith("ریال") || ["rial", "irr"].includes(unit))) {
    amount /= 10;
    if (!Number.isInteger(amount)) return null;
  }

  const rawDigits = raw.replace(/\D/g, "");
  const grouped = /[,٬ ]/.test(raw);
  const hasScale = Boolean(scaleToken);
  const hasExplicitUnit = Boolean(suffixUnit || prefixUnit);
  // A plain 10–11 digit number is phone-like unless it is explicitly grouped,
  // scaled, or followed by an explicit money unit.
  if (rawDigits.length >= 10 && !grouped && !hasScale && !hasExplicitUnit) return null;
  if (rawDigits.length >= 10 && !grouped && PHONE_CONTEXT.test(near)) return null;
  if (PHONE_CONTEXT.test(near)) return null;
  if (DATE_CONTEXT.test(local) && !hasScale && !hasExplicitUnit) return null;
  if (SALARY_CONTEXT.test(local)) return null;

  // Installment affordability, income, and salary values are never a requested
  // cash payout even when they happen to be expressed in تومان.
  if (NON_REQUEST_MONEY_CONTEXT.test(local)) return null;
  return safeAmount(amount);
}

/**
 * Parse one user utterance as an explicit cash-payout request. Unqualified
 * numbers are تومان only when the surrounding words clearly request loan
 * money; otherwise they are intentionally ignored.
 */
export function parseInstagramRequestedAmount(text: string): InstagramAmountParseResult {
  const normalized = normalizePersianText(text);
  const requestCue = REQUEST_CUE.test(normalized);
  const found: number[] = [];
  let match: RegExpExecArray | null;
  AMOUNT_NUMBER.lastIndex = 0;
  while ((match = AMOUNT_NUMBER.exec(normalized))) {
    const amount = amountAt(normalized, match);
    if (amount === null) continue;
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const before = normalized.slice(Math.max(0, match.index - 24), match.index);
    const local = `${before} ${match[0]} ${after}`;
    const hasRangeUnit = /^\s*(?:تا|یا|الی|و)?\s*\d+(?:[,٬ ]\d{3})*(?:\.\d+)?\s*(?:میلیون|میلیارد|بیلیون|هزار|million|billion|ریال|ریالی|تومان|تومن|rial|toman|irr)/iu.test(after);
    if (!AMOUNT_SCALE.test(after) && !hasRangeUnit && !MONEY_UNIT.test(local) && !REQUEST_CUE.test(local)) continue;
    found.push(amount);
  }
  if (!found.length) return { status: "none" };

  // A scaled or unit-qualified value is explicit money. A bare number requires
  // a direct request cue; this rejects names, dates, installment counts, and
  // incidental financial amounts.
  const hasExplicitMoney = AMOUNT_SCALE.test(normalized) || MONEY_UNIT.test(normalized);
  if (!requestCue && !hasExplicitMoney) return { status: "none" };

  const distinct = [...new Set(found)];
  return distinct.length === 1
    ? { status: "amount", amountToman: distinct[0] }
    : { status: "ambiguous" };
}

export function isInstagramAmountConsultation(text: string): boolean {
  const normalized = normalizePersianText(text);
  if (AFFORDABILITY_CUE.test(normalized)) return true;
  if (NON_REQUEST_MONEY_CONTEXT.test(normalized) &&
    /(?:وام|قرض|طرح\s+وام)/u.test(normalized) &&
    /(?:چه\s+وام|کدام\s+وام|می‌توانم.{0,20}بگیر|میتونم.{0,20}بگیر|مناسب.{0,20}وام|توان.{0,20}وام)/u.test(normalized)) {
    return true;
  }
  if (NON_REQUEST_MONEY_CONTEXT.test(normalized)) return false;
  return [
    /چه\s*مبلغ(?:ی)?\s*(?:نیاز|لازم|وام)/u,
    /چه\s*مبلغ.{0,28}وام/u,
    /(?:مبلغ|پول).{0,20}(?:نیاز\s+دارم|لازم\s+دارم|می‌خواهم|میخوام|می‌خوام)/u,
    /(?:نیاز\s+دارم|لازم\s+دارم|می‌خواهم|میخوام|می‌خوام).{0,24}(?:وام|مبلغ|پول)/u,
    /وام.{0,28}(?:می‌خواهم|میخوام|می‌خوام|لازم|نیاز|بگیرم)/u,
    /برای.{0,20}وام.{0,30}(?:می‌خواهم|میخوام|می‌خوام|لازم|نیاز)/u,
    /دنبال.{0,28}وام/u,
    /(?:چه\s+وام|کدام\s+وام|وام.{0,20}(?:معرفی|پیشنهاد|مناسب))/u,
    /چقدر\s+وام.{0,20}(?:می‌گیرم|میگیرم|می‌دهند|میدهند|لازم)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function isInstagramAmountPromptReply(
  messages: readonly { role: string; content: string }[],
): boolean {
  const current = [...messages].reverse().find((message) => message.role === "user");
  return Boolean(current && priorAssistantRequestedAmount(messages));
}

function priorAssistantRequestedAmount(
  messages: readonly { role: string; content: string }[],
): boolean {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return false;
  const text = normalizePersianText(lastAssistant.content);
  return text.includes("چه مبلغی نیاز دارید؟") || text.includes("چه مبلغی نیاز دارید");
}

/**
 * Resolve the current user correction first. The only history-based relaxation
 * is allowing a bare numeric reply to the immediately preceding amount
 * question; assistant-authored numbers are never parsed as amounts.
 */
export function resolveInstagramRequestedAmount(
  messages: readonly { role: string; content: string }[],
): InstagramAmountParseResult {
  const users = messages.filter((message) => message.role === "user").slice(-16);
  const current = users.at(-1);
  if (!current) return { status: "none" };
  const parsed = parseInstagramRequestedAmount(current.content);
  if (parsed.status !== "none") return parsed;

  if (priorAssistantRequestedAmount(messages)) {
    const currentText = normalizePersianText(current.content);
    if (/^(?:[\d٬, .]+|[\d٬, .]+\s*(?:تومان|تومن|ریال))$/u.test(currentText)) {
      const amount = parseInstagramRequestedAmount(`وام ${currentText}`);
      if (amount.status !== "none") return amount;
    }
  }

  // Do not resurrect an older target after a new identity, affordability, or
  // unrelated reply. History is inspected only to notice a current correction.
  if (CORRECTION_CONTEXT.test(normalizePersianText(current.content))) {
    const priorUser = users.slice(0, -1).reverse().find((message) =>
      parseInstagramRequestedAmount(message.content).status === "amount");
    if (priorUser) return parseInstagramRequestedAmount(current.content);
  }
  return { status: "none" };
}

type Candidate = {
  planIndex: number;
  optionIndex: number;
  customerPayout: number;
  documentBurden: number;
  guarantorBurden: number;
  collateralBurden: number;
};

type SearchState = {
  candidates: Candidate[];
  total: number;
  documentBurden: number;
  guarantorBurden: number;
  collateralBurden: number;
};

function collateralRank(values: string[] | null | undefined): number {
  if (values === null || values === undefined) return 2;
  if (!values.length) return 0;
  const normalized = values.map(normalizePersianText);
  const onlyNotes = normalized.every((value) => value.includes("سفته"));
  if (onlyNotes) return 1;
  // Deposit collateral is labelled «حساب مسدودی بانکی»; the old wording is still matched only so legacy/cached
  // plan labels keep their burden rank (input matching only, never shown — see no-sepordeh check exception).
  if (normalized.some((value) => /چک|ملک|خودرو|مسدودی|سپرده|کسر از حقوق/u.test(value))) return 3;
  return 2;
}

function candidatesFromPlans(plans: readonly InstagramLoanPackagePlan[]): Candidate[] {
  const candidates: Candidate[] = [];
  plans.slice(0, MAX_SEARCH_PLANS).forEach((plan, planIndex) => {
    const docs = plan.customerDocuments;
    for (const [optionIndex, option] of plan.options.slice(0, MAX_OPTIONS_PER_PLAN).entries()) {
      if (!Number.isSafeInteger(option.customerPayout) || (option.customerPayout ?? 0) <= 0) continue;
      const guarantorRequired = option.guarantorRequired !== undefined
        ? option.guarantorRequired
        : plan.guarantorRequired;
      const guarantorBurden = guarantorRequired === false
        ? 0
        : guarantorRequired === true ? 2 : 1;
      const customerCollateral = collateralRank(
        option.customerCollateral !== undefined
          ? option.customerCollateral
          : plan.customerCollateral,
      );
      const guarantorCollateral = collateralRank(
        option.guarantorCollateral !== undefined
          ? option.guarantorCollateral
          : plan.guarantorCollateral,
      );
      const securityBurden = Math.max(customerCollateral, guarantorCollateral);
      candidates.push({
        planIndex,
        optionIndex,
        customerPayout: option.customerPayout as number,
        documentBurden: docs === null ? 4 : docs.length,
        guarantorBurden,
        collateralBurden: securityBurden,
      });
    }
  });
  return candidates;
}

function packageRank(state: SearchState, target: number): number[] {
  const distinctPlans = new Map<number, Candidate>();
  for (const candidate of state.candidates) distinctPlans.set(candidate.planIndex, candidate);
  const memberCount = distinctPlans.size;
  const documentBurden = [...distinctPlans.values()].reduce((sum, candidate) =>
    sum + candidate.documentBurden, 0);
  const guarantorBurden = [...distinctPlans.values()].reduce((sum, candidate) =>
    sum + candidate.guarantorBurden, 0);
  const collateralBurden = [...distinctPlans.values()].reduce((sum, candidate) =>
    sum + candidate.collateralBurden, 0);
  return [
    guarantorBurden,
    collateralBurden,
    documentBurden,
    memberCount,
    Math.max(0, state.total - target),
    -state.total,
  ];
}

function compareRank(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function makePackage(state: SearchState, hasMore = false): InstagramLoanPackage {
  return {
    options: state.candidates.map(({ planIndex, optionIndex, customerPayout }) => ({
      planIndex,
      optionIndex,
      customerPayout,
    })),
    totalCustomerPayout: state.total,
    ...(hasMore ? { hasMore: true } : {}),
  };
}

/**
 * Select deterministic payout-covering packages. A plan contributes at most
 * one configured duration to each combination, and array positions are used
 * only as private in-memory identities; no plan IDs are included in output.
 */
export function selectInstagramLoanPackages(
  plans: readonly InstagramLoanPackagePlan[],
  requestedPayoutToman: number,
): InstagramLoanPackage[] {
  if (!Number.isSafeInteger(requestedPayoutToman) || requestedPayoutToman <= 0) return [];
  const candidates = candidatesFromPlans(plans);
  const byPlan = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const group = byPlan.get(candidate.planIndex) ?? [];
    group.push(candidate);
    byPlan.set(candidate.planIndex, group);
  }

  const singlesByPlanPayout = new Map<string, SearchState>();
  for (const candidate of candidates) {
    if (candidate.customerPayout < requestedPayoutToman) continue;
    const key = `${candidate.planIndex}:${candidate.customerPayout}`;
    const state = singlesByPlanPayout.get(key) ?? {
      candidates: [],
      total: candidate.customerPayout,
      documentBurden: candidate.documentBurden,
      guarantorBurden: candidate.guarantorBurden,
      collateralBurden: candidate.collateralBurden,
    };
    state.candidates.push(candidate);
    singlesByPlanPayout.set(key, state);
  }
  const singles = [...singlesByPlanPayout.values()]
    .sort((left, right) => compareRank(packageRank(left, requestedPayoutToman), packageRank(right, requestedPayoutToman)));
  if (singles.length) {
    return singles
      .slice(0, MAX_PACKAGE_MESSAGES)
      .map((state, index) => makePackage(state, index === MAX_PACKAGE_MESSAGES - 1 && singles.length > MAX_PACKAGE_MESSAGES));
  }

  const planGroups = [...byPlan.values()];
  const maximumPayout = Math.max(...candidates.map((candidate) => candidate.customerPayout), 0);
  const maximumUsefulTotal = requestedPayoutToman + maximumPayout;
  let states: SearchState[] = [{
    candidates: [],
    total: 0,
    documentBurden: 0,
    guarantorBurden: 0,
    collateralBurden: 0,
  }];

  for (const group of planGroups) {
    const next = [...states];
    for (const state of states) {
      for (const candidate of group) {
        const total = state.total + candidate.customerPayout;
        if (!Number.isSafeInteger(total) || total > maximumUsefulTotal) continue;
        next.push({
          candidates: [...state.candidates, candidate],
          total,
          documentBurden: state.documentBurden + candidate.documentBurden,
          guarantorBurden: state.guarantorBurden + candidate.guarantorBurden,
          collateralBurden: state.collateralBurden + candidate.collateralBurden,
        });
      }
    }

    // Keep the best burden-ranked state for each exact sum. This limits the
    // search to a predictable number of states without imposing a package-size
    // ceiling; large packages remain possible when coverage requires them.
    const byTotal = new Map<number, SearchState>();
    for (const state of next) {
      const previous = byTotal.get(state.total);
      if (!previous || compareRank(
        packageRank(state, requestedPayoutToman),
        packageRank(previous, requestedPayoutToman),
      ) < 0) byTotal.set(state.total, state);
    }
    states = [...byTotal.values()];
    if (states.length > MAX_SEARCH_STATES) {
      states.sort((left, right) =>
        (left.guarantorBurden * 1_000_000 + left.collateralBurden * 10_000 +
          left.documentBurden * 1_000 + Math.abs(requestedPayoutToman - left.total)) -
        (right.guarantorBurden * 1_000_000 + right.collateralBurden * 10_000 +
          right.documentBurden * 1_000 + Math.abs(requestedPayoutToman - right.total)));
      states = states.slice(0, MAX_SEARCH_STATES);
    }
  }

  const combinations = states
    .filter((state) => state.candidates.length >= 2 && state.total >= requestedPayoutToman)
    .sort((left, right) => compareRank(packageRank(left, requestedPayoutToman), packageRank(right, requestedPayoutToman)));
  return combinations
    .slice(0, MAX_PACKAGE_MESSAGES)
    .map((state, index) => makePackage(state, index === MAX_PACKAGE_MESSAGES - 1 && combinations.length > MAX_PACKAGE_MESSAGES));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("fa-IR").format(value);
}

function formatPackageOrdinal(index: number): string {
  return [
    "یک", "دو", "سه", "چهار", "پنج",
    "شش", "هفت", "هشت", "نه", "ده",
  ][index] ?? formatNumber(index + 1);
}

function safeMemberFacts(
  option: InstagramLoanPackageOption,
): string {
  const count = option.installmentCount === null
    ? "مدت نامشخص"
    : `${formatNumber(option.installmentCount)} قسط`;
  const installment = option.installmentAmount === null
    ? "قسط نامشخص"
    : `هر قسط ${formatNumber(option.installmentAmount)} تومان`;
  return `${formatNumber(option.customerPayout ?? 0)} تومان خالص؛ ${count}؛ ${installment}`;
}

function selectedOptionFact<T>(
  options: readonly InstagramLoanPackageOption[],
  key: "guarantorRequired" | "customerCollateral" | "guarantorCollateral",
  fallback: T,
): T | null {
  if (!options.some((option) => Object.hasOwn(option, key))) return fallback;
  if (!options.every((option) => Object.hasOwn(option, key))) return null;
  const first = options[0]?.[key] as T;
  return options.every((option) => JSON.stringify(option[key]) === JSON.stringify(first))
    ? first
    : null;
}

type PlanObligationFacts = {
  guarantorRequired: boolean | null | undefined;
  customerDocuments: string[] | null;
  guarantorDocuments: string[] | null;
  customerCollateral: string[] | null | undefined;
  guarantorCollateral: string[] | null | undefined;
};

type SharedObligationFields = Required<InstagramLoanPackageDetailFields>;
type PackageSharedObligations = {
  line: string | null;
  facts: Partial<PlanObligationFacts>;
};

function planObligationFacts(
  plan: InstagramLoanPackagePlan,
  selectedOptions: readonly InstagramLoanPackageOption[],
): PlanObligationFacts {
  return {
    guarantorRequired: selectedOptionFact(
      selectedOptions,
      "guarantorRequired",
      plan.guarantorRequired,
    ),
    customerDocuments: plan.customerDocuments,
    guarantorDocuments: plan.guarantorDocuments,
    customerCollateral: selectedOptionFact(
      selectedOptions,
      "customerCollateral",
      plan.customerCollateral,
    ),
    guarantorCollateral: selectedOptionFact(
      selectedOptions,
      "guarantorCollateral",
      plan.guarantorCollateral,
    ),
  };
}

function valuesMatch<T>(values: readonly T[]): boolean {
  return values.length > 1 &&
    values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
}

function shortDocuments(documents: string[] | null): string {
  return documents === null
    ? "نامشخص"
    : documents.length ? documents.join("، ") : "ثبت نشده";
}

function shortCollateral(collateral: string[] | null | undefined): string {
  return collateral === null || collateral === undefined
    ? "نامشخص"
    : collateral.length ? collateral.join("، ") : "ندارد";
}

function sharedObligationsLine(
  members: readonly PlanObligationFacts[],
  fields: SharedObligationFields,
): PackageSharedObligations {
  if (members.length < 2) return { line: null, facts: {} };
  const shared: string[] = [];
  const sharedFacts: Partial<PlanObligationFacts> = {};
  const guarantors = members.map((fact) => fact.guarantorRequired);
  const customerDocs = members.map((fact) => fact.customerDocuments);
  const guarantorDocs = members.map((fact) => fact.guarantorDocuments);
  const customerCollateral = members.map((fact) => fact.customerCollateral);
  const guarantorCollateral = members.map((fact) => fact.guarantorCollateral);

  if (fields.guarantorRequirement && valuesMatch(guarantors)) {
    const value = guarantors[0];
    sharedFacts.guarantorRequired = value;
    shared.push(`ضامن ${value === false ? "نیاز نیست" : value === true ? "نیاز است" : "نامشخص"}`);
  }
  if (fields.customerDocuments && valuesMatch(customerDocs)) {
    sharedFacts.customerDocuments = customerDocs[0];
    shared.push(`مدارک مشتری ${shortDocuments(customerDocs[0])}`);
  }
  if (fields.guarantorDocuments && valuesMatch(guarantorDocs)) {
    sharedFacts.guarantorDocuments = guarantorDocs[0];
    shared.push(`مدارک ضامن ${shortDocuments(guarantorDocs[0])}`);
  }
  if (fields.customerCollateral && valuesMatch(customerCollateral)) {
    sharedFacts.customerCollateral = customerCollateral[0];
    shared.push(`وثیقه مشتری ${shortCollateral(customerCollateral[0])}`);
  }
  if (fields.guarantorCollateral && valuesMatch(guarantorCollateral)) {
    sharedFacts.guarantorCollateral = guarantorCollateral[0];
    shared.push(`وثیقه ضامن ${shortCollateral(guarantorCollateral[0])}`);
  }
  return {
    line: shared.length ? `برای همه طرح‌ها: ${shared.join("؛ ")}` : null,
    facts: sharedFacts,
  };
}

function safePlanConditions(
  plan: InstagramLoanPackagePlan,
  fields: Required<InstagramLoanPackageDetailFields>,
  commonCustomerDocuments: readonly string[] = [],
  selectedOptions: readonly InstagramLoanPackageOption[] = [],
  sharedFacts: Partial<PlanObligationFacts> = {},
): string[] {
  const obligations = planObligationFacts(plan, selectedOptions);
  const facts: string[] = [];
  if (fields.guarantorRequirement && !Object.hasOwn(sharedFacts, "guarantorRequired")) {
    facts.push(`ضامن: ${obligations.guarantorRequired === false
      ? "نیاز نیست"
      : obligations.guarantorRequired === true ? "نیاز است" : "نامشخص"}`);
  }

  if (fields.customerDocuments && !Object.hasOwn(sharedFacts, "customerDocuments")) {
    if (plan.customerDocuments === null) {
      facts.push("مدارک مشتری: نامشخص");
    } else {
      const uniqueDocuments = plan.customerDocuments.filter((document) =>
        !commonCustomerDocuments.includes(document));
      if (uniqueDocuments.length) {
        facts.push(`مدارک مشتری: ${uniqueDocuments.join("، ")}`);
      } else if (commonCustomerDocuments.length) {
        facts.push("مدارک مشتری: مشترک");
      } else if (plan.customerDocuments.length) {
        facts.push(`مدارک مشتری: ${plan.customerDocuments.join("، ")}`);
      } else {
        facts.push("مدارک مشتری: ثبت نشده");
      }
    }
  }

  if (fields.guarantorDocuments && !Object.hasOwn(sharedFacts, "guarantorDocuments")) {
    if (plan.guarantorDocuments === null) {
      facts.push("مدارک ضامن: نامشخص");
    } else if (plan.guarantorDocuments.length) {
      facts.push(`مدارک ضامن: ${plan.guarantorDocuments.join("، ")}`);
    } else {
      facts.push("مدارک ضامن: ثبت نشده");
    }
  }

  if (fields.customerCollateral && !Object.hasOwn(sharedFacts, "customerCollateral")) {
    if (obligations.customerCollateral === null || obligations.customerCollateral === undefined) {
      facts.push("وثیقه مشتری: نامشخص");
    } else if (obligations.customerCollateral.length) {
      facts.push(`وثیقه مشتری: ${obligations.customerCollateral.join("، ")}`);
    } else {
      facts.push("وثیقه مشتری: ندارد");
    }
  }
  if (fields.guarantorCollateral && !Object.hasOwn(sharedFacts, "guarantorCollateral")) {
    if (obligations.guarantorCollateral === null || obligations.guarantorCollateral === undefined) {
      facts.push("وثیقه ضامن: نامشخص");
    } else if (obligations.guarantorCollateral.length) {
      facts.push(`وثیقه ضامن: ${obligations.guarantorCollateral.join("، ")}`);
    } else {
      facts.push("وثیقه ضامن: ندارد");
    }
  }
  return facts.length ? [facts.join("؛ ")] : [];
}

function renderPlanGroup(
  plan: InstagramLoanPackagePlan,
  options: InstagramLoanPackage["options"],
  fields: Required<InstagramLoanPackageDetailFields>,
  memberNumber: number,
  commonCustomerDocuments: readonly string[] = [],
  sharedFacts: Partial<PlanObligationFacts> = {},
): string[] {
  const lines = [`${formatNumber(memberNumber)}) ${plan.name}`];
  const selectedOptions: InstagramLoanPackageOption[] = [];
  for (const [index, item] of options.entries()) {
    const option = plan.options[item.optionIndex];
    if (option) {
      selectedOptions.push(option);
      lines.push(
        `${options.length > 1 ? `گزینه ${formatNumber(index + 1)}: ` : ""}${safeMemberFacts(option)}`,
      );
    }
  }
  lines.push(...safePlanConditions(
    plan,
    fields,
    commonCustomerDocuments,
    selectedOptions,
    sharedFacts,
  ));
  return lines;
}

export type RenderedInstagramLoanPackages = {
  answer: string;
  messages?: string[];
};

export type InstagramLoanPackageDetailFields = {
  customerDocuments?: boolean;
  guarantorDocuments?: boolean;
  guarantorRequirement?: boolean;
  customerCollateral?: boolean;
  guarantorCollateral?: boolean;
};

function detailFields(
  value: boolean | InstagramLoanPackageDetailFields,
): Required<InstagramLoanPackageDetailFields> {
  if (value === true) {
    return {
      customerDocuments: true,
      guarantorDocuments: true,
      guarantorRequirement: true,
      customerCollateral: true,
      guarantorCollateral: true,
    };
  }
  if (typeof value === "boolean") {
    return {
      customerDocuments: false,
      guarantorDocuments: false,
      guarantorRequirement: false,
      customerCollateral: false,
      guarantorCollateral: false,
    };
  }
  return {
    customerDocuments: value.customerDocuments === true,
    guarantorDocuments: value.guarantorDocuments === true,
    guarantorRequirement: value.guarantorRequirement === true,
    customerCollateral: value.customerCollateral === true,
    guarantorCollateral: value.guarantorCollateral === true,
  };
}

/**
 * Render one package per message. Each member's duration and payout remain
 * together, totals are calculated only from safe projected payout values, and
 * oversized packages are explicitly unavailable rather than split/truncated.
 */
export function renderInstagramLoanPackages(
  plans: readonly InstagramLoanPackagePlan[],
  packages: readonly InstagramLoanPackage[],
  requestedDetailFields: boolean | InstagramLoanPackageDetailFields = false,
): RenderedInstagramLoanPackages | null {
  const fields = detailFields(requestedDetailFields);
  const rendered: string[] = [];
  let unavailableCount = 0;
  for (const loanPackage of packages) {
    const byPlan = new Map<number, InstagramLoanPackage["options"]>();
    let invalidMember = false;
    for (const item of loanPackage.options) {
      const plan = plans[item.planIndex];
      const option = plan?.options[item.optionIndex];
      if (!plan || !option || option.customerPayout !== item.customerPayout) {
        invalidMember = true;
        break;
      }
      const group = byPlan.get(item.planIndex) ?? [];
      group.push(item);
      byPlan.set(item.planIndex, group);
    }
    if (invalidMember || !byPlan.size) continue;
    const total = [...byPlan.entries()].reduce((sum, [planIndex, entries]) => {
      const payout = entries[0]?.customerPayout ?? 0;
      if (entries.some((entry) => entry.customerPayout !== payout)) return Number.NaN;
      return sum + payout;
    }, 0);
    if (!Number.isSafeInteger(total) || total !== loanPackage.totalCustomerPayout) continue;
    const groups = [...byPlan.entries()];
    const commonCustomerDocuments = fields.customerDocuments && groups.length > 1 &&
      groups.every(([planIndex]) => plans[planIndex].customerDocuments !== null)
      ? (plans[groups[0][0]].customerDocuments ?? []).filter((document) =>
        groups.slice(1).every(([planIndex]) =>
          plans[planIndex].customerDocuments?.includes(document)))
      : [];
    const memberFacts = groups.map(([planIndex, items]) => {
      const selectedOptions = items.flatMap((item) => {
        const option = plans[planIndex].options[item.optionIndex];
        return option ? [option] : [];
      });
      return planObligationFacts(plans[planIndex], selectedOptions);
    });
    const sharedObligations = sharedObligationsLine(memberFacts, fields);
    const members = groups.flatMap(([planIndex, options], index) =>
      renderPlanGroup(
        plans[planIndex],
        options,
        fields,
        index + 1,
        commonCustomerDocuments,
        sharedObligations.facts,
      ));
    if (commonCustomerDocuments.length &&
      !Object.hasOwn(sharedObligations.facts, "customerDocuments")) {
      members.unshift(`مدرک مشترک همه طرح‌ها: ${commonCustomerDocuments.join("، ")}`);
    }
    if (sharedObligations.line) members.unshift(sharedObligations.line);
    const number = formatPackageOrdinal(rendered.length);
    const message = [
      `پکیج ${number}`,
      ...members,
      `جمع دریافتی خالص: ${formatNumber(loanPackage.totalCustomerPayout)} تومان`,
      groups.length > 1
        ? `برای تأمین این مبلغ، دریافت هم‌زمان از ${formatNumber(groups.length)} طرح لازم است.`
        : "برای تأمین این مبلغ، دریافت از یک طرح لازم است.",
      "این پیشنهاد، تأیید، پرداخت یا احراز شرایط هیچ طرحی را تضمین نمی‌کند؛ ارزیابی هر طرح مستقل است.",
      ...(loanPackage.hasMore
        ? ["گزینه‌های مناسب بیشتری هم وجود دارد؛ برای ادامه، بفرمایید."]
        : []),
    ].join("\n");
    if (Buffer.byteLength(message, "utf8") > MAX_REPLY_BYTES) {
      unavailableCount += 1;
      continue;
    }
    rendered.push(message);
  }

  if (unavailableCount && !rendered.length) {
    const answer =
      "شرایط کامل این بسته در یک پیام جا نمی‌شود؛ برای دریافت جزئیات کامل، کارشناس باید بررسی کند.";
    return Buffer.byteLength(answer, "utf8") <= MAX_REPLY_BYTES ? { answer, messages: [] } : null;
  }
  if (unavailableCount && rendered.length) {
    const notice =
      "جزئیات بسته‌های بیشتر در یک پیام جا نمی‌شود؛ برای بررسی کامل آن‌ها با کارشناس هماهنگ کنید.";
    const last = rendered.at(-1);
    if (last && Buffer.byteLength(`${last}\n${notice}`, "utf8") <= MAX_REPLY_BYTES) {
      rendered[rendered.length - 1] = `${last}\n${notice}`;
    } else {
      return {
        answer: "فهرست کامل بسته‌های مناسب در یک پیام قابل ارائه نیست؛ برای دریافت همه شرایط، کارشناس باید بررسی کند.",
        messages: [],
      };
    }
  }
  if (!rendered.length) return null;
  return {
    answer: rendered[0],
    messages: rendered.slice(1),
  };
}

export const instagramLoanPackageLimits = Object.freeze({
  maxMessages: MAX_PACKAGE_MESSAGES,
  maxReplyBytes: MAX_REPLY_BYTES,
  maxSearchStates: MAX_SEARCH_STATES,
});