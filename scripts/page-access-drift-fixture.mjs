// t942u drift test: every dashboard <Route path> and nav href is covered by the page-access registry (58 pages), and every
// registry route still exists in the dashboard. A new page without a registry entry fails here (= no silent "no button").
// Usage: PA_UI_SRC=<crm-dashboard/src> node scripts/run-bundled-fixture.mjs scripts/page-access-drift-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const ui = process.env.PA_UI_SRC || "/workspace/page-access/ui/artifacts/crm-dashboard/src";
if (!fs.existsSync(path.join(ui, "App.tsx"))) { console.log("SKIP (PA_UI_SRC missing)"); process.exit(0); }
const reg = await import("../src/lib/page-access-registry.ts");
let passed = 0, failed = 0;
const ok = (n, f) => { try { f(); passed++; console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "::", e.message); } };
const app = fs.readFileSync(path.join(ui, "App.tsx"), "utf8");
const shell = fs.readFileSync(path.join(ui, "components/CrmShell.tsx"), "utf8");
const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
const hrefs = [...shell.matchAll(/href:\s*['"]([^'"]+)['"]/g)].map((m) => m[1].split("?")[0]);
const covered = (p) => reg.PA_ROUTE_EXEMPT.includes(p) || reg.paKeyForPath(p.replace(/:[^/]+/g, "1")) !== null || reg.PA_PAGES.some((x) => x.routes.includes(p));
ok("58 pages, unique keys", () => { assert.equal(reg.PA_PAGES.length, 58); assert.equal(new Set(reg.PA_PAGES.map((p) => p.key)).size, 58); });
ok("phase 2: all 58 pages have a button (28 permission, 17 admin, 13 bespoke block-only)", () => {
  assert.equal(reg.PA_PAGES.filter(reg.paPhase1).length, 58);
  const by = (k) => reg.PA_PAGES.filter((p) => p.kind === k);
  assert.equal(by("permission").length, 28); assert.equal(by("admin").length, 17); assert.equal(by("bespoke").length, 13);
  for (const p of by("bespoke")) { assert.equal(reg.paGrantable(p), "block", p.key); assert.ok(p.paNote, `${p.key} note`); assert.ok(!p.elevateView?.length, p.key); }
  assert.equal(by("admin").filter((p) => reg.paGrantable(p) === "never").length, 5);
  for (const k of ["sales-admin", "bale-bot-admin"]) assert.ok(reg.PA_BY_KEY.get(k).paNote, k);
});
ok("phase-2 elevation pages + levels", () => {
  const want = { ledger: "view", "sales-assist-settings": "view", "daily-plans": "view", "call-queue-events": "both", "call-queue-discipline": "both", "call-center": "view", "cs-report": "view", "default-owner": "view" };
  for (const [k, g] of Object.entries(want)) { const p = reg.PA_BY_KEY.get(k); assert.equal(reg.paGrantable(p), g, k); assert.ok(p.elevateView?.length, k); }
  assert.deepEqual(reg.paPermissionsFor(reg.PA_BY_KEY.get("ledger"), "view"), []);
});
ok("never-grantable pages", () => { for (const k of ["users", "releases", "assistants-settings", "call-queue-settings", "sales-admin", "bale-bot-admin"]) assert.equal(reg.paGrantable(reg.PA_BY_KEY.get(k)), "never", k); });
ok("view-only caps", () => { for (const k of ["manual-verifications", "credit-rank-overrides", "contracts"]) assert.equal(reg.paGrantable(reg.PA_BY_KEY.get(k)), "view", k); });
ok("no never-permission can be granted", () => {
  for (const p of reg.PA_PAGES) for (const l of ["view", "manage"]) for (const x of reg.paPermissionsFor(p, l)) assert.ok(!reg.PA_NEVER_PERMISSIONS.has(x), `${p.key}:${x}`);
});
ok(`every App.tsx route (${routes.length}) is in the registry`, () => { const miss = routes.filter((r) => r !== "*" && !covered(r)); assert.deepEqual(miss, []); });
ok(`every nav href (${hrefs.length}) is in the registry`, () => { const miss = [...new Set(hrefs)].filter((h) => h.startsWith("/") && !covered(h)); assert.deepEqual(miss, []); });
ok("every registry route still exists in App.tsx", () => {
  const miss = reg.PA_PAGES.flatMap((p) => p.routes).filter((r) => !routes.includes(r));
  assert.deepEqual(miss, []);
});
console.log(`page-access-drift: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
