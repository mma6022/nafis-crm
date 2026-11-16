import assert from "node:assert/strict";
import {
  instagramLoanPackageLimits,
  isInstagramAmountConsultation,
  parseInstagramRequestedAmount,
  renderInstagramLoanPackages,
  resolveInstagramRequestedAmount,
  selectInstagramLoanPackages,
} from "../src/lib/instagram-loan-packages.ts";

assert.deepEqual(parseInstagramRequestedAmount("برای وام ۳۰۰ میلیون تومان نیاز دارم"), {
  status: "amount",
  amountToman: 300_000_000,
}, "A direct scaled payout request is parsed as تومان");
assert.deepEqual(parseInstagramRequestedAmount("وام ۲ میلیارد می‌خواهم"), {
  status: "amount",
  amountToman: 2_000_000_000,
}, "Billion-scale Persian digits are supported");
assert.deepEqual(parseInstagramRequestedAmount("وام ۳۰ میلیارد ریال می‌خواهم"), {
  status: "amount",
  amountToman: 3_000_000_000,
}, "Explicit ریال amounts convert to تومان at ten ریال per تومان");
assert.deepEqual(parseInstagramRequestedAmount("قرض ٣٠٠ مليون ريال"), {
  status: "amount",
  amountToman: 30_000_000,
}, "Arabic digits, Arabic million/rial words, and explicit Rial conversion are supported");
assert.deepEqual(parseInstagramRequestedAmount("loan amount: 300 million rial"), {
  status: "amount",
  amountToman: 30_000_000,
}, "ASCII digits and explicit ASCII currency units are parsed consistently");
assert.deepEqual(parseInstagramRequestedAmount("برای وام ۹۰۰۰۰۰۰۰ نیاز دارم"), {
  status: "amount",
  amountToman: 90_000_000,
}, "Bare requested amounts are interpreted as تومان");
assert.deepEqual(parseInstagramRequestedAmount("برای وام ۹۰٬۰۰۰٬۰۰۰ نیاز دارم"), {
  status: "amount",
  amountToman: 90_000_000,
}, "Grouped Persian numbers are parsed without changing their unit");
assert.deepEqual(parseInstagramRequestedAmount("برای وام ۹۰۰ میلیون ریال نیاز دارم"), {
  status: "amount",
  amountToman: 90_000_000,
}, "Scaled explicit Rial amounts convert only because ریال was named");
assert.deepEqual(parseInstagramRequestedAmount("شماره من ۰۹۱۲۳۴۵۶۷۸۹ است"), {
  status: "none",
}, "Phone-only identity replies are never requested payout amounts");
assert.deepEqual(parseInstagramRequestedAmount("کد تایید ۱۲۳۴۵۶ است"), {
  status: "none",
}, "OTP values are never interpreted as requested amounts");
assert.deepEqual(parseInstagramRequestedAmount("تاریخ تولدم ۱۳۷۰/۰۵/۱۲ است"), {
  status: "none",
}, "Date fields are not treated as amounts");
assert.deepEqual(parseInstagramRequestedAmount("ماهی ۲۰ میلیون قسط می‌توانم بدهم"), {
  status: "none",
}, "Installment affordability is not the requested cash payout");
assert.deepEqual(parseInstagramRequestedAmount("حقوقم ۲۰ میلیون تومان است"), {
  status: "none",
}, "Income and salary values are not requested payouts");
assert.deepEqual(parseInstagramRequestedAmount("برای وام بین ۸۰ تا ۱۰۰ میلیون نیاز دارم"), {
  status: "ambiguous",
}, "Conflicting payout values are ambiguous");
assert.deepEqual(parseInstagramRequestedAmount("میتونم مبلغ قسط ۵ میلیون تومان بدم"), {
  status: "none",
}, "A generic amount cue never makes an installment-affordability value a requested payout");
assert.deepEqual(parseInstagramRequestedAmount(
  "وام ۳۰۰ میلیون میخوام و مبلغ قسط ۵ میلیون میتونم بدم",
), {
  status: "amount",
  amountToman: 300_000_000,
}, "Installment affordability is ignored while retaining a distinct requested loan amount");
assert.deepEqual(parseInstagramRequestedAmount("اسمم علی است و شماره‌ام ۰۹۱۲۳۴۵۶۷۸۹"), {
  status: "none",
}, "Identity-only replies do not create an amount");
assert.equal(isInstagramAmountConsultation("چه مبلغی برای وام نیاز دارید؟"), true);
assert.equal(isInstagramAmountConsultation("ماهی ۲۰ میلیون قسط می‌توانم بدهم"), false,
  "Affordability by itself is not taken as an amount request");
assert.equal(isInstagramAmountConsultation("با حقوقم چه وامی می‌توانم بگیرم؟"), true,
  "An affordability-style loan recommendation receives the fixed amount-only clarification");

