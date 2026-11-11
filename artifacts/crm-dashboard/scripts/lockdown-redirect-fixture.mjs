/**
 * Route-level lockdown: allowed pages stay, blocked routes would go to /today,
 * background 403 is not a navigation reason. Pure function checks (no server).
 */
import { EL_ALLOWED_PAGES, EL_LOCKDOWN_HOME, shouldRetryQuery, isExpertLockdownError } from "../src/features/expert-lockdown/guard.ts";
import { elPageAllowed } from "../src/features/expert-lockdown/api.ts";

const locked = { locked: true, allowedPages: [...EL_ALLOWED_PAGES] };

function assert(cond, msg) { if (!cond) throw new Error(msg); }

for (const p of ["/today", "/loan-applications", "/payment-orders", "/messengers", "/internal-chat", "/bale-bot"]) {
  assert(elPageAllowed(locked, p), `allowed ${p}`);
}
assert(elPageAllowed(locked, "/customers/123"), "customer page stays");
assert(elPageAllowed(locked, "/profile"), "profile stays");
assert(!elPageAllowed(locked, "/customers"), "customer list blocked");
assert(!elPageAllowed(locked, "/calls"), "calls blocked");
assert(!elPageAllowed(locked, "/sales-teams"), "sales-teams blocked");
assert(EL_LOCKDOWN_HOME === "/today", "home is /today");

assert(shouldRetryQuery(0, { status: 403, error: "expert_lockdown" }) === false, "lockdown 403 no retry");
assert(shouldRetryQuery(0, { status: 403 }) === false, "any 403 no retry");
assert(shouldRetryQuery(0, { status: 401 }) === false, "401 no retry");
assert(shouldRetryQuery(0, { status: 500 }) === true, "500 can retry");
assert(isExpertLockdownError({ status: 403, error: "expert_lockdown" }) === true, "is lockdown");
assert(isExpertLockdownError({ status: 403, error: "forbidden" }) === false, "other 403 is not lockdown-redirect material");

console.log("lockdown-redirect-fixture: ok");
