/** DCI-QUEUE 440000 — Armita «کارهای امروز من» v2.1–v2.3.1 client fixture. Source/CSS only; no DB, no network, no phones, no user 29. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../src/features/daily-customer-inline");
const q = fs.readFileSync(path.join(dir, "queue-v21.tsx"), "utf8");
const d = fs.readFileSync(path.join(dir, "DailyCustomerInline.tsx"), "utf8");
const css = fs.readFileSync(path.join(dir, "today-layout.css"), "utf8");
let n = 0;
const ok = (name, cond) => { n += 1; if (!cond) { console.error(`FAIL ${n} ${name}`); process.exit(1); } console.log(`ok ${n} ${name}`); };

ok("flag off: GET /queue 404 → null → v2.0 Timeline kept", /e\?\.status === 404\) return null/.test(q) && /dq \? <DqStrip[\s\S]*?: <Timeline tasks=\{tasks\}/.test(d));
ok("queue polled every 15s", /refetchInterval: 15_000/.test(q));
ok("seven kinds, own colour class + Persian label each", ["k-in", "k-out", "k-lead", "k-fu", "k-rem", "k-file", "k-pay"].every((k) => q.includes(`"${k}"`))
  && ["تماس ورودی", "تماس خروجی", "لید تازه", "پیگیری", "یادآور", "اقدام پرونده", "دستور پرداخت"].every((k) => q.includes(`"${k}"`)));
ok("css: v2.1–v2.3.1 handoff appended (kind vars, blocks, chips, sheet, early, pay, fact)",
  ["--k-in:#C2185B", "--k-pay:#6D4C41", ".dci-blk", ".dci-fchip", ".dci-fsheet", ".dci-early", ".dci-pay", ".dci-fact", ".dci-cur-int", ".ed-intro", "body.fs-open"].every((s) => css.includes(s)));
ok("css: v2.0 today-layout scoping kept (html:has dci-page)", css.includes('html:has([data-testid="dci-page"])'));
ok("«اکنون» row + «خارج از ساعت کاری» + next block", q.includes(">اکنون<") && q.includes("خارج از ساعت کاری") && q.includes("بعد: "));
ok("block dividers labelled بالفعل / بالقوه", /BLK_FA = \{ actual: "بالفعل", potential: "بالقوه" \}/.test(q) && q.includes('className={`dci-blk'));
ok("filter chips carry counts; short label visible, full name in aria-label/title", q.includes("dci-fn") && /aria-label=\{`\$\{lab\}، \$\{fd\(n\)\} کار باز`\}/.test(q) && q.includes("title={sheet ? undefined : lab}"));
ok("filter state text + hidden-urgent warning + clear", q.includes("کار فوری از نوع دیگر پنهان است") && q.includes("پاک کردن فیلتر") && q.includes("نمایش همه"));
ok("mobile «نوع کار» sheet: dialog, Esc closes, focus returns", q.includes('role="dialog" aria-modal="true"') && q.includes('e.key === "Escape"') && q.includes("sheetBtn.current?.focus()") && q.includes("با زدن هر نوع، فقط همان کارها در صف می‌ماند."));
ok("node states: done / urgent / current / early + «جاری»/«بعدی»", ["is-done", "is-urgent", "is-cur", "is-early"].every((s) => q.includes(s)) && q.includes('"جاری"') && q.includes('"بعدی"'));
ok("aria-current on the open task only", q.includes('aria-current={isOpen ? "true" : undefined}'));
ok("early bar + «برگشت به کار جاری» goes back to the current task", q.includes("برگشت به کار جاری") && /onBack=\{\(\) => dqCur && pickDq\(dqCur\)\}/.test(d));
ok("early = a later non-urgent open task while the current one stays", /dqEarly = Boolean\(dqItem && dqCur && dqItem\.id !== dqCur\.id && !dqItem\.done && !dqItem\.urgent\)/.test(d));
ok("saved result → POST /queue/done with taskId + dueRef (done_at/done_early server-side)", /dqApi\.done\(taskId, dqItem\?\.due_ref \?\? null/.test(d) && q.includes('"/queue/done", { taskId, dueRef, outcome }'));
ok("early done → toast + back to current", d.includes("زودتر از نوبت انجام شد و در جای خودش علامت خورد. برگشت به کار جاری…") && /if \(backTo\) pickDq\(backTo\)/.test(d));
ok("410000 kept: dp saveCall planItemId + dpApi.start only for status current", /isPlan \? \{ planItemId: selectedTask\.itemId \}/.test(d) && /selectedTask\.status === "current"/.test(d));
ok("future reminder hint (early)", d.includes("ثبت نتیجه، این یادآور را زودتر از ساعتش تمام می‌کند و ساعت انجام ثبت می‌شود."));
ok("interrupt banner: kind chip + direction + auto-detect", q.includes("dci-kchip") && q.includes("تشخیص خودکار: ") && q.includes('"مشتری موجود"') && q.includes('"لید شناخته‌شده"') && q.includes('"شماره‌ی ناشناس"'));
ok("new incoming call never swaps the open card: toast with «باز کردن»", /useDqArrivals\(dq,/.test(d) && d.includes(">باز کردن<") && !/useDqArrivals\([^)]*pickDq/.test(d));
ok("outgoing to a customer outside the queue → POST /queue/outgoing (Q14)", /void dqEnsure\(cid\)/.test(d) && q.includes('"/queue/outgoing"'));
ok("unknown number: name first, no cancel, «تکمیل پرونده» disabled", q.includes("این شماره در مشتری‌ها نیست. اول نام و نام خانوادگی را بنویسید.") && q.includes("اول نام مشتری را ثبت کنید.") && /id="dci-file-open" disabled/.test(q) && !/DqUnknownBoard[\s\S]*انصراف/.test(q));
ok("unknown → POST /queue/unknown/:id/name then opens c-<id>", q.includes("/queue/unknown/${eventId}/name") && /onNamed=\{\(cid, taskId, name\)/.test(d));
ok("unknown board does not fetch a customer board (customerId 0 → null)", d.includes("(selectedTask?.customerId || null) ??"));
ok("payment card: live sales-approve with a verified account; «تأیید حساب تازه» → /payment-orders", q.includes("/sales-approve") && q.includes("customerBankAccountId: sel") && q.includes('href="/payment-orders">تأیید حساب تازه'));
ok("IBAN masked in the payment card", q.includes("•••• ••••"));
ok("file-action card: «بدون تماس» + «کار لازم» + open file", q.includes(">بدون تماس<") && q.includes(">کار لازم<") && q.includes("/loan-applications/${f.fileId}"));
ok("client never sends SMS/Bale or dials an unknown number", !/sms|bale|tel:/i.test(q));
ok("no dci-seed / user 29 in the client", !/dci-seed|user\.29|\b29\b/.test(q));
console.log(`today-queue-v21 fixture PASS (${n} checks)`);