const thread = (roleAndContent) => roleAndContent;
assert.deepEqual(resolveInstagramRequestedAmount([
  { role: "user", content: "برای وام ۱۰۰ میلیون نیاز دارم" },
  { role: "assistant", content: "چه مبلغی نیاز دارید؟" },
  { role: "user", content: "نه، ۵۰ میلیون تومان" },
]), { status: "amount", amountToman: 50_000_000 },
"The current explicit correction takes precedence over an older user amount");
assert.deepEqual(resolveInstagramRequestedAmount([
  { role: "assistant", content: "وام ۹۹۹ میلیون" },
  { role: "user", content: "برای وام ۳۰۰ میلیون نیاز دارم" },
]), { status: "amount", amountToman: 300_000_000 },
"Assistant-authored amounts never seed the requested payout");
assert.deepEqual(resolveInstagramRequestedAmount([
  { role: "assistant", content: "چه مبلغی نیاز دارید؟" },
  { role: "user", content: "اسم من علی است" },
]), { status: "none" },
"A user-only name reply does not resolve the amount");

const plan = (name, payout, options = {}) => ({
  name,
  options: [{
    installmentCount: 12,
    customerPayout: payout,
    installmentAmount: null,
    ...(options.option ?? {}),
  }],
  customerDocuments: options.documents ?? [],
  guarantorDocuments: null,
  guarantorRequired: options.guarantorRequired ?? false,
  customerCollateral: options.customerCollateral ?? [],
  guarantorCollateral: options.guarantorCollateral ?? [],
});

const directPlan = plan("طرح نقدی", 120_000_000);
const directPackages = selectInstagramLoanPackages([directPlan], 100_000_000);
assert.equal(directPackages.length, 1,
  "A single suitable plan is sent independently rather than combined");
assert.equal(directPackages[0].totalCustomerPayout, 120_000_000,
  "Coverage uses customer cash payout, not the nominal principal");
const directRendered = renderInstagramLoanPackages([directPlan], directPackages);
assert(directRendered.answer.includes("طرح نقدی"));
assert(directRendered.answer.includes("۱۲۰٬۰۰۰٬۰۰۰ تومان خالص"));
assert(directRendered.answer.includes("جمع دریافتی خالص: ۱۲۰٬۰۰۰٬۰۰۰ تومان"));
assert.equal(directRendered.messages.length, 0,
  "The first plan is answer and additional independent packages are optional messages");

const multiPlans = [
  plan("طرح الف", 40_000_000),
  plan("طرح ب", 30_000_000),
  plan("طرح ج", 20_000_000),
];
const multiPackages = selectInstagramLoanPackages(multiPlans, 90_000_000);
assert(multiPackages.some((item) => item.options.length === 3),
  "Search supports a three-plan combination when two plans cannot cover the requested payout");
const threeMember = multiPackages.find((item) => item.options.length === 3);
const threeRendered = renderInstagramLoanPackages(multiPlans, [threeMember]);
assert(threeRendered.answer.includes("پکیج یک"));
assert(threeRendered.answer.includes("طرح الف") &&
  threeRendered.answer.includes("طرح ب") &&
  threeRendered.answer.includes("طرح ج"));
assert(threeRendered.answer.includes("جمع دریافتی خالص: ۹۰٬۰۰۰٬۰۰۰ تومان"));
assert(threeRendered.answer.includes("ارزیابی هر طرح مستقل است"));
assert(threeRendered.answer.includes("دریافت هم‌زمان از ۳ طرح لازم است"),
  "Multi-plan packages clearly disclose the number of simultaneous plan disbursements required");
assert(threeRendered.answer.includes("احراز شرایط هیچ طرحی را تضمین نمی‌کند"),
  "The package footer disclaims eligibility guarantees and preserves independent evaluation");
assert.equal(threeRendered.messages.length, 0,
  "A package is delivered as one intact message rather than split between messages");

const sharedDocsPlans = [
  plan("طرح مشترک الف", 40_000_000, { documents: ["کارت ملی", "فیش حقوقی"] }),
  plan("طرح مشترک ب", 30_000_000, { documents: ["کارت ملی", "مدرک شغلی"] }),
  plan("طرح مشترک ج", 20_000_000, { documents: ["کارت ملی", "گردش حساب"] }),
];
const sharedDocsPackage = selectInstagramLoanPackages(sharedDocsPlans, 90_000_000)
  .find((item) => item.options.length === 3);
const sharedDocsRendered = renderInstagramLoanPackages(
  sharedDocsPlans,
  [sharedDocsPackage],
  { customerDocuments: true },
);
assert(sharedDocsRendered.answer.includes("مدرک مشترک همه طرح‌ها: کارت ملی"),
  "Common safe document requirements are compacted once within the same complete package message");
assert.equal((sharedDocsRendered.answer.match(/کارت ملی/gu) ?? []).length, 1,
  "Compaction preserves each member's conditions without repeating common documents");
assert(!sharedDocsRendered.answer.includes("وثیقه مشتری"),
  "A documents-only request does not disclose unrequested collateral conditions");

