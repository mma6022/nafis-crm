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
ok("phase-1 split: 28 permission pages (27 with a button, ledger in phase 2) + 8 admin pages with a button (5 grantable, 3 never)", () => {
  const p1 = reg.PA_PAGES.filter(reg.paPhase1);
  assert.equal(reg.PA_PAGES.filter((p) => p.kind === "permission").length, 28);
  assert.equal(p1.filter((p) => p.kind === "permission").length, 27);
  const a = p1.filter((p) => p.kind === "admin"); assert.equal(a.length, 8);
  assert.equal(a.filter((p) => reg.paGrantable(p) === "never").length, 3);
});
ok("never-grantable pages", () => { for (const k of ["users", "releases", "assistants-settings", "call-queue-settings"]) assert.equal(reg.paGrantable(reg.PA_BY_KEY.get(k)), "never", k); });
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
