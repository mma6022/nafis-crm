/**
 * t848u UI: the saved name stays visible while the desktop name editor is open
 * (body.is-editing no longer hides .ed-view). No network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(root, "src/features/customer-name-edit/customer-name-edit.css"), "utf8");
const mid = fs.readFileSync(path.join(root, "src/features/daily-customer-inline/DailyCustomerInline.tsx"), "utf8");
const q = fs.readFileSync(path.join(root, "src/features/daily-customer-inline/queue-v21.tsx"), "utf8");
let n = 0;
const ok = (name, cond) => { if (!cond) { console.error("FAIL -", name); process.exitCode = 1; return; } n++; console.log("ok -", name); };
ok("desktop editing keeps .ed-view visible (inline-flex, not display:none)",
  /body\.is-editing \.ed-view[\s\S]{0,280}display:\s*inline-flex\s*!important/.test(css)
  && !/body\.is-editing \.ed-view,\s*[\s\S]{0,200}display:\s*none\s*!important/.test(css));
ok("pencil is hidden while editing so the name is not replaced by a second control",
  /body\.is-editing \.ed-pen\{display:none\}/.test(css));
ok("today board heading still uses the customer name (shownName / m.customer.name)",
  mid.includes("const shownName = nameOv ?? m.customer.name") && mid.includes("<h2>{fd(shownName)}</h2>"));
ok("unknown incoming CTA is unchanged: «ثبت نام و شروع تماس اول» only when customer_id is null",
  q.includes('const unknown = it.customer_id == null') && q.includes('ثبت نام و شروع تماس اول'));
if (!process.exitCode) console.log(`PASS ${n}/4 incoming-name-t848-ui`);
