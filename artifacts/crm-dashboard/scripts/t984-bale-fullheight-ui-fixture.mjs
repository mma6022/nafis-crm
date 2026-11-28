/* t984 «گفتگوهای بله تمام‌قد» v1.1 — pure model + source guards (no browser). node --experimental-strip-types scripts/t984-bale-fullheight-ui-fixture.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "../src/features/bale-fullheight/model.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "features");
const src = (p) => readFileSync(join(root, p), "utf8");
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("  ok ", name); };

ok("thousands separator is «٬» (U+066C) with Persian digits; big values keep every digit", () => {
  assert.equal(M.tomanDigits("1250000"), "۱٬۲۵۰٬۰۰۰");
  assert.equal(M.tomanDigits("0"), "۰");
  assert.equal(M.tomanDigits("300000000"), "۳۰۰٬۰۰۰٬۰۰۰");
  assert.equal(M.tomanDigits("9007199254740993123"), "۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳٬۱۲۳");
  assert.equal(M.tomanDigits("12x"), "—"); assert.equal(M.tomanDigits(null), "—");
  assert.ok(!M.tomanDigits("1250000").includes(",") && !M.tomanDigits("1250000").includes("،"));
  assert.equal(M.toman("1500"), "۱٬۵۰۰ تومان"); assert.equal(M.toman("abc"), "—");
  // Latin or already-grouped input still comes out with U+066C only
  assert.equal(M.tomanDigits("8,000,000"), "۸٬۰۰۰٬۰۰۰");
  assert.equal(M.tomanDigits("۸,۰۰۰,۰۰۰"), "۸٬۰۰۰٬۰۰۰");
  const out = M.toman("8000000");
  assert.ok(out.includes("\u066C"), out);
  assert.ok(!out.includes("\u002C") && !out.includes(","), out);
});
ok("packLabels: a label is shown in full or not at all; expert is kept only in the manager view when space is tight", () => {
  const L = (kind, width, id) => ({ kind, width, id });
  const lead = L("other", 120, "lead"); const exp = L("expert", 80, "ex"); const extra = L("other", 100, "x");
  assert.deepEqual(M.packLabels([lead, exp], 400, true).map((x) => x.id), ["lead", "ex"]);
  assert.deepEqual(M.packLabels([lead, exp], 400, false).map((x) => x.id), ["lead", "ex"]);
  // 120+4+80 = 204 > 150 → not manager: drop expert; manager: keep expert, drop lead (expert packed first)
  assert.deepEqual(M.packLabels([lead, exp], 150, false).map((x) => x.id), ["lead"]);
  assert.deepEqual(M.packLabels([lead, exp], 150, true).map((x) => x.id), ["ex"]);
  assert.deepEqual(M.packLabels([lead, extra, exp], 100, true).map((x) => x.id), ["ex"]); // expert fits, others do not
  assert.deepEqual(M.packLabels([lead, exp], 70, false).map((x) => x.id), []); // lead itself 120 > 70
});
ok("signed amount: + deposit, − withdrawal", () => { assert.equal(M.signed("in", "5000"), "+۵٬۰۰۰"); assert.equal(M.signed("out", "5000"), "−۵٬۰۰۰"); });
const items = [{ id: 3, dir: "in" }, { id: 2, dir: "out" }, { id: 1, dir: "in" }];
ok("all / deposit / withdrawal filter", () => {
  assert.deepEqual(M.filterItems(items, "all").map((x) => x.id), [3, 2, 1]);
  assert.deepEqual(M.filterItems(items, "in").map((x) => x.id), [3, 1]);
  assert.deepEqual(M.filterItems(items, "out").map((x) => x.id), [2]);
});
ok("dates are Jalali with the year, in Asia/Tehran", () => {
  assert.equal(M.dayFa("2026-11-18T09:00:00.000Z"), "۲۷ آبان ۱۴۰۵");
  assert.match(M.dayTimeFa("2026-11-18T09:00:00.000Z"), /^۲۷ آبان ۱۴۰۵، ۱۲:۳۰$/);
  assert.equal(M.dayFa("garbage"), "");
});
ok("labels", () => { assert.equal(M.DIR_FA.in, "واریز"); assert.equal(M.DIR_FA.out, "برداشت"); assert.equal(M.WALLET_FA.cash, "نقدی"); assert.equal(M.WALLET_FA.credit, "اعتباری"); });

const inbox = code("bale-bot/BaleBotInbox.tsx");
ok("flag-gated: the new class and every fh branch hang on bw.fh / fullHeight (OFF → old markup)", () => {
  assert.match(inbox, /const fh = ws && !!bwsMe\.data\?\.fullHeight/);
  assert.match(inbox, /\$\{fh \? ' bw-fh' : ''\}/);
  assert.match(inbox, /fh \? \(showExperts \?/);
  assert.match(inbox, /!fh && me\.view === 'own' && u/);
  assert.match(inbox, /bw\.fh && bwc \? <HeadMenu/);
  assert.match(inbox, /fh && walletOpen && sel != null/);
});
ok("experts: dropdown labelled «کارشناس», default «همهٔ کارشناس‌ها»; status + star chips share one scrolling row", () => {
  const h = code("bale-fullheight/ListHead.tsx");
  assert.match(h, /'همهٔ کارشناس‌ها'/); assert.match(h, /className="lab">کارشناس</);
  assert.match(h, /role="listbox"/); assert.match(h, /aria-haspopup="listbox"/);
  assert.match(inbox, /<ChipRow label=/); assert.match(inbox, /data-testid="bws-starfilter"/);
});
ok("wallet is read-only: no POST/PUT/PATCH/DELETE, only the GET hook", () => {
  for (const f of ["bale-fullheight/Wallet.tsx", "bale-fullheight/useWallet.ts", "bale-fullheight/model.ts"]) assert.doesNotMatch(code(f), /method\s*:\s*['"](POST|PUT|PATCH|DELETE)|bbPost|bbSend/i);
  assert.match(code("bale-fullheight/useWallet.ts"), /\/bale-workspace\/chats\/\$\{chatId\}\/wallet/);
});
ok("wallet window: back button in the same window, empty + loading states, Esc handled, balance button in the context column only", () => {
  const w = code("bale-fullheight/Wallet.tsx");
  assert.ok(w.includes("bfh-wallet-f-${v}") && w.includes("['all', 'همه']") && w.includes("['in', 'واریز']") && w.includes("['out', 'برداشت']"));
  for (const t of ["bfh-wallet-back", "bfh-wallet-empty", "bfh-wallet-loading", "bfh-head-menu"]) assert.ok(w.includes(t), t);
  assert.match(w, /key === 'Escape'/); assert.match(w, /aria-modal="true"/);
  assert.match(code("bale-workspace/Context.tsx"), /!only \? <BfhWalletSlot/);
});
ok("list rows: labels never shrink; expert label is packed (full or hidden); filter chips scroll into view on Tab", () => {
  const inbox = code("bale-bot/BaleBotInbox.tsx");
  assert.match(inbox, /<FhRowLabels labels=\{tags\} expert=\{expertName\} isManager=\{me\.view === 'all'\} \/>/);
  const h = code("bale-fullheight/ListHead.tsx");
  assert.match(h, /scrollIntoView\(\{ inline: 'nearest'/);
  assert.match(h, /onFocus=\{chipFocus\}/);
  assert.match(h, /packLabels/);
  const c = src("bale-fullheight/bale-fullheight.css");
  assert.match(c, /labels never shrink|preview shrinks first/);
  assert.match(c, /scroll-margin-inline:28px/);
  assert.doesNotMatch(c, /pvf \.tg\{[^}]*max-width:66%/);
});
ok("wallet list rows have no «موفق» badge; the detail view keeps it; amounts use bfh-num / toman()", () => {
  const w = code("bale-fullheight/Wallet.tsx");
  assert.equal((w.match(/موفق/g) || []).length, 1);
  assert.match(w, /className="pill ok">موفق</);
  assert.doesNotMatch(w, /stt ok/);
  assert.match(w, /className="bfh-num"/);
  assert.match(code("bale-workspace/Context.tsx"), /bfhToman\(d\.amountToman\)/);
});
ok("css: scoped to .bw-fh / .bfh-*; quick-replies tray (.bqr) untouched; mobile sheet; no fixed 22px arrow gap", () => {
  const c = src("bale-fullheight/bale-fullheight.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(c, /bqr|quick-repl|qr11/);
  const sels = c.split("{").map((s) => s.split("}").pop().trim()).filter((s) => s && !s.startsWith("@") && !/^\d|^to$|^from$/.test(s));
  for (const s of sels) for (const one of s.split(",")) assert.match(one.trim(), /(\.bw-fh|\.bfh-|:root:has\(\.bbt\.bw-fh\))/, one);
  assert.match(c, /@media \(max-width:1023\.98px\)/); assert.match(c, /--bws-arrow-clear:0px/);
});
console.log(`PASS ${n}`);