const rankingPlans = [
  plan("طرح دشوار الف", 50_000_000, {
    documents: ["مدرک شغلی", "گردش حساب", "کارت ملی"],
    guarantorRequired: true,
    customerCollateral: ["چک فیزیکی"],
  }),
  plan("طرح آسان الف", 50_000_000, {
    documents: ["کارت ملی"],
    guarantorRequired: false,
    customerCollateral: ["سفته"],
  }),
  plan("طرح دشوار ب", 50_000_000, {
    documents: ["مدرک شغلی", "گردش حساب", "کارت ملی"],
    guarantorRequired: true,
    customerCollateral: ["چک فیزیکی"],
  }),
  plan("طرح آسان ب", 50_000_000, {
    documents: ["کارت ملی"],
    guarantorRequired: false,
    customerCollateral: ["سفته"],
  }),
];
const ranked = selectInstagramLoanPackages(rankingPlans, 100_000_000);
assert.deepEqual(
  ranked[0].options.map((item) => item.planIndex).sort(),
  [1, 3],
  "Lower document burden, no guarantor, and promissory-note security rank ahead of harder packages",
);

const unknownFlags = plan("طرح نامعلوم", 100_000_000, {
  guarantorRequired: null,
});
unknownFlags.guarantorRequired = null;
unknownFlags.customerCollateral = null;
const unknownPackages = selectInstagramLoanPackages([unknownFlags], 80_000_000);
const unknownRendered = renderInstagramLoanPackages([unknownFlags], unknownPackages, true);
assert(unknownRendered.answer.includes("ضامن: نامشخص"),
  "Unknown guarantor flags never claim that no guarantor is needed");
assert(!unknownRendered.answer.includes("ضامن: نیاز نیست"));
assert(unknownRendered.answer.includes("وثیقه مشتری: نامشخص"));

const conditionOverridePlan = {
  ...plan("طرح با شرط", 100_000_000),
  guarantorRequired: false,
  customerCollateral: [],
  options: [{
    installmentCount: 12,
    customerPayout: 100_000_000,
    installmentAmount: null,
    guarantorRequired: true,
    customerCollateral: ["چک فیزیکی"],
    guarantorCollateral: [],
  }],
};
const conditionOverridePackage = selectInstagramLoanPackages([conditionOverridePlan], 80_000_000);
const conditionOverrideRendered = renderInstagramLoanPackages(
  [conditionOverridePlan],
  conditionOverridePackage,
  true,
);
assert(conditionOverrideRendered.answer.includes("ضامن: نیاز است"),
  "Explicit condition flags override conflicting plan-only guarantor flags");
assert(conditionOverrideRendered.answer.includes("وثیقه مشتری: چک فیزیکی"),
  "Selected package terms render the safe collateral fact for the applicable condition");

const duplicateOptions = {
  ...plan("طرح تکراری", 60_000_000),
  options: [
    { installmentCount: 12, customerPayout: 60_000_000, installmentAmount: null },
    { installmentCount: 24, customerPayout: 30_000_000, installmentAmount: null },
  ],
};
const noManufacturedCoverage = selectInstagramLoanPackages([
  duplicateOptions,
  plan("طرح دوم", 40_000_000),
], 100_000_000);
assert(!noManufacturedCoverage.some((item) =>
  item.options.filter((candidate) => candidate.planIndex === 0).length > 1),
"Different duration options cannot repeat the same plan to manufacture coverage");

const privatePlan = {
  ...plan("طرح عمومی", 100_000_000, {
    guarantorRequired: false,
    customerCollateral: ["سفته"],
  }),
  internalId: "PRIVATE_INTERNAL_PLAN_ID",
  privateNotes: "PRIVATE_NOTE_MARKER",
  customerRanks: ["PRIVATE_RANK_MARKER"],
};
const privateReply = renderInstagramLoanPackages([privatePlan], selectInstagramLoanPackages([privatePlan], 80_000_000), true);
assert(!JSON.stringify(privateReply).includes("PRIVATE_INTERNAL_PLAN_ID"));
assert(!JSON.stringify(privateReply).includes("PRIVATE_NOTE_MARKER"));
assert(!JSON.stringify(privateReply).includes("PRIVATE_RANK_MARKER"),
  "Only whitelisted public terms and derived safe facts render");

const oversized = plan("طرح طولانی", 100_000_000, {
  documents: Array.from({ length: 12 }, (_, index) => `${index}${"مدرک".repeat(30)}`),
});
const oversizedReply = renderInstagramLoanPackages(
  [oversized],
  selectInstagramLoanPackages([oversized], 80_000_000),
  true,
);
assert(oversizedReply, "Oversized packages receive an explicit unavailable response");
assert(Buffer.byteLength(oversizedReply.answer, "utf8") <= 900);
assert(oversizedReply.answer.includes("کارشناس"));

assert(instagramLoanPackageLimits.maxMessages > 1);
assert(instagramLoanPackageLimits.maxSearchStates > 0);
assert(instagramLoanPackageLimits.maxReplyBytes === 900);
console.log("Instagram loan package parser, selection, ranking, and rendering fixtures passed");