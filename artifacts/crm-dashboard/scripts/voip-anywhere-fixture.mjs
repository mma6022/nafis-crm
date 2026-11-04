// VOIP-ANYWHERE (t836u) UI rules: own allowed, other expert / admin / flag off → no button, registrar only under registrar_scope + server ids, one_call lock, first-call auto-open, single-button rule.
// Run: node --experimental-strip-types scripts/voip-anywhere-fixture.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VCA_LABEL, VCA_REDIAL_LABEL, vcaAutoOpen, vcaCanCall, vcaDetailButtons, vcaGate, vcaIncomingButton, vcaRowState, vcaSingleButton } from "../src/features/voip-call/anywhere-rules.ts";

let n = 0; const t = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };
const ON = { on: true, anywhere: true, oneCallButton: true, s132: { last: null }, call: null };
const expert8 = { id: 8, salespersonId: 6 };
const registrar = { id: 7, salespersonId: null };
const admin = { id: 1 };

t("own customer → button (row owner, server-confirmed own hit, own-ids answer)", () => {
  const g = vcaGate(ON, expert8); assert.equal(g.on, true); assert.equal(g.sp, 6);
  assert.equal(vcaCanCall(g, { customerId: 10, salespersonId: 6 }), true);
  assert.equal(vcaCanCall(g, { customerId: 10, own: true }), true);
  assert.equal(vcaCanCall(g, { customerId: 10, ownIds: new Set([10]) }), true);
});
t("another expert's customer → no button", () => {
  const g = vcaGate(ON, expert8);
  assert.equal(vcaCanCall(g, { customerId: 11, salespersonId: 5 }), false);
  assert.equal(vcaCanCall(g, { customerId: 11, salespersonId: null }), false, "unassigned is not own");
  assert.equal(vcaCanCall(g, { customerId: 11, ownIds: new Set([10]) }), false);
  assert.equal(vcaCanCall(g, { customerId: 11 }), false, "no owner info → no button");
  assert.equal(vcaCanCall(g, { customerId: 11, salespersonId: 6, own: false }), false);
});
t("registrar scope: user 7 gets «تماس» only for server-confirmed ids (registered / open filing / incoming grant), never via owner or own", () => {
  const RON = { ...ON, anywhereRegistrar: true };
  const g = vcaGate(RON, registrar); assert.equal(g.on, true); assert.equal(g.registrar, true);
  const mine = new Set([10]);
  assert.equal(vcaCanCall(g, { customerId: 10, ownIds: mine }), true, "server-confirmed");
  assert.equal(vcaCanCall(g, { customerId: 10, salespersonId: 4, ownIds: mine }), true, "expert-owned customer she is registrar of");
  assert.equal(vcaCanCall(g, { customerId: 11, salespersonId: 4, ownIds: mine }), false, "other expert's customer, not hers");
  assert.equal(vcaCanCall(g, { customerId: 11, own: true, ownIds: mine }), false, "an 'own' hint never widens her");
  assert.equal(vcaCanCall(g, { customerId: 10, ownIds: null }), false, "unknown → no button");
  // customer page: VoIP only for hers, otherwise today's system button; always one button
  assert.deepEqual(vcaDetailButtons(RON, g, mine, 10), { showVoip: true, showSystem: false, voipLabel: VCA_LABEL });
  assert.deepEqual(vcaDetailButtons(RON, g, mine, 11), { showVoip: false, showSystem: true });
  assert.deepEqual(vcaDetailButtons(RON, g, null, 10), { showVoip: false, showSystem: true });
  // experts unchanged on the customer page
  const ge = vcaGate(ON, expert8); assert.deepEqual(vcaDetailButtons(ON, ge, null, 11), { showVoip: true, showSystem: false, voipLabel: VCA_LABEL });
  assert.deepEqual(vcaDetailButtons({ on: true }, vcaGate({ on: true }, expert8), null, 11), { showVoip: true, showSystem: true });
  // server flag missing → registrar has no anywhere button (as before); an expert session never gets the registrar path
  assert.equal(vcaGate(ON, registrar).on, false);
  assert.equal(vcaGate(RON, expert8).registrar, undefined);
  assert.equal(vcaGate(RON, admin).registrar, true, "admin never receives anywhereRegistrar from the server (vcIsScopedRegistrar needs role registrar)");
});
t("registrar without registrar_scope and admins (no salesperson) → no button", () => {
  for (const u of [registrar, admin, null]) {
    const g = vcaGate(ON, u); assert.equal(g.on, false);
    assert.equal(vcaCanCall(g, { customerId: 10, own: true }), false);
    assert.equal(vcaCanCall(g, { customerId: 10, salespersonId: 6 }), false);
  }
});
t("flag off / voip off / no extension / s132 off → no button anywhere", () => {
  for (const me of [{ ...ON, anywhere: undefined }, { on: false }, { ...ON, on: false }, { ...ON, s132: undefined }, null, undefined]) {
    const g = vcaGate(me, expert8); assert.equal(g.on, false);
    for (const o of [{ customerId: 10, own: true }, { customerId: 10, salespersonId: 6 }, { customerId: 10, ownIds: new Set([10]) }]) assert.equal(vcaCanCall(g, o), false);
  }
});
t("one call at a time: another live / unsaved / first_form / waiting / s132b busy call → locked; same customer → mine", () => {
  const c = (o) => ({ ...ON, call: { id: 1, customerId: 99, state: "ended", active: false, needsResult: false, s132: null, ...o } });
  for (const st of ["requesting", "ring_me", "dial_cust", "in_call"]) assert.equal(vcaRowState(c({ state: st }), 10), "locked");
  assert.equal(vcaRowState(c({ needsResult: true }), 10), "locked");
  for (const ph of ["waiting", "late", "first_form"]) assert.equal(vcaRowState(c({ s132: { phase: ph } }), 10), "locked");
  assert.equal(vcaRowState({ ...ON, s132b: { busy: true } }, 10), "locked");
  assert.equal(vcaRowState(c({ state: "ended", s132: { phase: "auto" } }), 10), "idle", "a finished auto-saved call frees the button");
  assert.equal(vcaRowState(c({ state: "in_call" }), 99), "mine");
  assert.equal(vcaRowState(ON, 10), "idle");
});
t("first call (answered → first_form) auto-opens the mandatory form once, only for anywhere-started calls", () => {
  const g = vcaGate(ON, expert8);
  const me = { ...ON, call: { id: 5, customerId: 10, state: "ended", s132: { phase: "first_form" } } };
  assert.equal(vcaAutoOpen(me, g, new Set([5]), null), 5);
  assert.equal(vcaAutoOpen(me, g, new Set([5]), 5), null, "already shown");
  assert.equal(vcaAutoOpen(me, g, new Set(), null), null, "started elsewhere (Today / customer page own flows)");
  assert.equal(vcaAutoOpen(me, vcaGate({ ...ON, anywhere: undefined }, expert8), new Set([5]), null), null, "flag off");
});
t("non-first call never opens a form (auto / manual / live / waiting)", () => {
  const g = vcaGate(ON, expert8);
  for (const ph of ["auto", "manual", "live", "waiting", "late"]) assert.equal(vcaAutoOpen({ ...ON, call: { id: 6, customerId: 10, state: "ended", s132: { phase: ph } } }, g, new Set([6]), null), null);
  assert.equal(vcaAutoOpen({ ...ON, call: { id: 6, customerId: 10, state: "ended", s132: null } }, g, new Set([6]), null), null);
});
t("single-button rule: flag on + VoIP on → only «تماس», system hidden; flag off or no extension → unchanged", () => {
  assert.equal(VCA_LABEL, "تماس");
  assert.deepEqual(vcaSingleButton(ON), { showSystem: false, voipLabel: "تماس" });
  assert.deepEqual(vcaSingleButton({ on: true }), { showSystem: true });
  assert.deepEqual(vcaSingleButton({ on: false, oneCallButton: true }), { showSystem: true }, "no extension → off from /me");
  assert.deepEqual(vcaSingleButton(null), { showSystem: true });
});
t("design in_card / in_missed: no call button while the caller is on the line; «تماس دوباره» only after a missed call", () => {
  for (const kind of ["own", "new", "dup"]) assert.equal(vcaIncomingButton({ onLine: true, missed: false, kind }), null, `on line ${kind}`);
  assert.equal(vcaIncomingButton({ onLine: false, missed: true, kind: "new" }), "redial");
  assert.equal(vcaIncomingButton({ onLine: false, missed: true, kind: "own" }), "redial");
  assert.equal(vcaIncomingButton({ onLine: false, missed: true, kind: "dup" }), null, "duplicate card: no button");
  assert.equal(VCA_REDIAL_LABEL, "تماس دوباره");
});
t("design wiring: .vi row icons, lead cards, incoming cards, single button (flag off → today's DOM)", () => {
  const r = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  for (const p of ["pages/Customers.tsx", "features/site-leads/SiteLead.tsx", "features/call-queue/MyQueue.tsx", "features/smart-filing/SmartFilingJobs.tsx"])
    assert.match(r(p), /<VoipCallAnywhere [^>]*compact/, `${p}: row icon`);
  for (const p of ["features/site-leads/SiteLead.tsx", "features/smart-filing/SmartFilingJobs.tsx"]) {
    assert.match(r(p), /<VcaLeadCard /, `${p}: lead card with the full «تماس»`);
    assert.match(r(p), /boxOnMine=\{false\}/, `${p}: the card (not the row) shows the live call`);
  }
  assert.doesNotMatch(r("features/expert-lockdown/IncomingCall.tsx"), /VoipCallAnywhere/, "LockedInbound: customer on the line → no button");
  const iw = r("features/expert-lockdown/IncomingWizard.tsx");
  assert.match(iw, /vcaIncomingButton\(\{ onLine: !presetPhone, missed: Boolean\(presetPhone\), kind \}\) === 'redial'/);
  assert.equal((iw.match(/<VoipCallAnywhere /g) || []).length, 1);
  const va = r("features/voip-call/VoipAnywhere.tsx");
  assert.match(va, /className="vi"/); assert.match(va, /aria-disabled=\{lockedIc/); assert.match(va, /`تماس از تلفن ویپ با \$\{p\.customerName\}`/);
  assert.match(va, /<Lock size=\{20\}/, "closed icon = lock");
  assert.match(r("features/voip-call/voip-anywhere.css"), /\.vi\[aria-disabled=true\]/);
  const cd = r("pages/CustomerDetail.tsx");
  assert.match(cd, /const canCall = canCallRaw && oneBtn\.showSystem;/);
  assert.match(cd, /useDetailCallButtons\(customer\?\.id\)/); assert.match(cd, /oneBtn\.showVoip \? <div className="csx-vc">/);
  for (const f of ["pages/Customers.tsx", "features/site-leads/SiteLead.tsx"]) assert.match(r(f), /useVoipAnywhereRegistrarOwn\(/, f + " asks the server for registrar rows");
  assert.match(cd, /label=\{oneBtn\.voipLabel\}/);
  assert.match(r("features/smart-filing/SmartFilingJobs.tsx"), /vcaOwn\?\.has\(j\.customerId\) \?/, "row DOM unchanged while off");
  assert.match(r("features/site-leads/SiteLead.tsx"), /vcaRows\.length \? [\s\S]* : list\(false\)/, "site-lead panel unchanged while off");
  const vc = r("features/voip-call/VoipCall.tsx"); assert.match(vc, /label \|\| 'تماس از تلفن ویپ'/, "default label unchanged");
});
console.log(`PASS voip-anywhere: ${n} groups`);
