import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/features/sales-fixes/MyCustomers.tsx", import.meta.url), "utf8");
assert.match(src, /export const MY_CUSTOMERS_DEFAULT_VIEW: CpkView = "board"/);
assert.match(src, /useState<CpkView>\(MY_CUSTOMERS_DEFAULT_VIEW\)/);
assert.match(src, /ثبت مشتری جدید/);
assert.match(src, /data-testid="sf-mc-new"/);
assert.match(src, /startNew/);
assert.match(src, /IncomingWizard/);
assert.doesNotMatch(src, /writeCpkView|readCpkView/);
assert.doesNotMatch(src, /localStorage\.(get|set)Item/);
console.log("PASS my-customers t853u default board + new-customer button");
