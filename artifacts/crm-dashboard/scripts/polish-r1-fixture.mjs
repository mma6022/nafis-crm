// polish-r1: my-performance middot, social-hub Armita optionals, t901 r3 invoice optionals (source markers).
import { readFileSync } from "node:fs";
const r = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } n++; console.log(`ok - ${m}`); };

const calls = r("features/my-performance-v12/MyWorkV12Page.tsx");
ok(/resultLabel}، \{r\.durationSec/.test(calls), "call row at 390 uses ، between result and duration (not ·)");
ok(!/resultLabel} · \{r\.durationSec/.test(calls), "no middot remains between result and duration");

const css = r("index.css");
ok(/input-item-title-[\s\S]*overflow-wrap: break-word/.test(css), "شرح کالا wraps at a word boundary, not mid-character");
ok(!/\.gp-invoice td:first-child \{ word-break: normal; overflow-wrap: anywhere; \}/.test(css), "overflow-wrap: anywhere removed from invoice title");
ok(/\.gp-percent-label \{ font-size: 13px;/.test(css), "percent field labels are 13px");
ok(/\.gp-field-error \{ margin: 0; font-size: 13px;/.test(css), "invoice warning text is 13px");

const inv = r("pages/GoodsPurchaseDetail.tsx");
ok(/textarea rows=\{1\}/.test(inv) && /input-item-title-\$\{i\}/.test(inv), "شرح کالا is a wrapping textarea (testid kept)");
ok(/out\.sumOver = true/.test(inv) && /out\.payout = out\.payout \|\| 'جمع دو درصد نباید بیشتر از ۱۰۰ باشد.'/.test(inv), "sum>100 warning is set once on the payout field");
ok(!/out\.discount = out\.payout = 'جمع دو درصد نباید بیشتر از ۱۰۰ باشد.'/.test(inv), "sum warning is not duplicated under both fields");
ok(!/width: `max\(1ch, \$\{Math\.max\(1, faPct\(/.test(inv), "no ch-based width that left a gap before ٪ on integers");

console.log(`polish-r1 fixture ${n}/${n}`);
