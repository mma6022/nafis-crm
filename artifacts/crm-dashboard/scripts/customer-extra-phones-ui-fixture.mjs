/**
 * t853u UI markers: «افزودن شماره» in the today mid column and the admin customer edit form.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mid = fs.readFileSync(path.join(root, "src/features/daily-customer-inline/DailyCustomerInline.tsx"), "utf8");
const form = fs.readFileSync(path.join(root, "src/components/CustomerForm.tsx"), "utf8");
const block = fs.readFileSync(path.join(root, "src/features/customer-phones/CustomerPhones.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "src/features/customer-phones/customer-phones.css"), "utf8");
const vc = fs.readFileSync(path.join(root, "src/features/voip-call/api.ts"), "utf8");

assert.match(mid, /CustomerPhonesBlock/);
assert.match(mid, /dci-cph/);
assert.match(mid, /useCallPhonePicker/);
assert.match(form, /CustomerPhonesBlock/);
assert.match(form, /adm-cph/);
assert.match(form, /isEditing && customer/);
assert.match(block, /افزودن شماره/);
assert.match(block, /cph-add/);
assert.match(block, /min-height:44px|cph-add/);
assert.match(css, /min-height:44px/);
assert.match(block, /با کدام شماره تماس گرفته شود/);
assert.match(vc, /phone\?: string/);
console.log("ok - customer-extra-phones UI markers 1/1");
