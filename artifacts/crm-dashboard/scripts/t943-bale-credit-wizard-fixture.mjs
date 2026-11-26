// t943: Bale chat «اعتبارسنجی سریع» = 4-step new-inquiry wizard (consent → SMS code → fresh result). Source markers + the phase→step mapping. No network.
// Run: node --experimental-strip-types scripts/t943-bale-credit-wizard-fixture.mjs
import { readFileSync, readdirSync } from "node:fs";
import { phaseStep, SCORE_STEPS } from "../src/features/credit-panel/score-wizard-phase.ts";
import { formatMobileGrouped } from "../src/lib/phone.ts";
const r = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } n++; console.log(`ok - ${m}`); };

ok(SCORE_STEPS.length === 4 && SCORE_STEPS[2] === "کد پیامکی", "four steps, the third is the SMS code");
ok(["init", "idle", "starting"].every((p) => phaseStep(p) === 2) && ["otp", "verifying", "processing"].every((p) => phaseStep(p) === 3) && phaseStep("result") === 4, "phase → step mapping");
ok(phaseStep("error") === null && phaseStep("blocked") === null, "error / blocked keep the current step");

const ctx = r("features/bale-workspace/Context.tsx");
ok(/<CreditCard key=\{`bws-cp-\$\{c\.customer\.id\}`\} customerId=\{c\.customer\.id\} wizard \/>/.test(ctx), "Bale «اعتبار» pane opens the card in wizard mode");
const card = r("features/credit-panel/CreditCard.tsx");
ok(/const viaWizard = Boolean\(wizard && me\.data\?\.icc\)/.test(card) && /if \(viaWizard\) setWizOpen\(true\)/.test(card), "wizard only for experts with «اعتبارسنجی فوری»; others keep the old card");
ok(card.includes('data-testid="cp-icc-off"') && card.includes("اعتبارسنجی اعتباریتو برای شما فعال نیست"), "ICC off → explicit sentence, never a silent skip");
ok(card.includes('data-testid="cp-rank-at"') && /wizard && rank/.test(card), "saved rank carries its date in the wizard card");
const walk = (d) => readdirSync(new URL(`../src/${d}`, import.meta.url), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`) : /\.tsx$/.test(e.name) ? [`${d}/${e.name}`] : []);
const users = walk(".").filter((f) => /<CreditCard\b[^>]*\bwizard\b/.test(r(f)));
ok(users.length === 1 && users[0].endsWith("bale-workspace/Context.tsx"), "only the Bale pane uses the wizard mode (Today / Customers / customer page cards untouched)");
const sw = r("features/credit-panel/ScoreWizard.tsx");
ok(/<InstantCreditCheck customerId=\{customer\.id\} embedded hideRecent onPhase=\{onPhase\}/.test(sw), "SMS part is the live InstantCreditCheck component (consent + code + validate)");
ok(/runInquiry\(customer\.id, \{ confirmFresh: false \}\)/.test(sw) && /ex\.code === "still_valid"\) setDebt\("kept"\)/.test(sw), "debt bundle after the score; a still-valid one is kept, not forced");
ok(/data-testid="sw-old"/.test(sw) && sw.includes("قدیمی است و با کد پیامکی مشتری تازه می‌شود") && sw.includes("jalaliDateTime(rank.at)"), "step 1 labels the old rank with its date");
ok(/aria-valuemax=\{4\}/.test(sw), "progress bar with four steps");
const ic = r("features/team-sales/InstantCreditCheck.tsx");
ok(ic.includes("این نتیجه‌ی قبلی مشتری است") && ic.includes("کد پیامکی فرستاده نشد") && /onPhase\?: \(phase: St\) => void/.test(ic), "24-hour reuse note names the date and says no SMS was sent");
ok(!/کد یک‌بارمصرف ICS24/.test(ic) && ic.includes("کد یک‌بارمصرف اعتبارسنجی بانکی فرستاده شد به"), "step 3 names the SMS in Persian, no Latin ICS24");
ok(ic.includes("formatMobileGrouped(phone)") && ic.includes('data-testid="cv-otp-phone"'), "step 3 phone uses the 4-3-4 header grouping");
ok(formatMobileGrouped("09125550017") === "۰۹۱۲ ۵۵۵ ۰۰۱۷" && formatMobileGrouped("9125550017") === "۰۹۱۲ ۵۵۵ ۰۰۱۷", "4-3-4 groups match the Bale header sample");
ok(ic.includes('data-testid="cv-reused-badge"') && ic.includes("قدیمی، {fmtDateTime(c.completedAt)}"), "reused result block also shows «قدیمی» and the date");
ok(ctx.includes("callResultFa") && ctx.includes("answered: 'جواب داد'"), "Bale call history translates «answered» to Persian");
console.log(`t943 UI fixture ${n}/${n}`);
