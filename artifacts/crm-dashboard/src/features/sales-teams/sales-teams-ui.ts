/** Team-builder UI (Armita sales-teams v1.1). DOM renderer used by the React page and the local shot fixture. */
export type IntakeSource = "new_customers" | "site_leads";
export type Member = {
  salespersonId: number; userId: number | null; displayName: string; avatarLetter: string;
  extension: string | null; extensionLabel: string; isLead: boolean;
  ownsNone: boolean; ownsP1: boolean; ownsP2: boolean; ownsP3: boolean; sortOrder: number; priorities: string[];
};
export type Team = { id: number; name: string; enabled: boolean; leadSalespersonId: number | null; leadName: string | null; members: Member[]; intakeSources: IntakeSource[] };
export type IntakeShareRow = { teamId: number; name: string; percent: number; enabled: boolean };
export type IntakeRow = { source: IntakeSource; label: string; teamIds: number[]; teams?: IntakeShareRow[]; sentence: string };
export type Person = { salespersonId: number; userId: number | null; displayName: string; avatarLetter: string; extension: string | null; extensionLabel: string; available: boolean; teamId: number | null; teamName: string | null; reason: string | null; isTrainee: boolean };
export type Me = { enabled: boolean; canManage: boolean; canDisable: boolean; canEnable: boolean; canView: boolean; readonly: boolean; userId: number | null; salespersonId: number | null; teamId: number | null; displayName: string; roleLabel: string };
export type Ticks = { ownsNone: boolean; ownsP1: boolean; ownsP2: boolean; ownsP3: boolean };
export type View =
  | "list" | "empty" | "create-name" | "create-members" | "create-priorities" | "create-review"
  | "err-unowned" | "err-duplicate" | "add-pick" | "add-priorities" | "add-review" | "lead-mark"
  | "deactivate" | "readonly" | "intake" | "intake-edit" | "intake-err" | "loading" | "error";

export type MountOpts = {
  root: HTMLElement;
  me: Me;
  chrome?: boolean;
  fixture?: boolean;
  actorHeader?: string;
  forcedScene?: View | null;
  apiPrefix?: string;
};

const FD = "۰۱۲۳۴۵۶۷۸۹";
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
const STEPS4 = ["نام", "اعضا", "اولویت‌ها", "بررسی"];
const STEPS3 = ["کارشناس", "اولویت‌ها", "بررسی"];
const NOTE_NEW = "تغییرها فقط برای مشتری جدید اعمال می‌شود. انتقال مشتری فعلی در کار نیست.";
const NOTE_PANEL = "با ثبت تیم، پنل این کارشناس‌ها به پنل تیم فروش تغییر می‌کند.";
const TRAINEE_NOTE = "این کارشناس از فهرست کارآموز خارج می‌شود و قاعدهٔ این تیم برایش اعمال می‌شود.";

type TickMap = Record<number, Ticks>;
type State = {
  view: View;
  loading: boolean;
  error: string | null;
  teams: Team[];
  intake: IntakeRow[];
  todayLabel: string;
  people: Person[];
  canManage: boolean;
  canDisable: boolean;
  name: string;
  selected: number[];
  ticks: TickMap;
  leadId: number | null;
  p1Order: number[];
  addTeamId: number | null;
  editTeamId: number | null;
  addSp: number | null;
  intakeDraft: Record<IntakeSource, Record<number, number>>;
  intakeError: Partial<Record<IntakeSource, string>>;
  disableTeamId: number | null;
  busy: boolean;
  formError: string | null;
};

function emptyTicks(): Ticks { return { ownsNone: false, ownsP1: false, ownsP2: false, ownsP3: false }; }
function p1Rotating(ticks: TickMap, ids: number[]) { return ids.filter((id) => ticks[id]?.ownsP1).length === 2; }
function priList(t: Ticks, rot: boolean): string[] {
  const out: string[] = [];
  if (t.ownsNone) out.push("بدون اولویت");
  if (t.ownsP1) out.push(rot ? "۱" : "۱");
  if (t.ownsP2) out.push("۲");
  if (t.ownsP3) out.push("۳");
  return out;
}
function priChip(label: string, rot: boolean) {
  const p1 = label === "۱" || label === "اولویت ۱، نوبتی";
  const text = label === "۱" && rot ? "اولویت ۱، نوبتی" : (label === "بدون اولویت" ? label : (label.startsWith("اولویت") ? label : "اولویت " + label));
  return `<span class="st-pri${p1 ? " p1" : ""}">${text}</span>`;
}
function templateOf(t: Ticks): "first" | "p1" | "" {
  if (t.ownsNone && !t.ownsP1 && t.ownsP2 && t.ownsP3) return "first";
  if (!t.ownsNone && t.ownsP1 && !t.ownsP2 && !t.ownsP3) return "p1";
  return "";
}
function validateTicks(ids: number[], ticks: TickMap, leadId: number | null): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (ids.length < 2 || ids.length > 4) errors.push({ field: "members", message: "هر تیم باید ۲ تا ۴ عضو داشته باشد." });
  if (leadId == null || !ids.includes(leadId)) errors.push({ field: "is_lead", message: "هر تیم باید دقیقاً یک سرپرست تیم داشته باشد." });
  const count = (k: keyof Ticks) => ids.filter((id) => ticks[id]?.[k]).length;
  const none = count("ownsNone"), p1 = count("ownsP1"), p2 = count("ownsP2"), p3 = count("ownsP3");
  if (none === 0) errors.push({ field: "owns_none", message: "بدون اولویت هنوز مسئول ندارد." });
  else if (none > 1) errors.push({ field: "owns_none", message: "بدون اولویت فقط برای یک نفر است." });
  if (p2 === 0) errors.push({ field: "owns_p2", message: "اولویت ۲ هنوز مسئول ندارد." });
  else if (p2 > 1) errors.push({ field: "owns_p2", message: "اولویت ۲ فقط برای یک نفر است." });
  if (p3 === 0) errors.push({ field: "owns_p3", message: "اولویت ۳ هنوز مسئول ندارد." });
  else if (p3 > 1) errors.push({ field: "owns_p3", message: "اولویت ۳ فقط برای یک نفر است." });
  if (p1 === 0) errors.push({ field: "owns_p1", message: "اولویت ۱ هنوز مسئول ندارد." });
  else if (p1 > 2) errors.push({ field: "owns_p1", message: "اولویت ۱ حداکثر برای دو نفر است." });
  return errors;
}
function memberPayload(ids: number[], ticks: TickMap, leadId: number | null, p1Order: number[]) {
  const p1s = p1Order.filter((id) => ids.includes(id) && ticks[id]?.ownsP1);
  return ids.map((id, i) => {
    const t = ticks[id] || emptyTicks();
    const p1i = p1s.indexOf(id);
    return {
      salespersonId: id, isLead: id === leadId, ownsNone: t.ownsNone, ownsP1: t.ownsP1, ownsP2: t.ownsP2, ownsP3: t.ownsP3,
      sortOrder: t.ownsP1 && p1i >= 0 ? p1i : i,
    };
  });
}

export function mountSalesTeams(opts: MountOpts): () => void {
  const root = opts.root;
  const apiPrefix = opts.apiPrefix ?? "/api";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.actorHeader) headers["x-actor"] = opts.actorHeader;

  async function api(path: string, init?: RequestInit) {
    const r = await fetch(apiPrefix + path, { credentials: "include", ...init, headers: { ...headers, ...(init?.headers as Record<string, string> || {}) } });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!r.ok) {
      const err = Object.assign(new Error(body?.message || "فهرست تیم‌ها الآن نیامد"), { status: r.status, body });
      throw err;
    }
    return body;
  }

  const st: State = {
    view: "loading", loading: true, error: null, teams: [], intake: [], todayLabel: "", people: [],
    canManage: opts.me.canManage, canDisable: opts.me.canDisable,
    name: "", selected: [], ticks: {}, leadId: null, p1Order: [], addTeamId: null, editTeamId: null, addSp: null,
    intakeDraft: { new_customers: { 1: 100, 2: 0 }, site_leads: { 1: 100, 2: 0 } }, intakeError: {}, disableTeamId: null, busy: false, formError: null,
  };

  function person(id: number): Person | undefined { return st.people.find((p) => p.salespersonId === id); }
  function personName(id: number) { return person(id)?.displayName || `کارشناس ${fd(id)}`; }
  function personExt(id: number) { return person(id)?.extensionLabel || "داخلی ندارد"; }
  function findTeam(id: number) { return st.teams.find((t) => t.id === id); }
  function isAvailable(id: number) { return Boolean(person(id)?.available); }
  function validSelected() { return st.selected.filter(isAvailable); }
  const enDigit = (v: string) => String(v).replace(/[۰-۹]/g, (d) => String(FD.indexOf(d)));
  function readPct(v: string | number) {
    const n = Number.parseInt(enDigit(String(v ?? "0")) || "0", 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > 100 ? 100 : n;
  }
  function intakeSum(percents: Record<number, number>) {
    return Object.values(percents).reduce((n, v) => n + (Number(v) || 0), 0);
  }
  function sumError(source: IntakeSource, sum: number) {
    const label = source === "site_leads" ? "لید فرم سایت" : "مشتری جدید";
    return `جمع درصدهای ${label} ${fd(sum)}٪ است؛ باید ۱۰۰٪ باشد.`;
  }
  function sourceLabel(source: IntakeSource) {
    return source === "site_leads" ? "لید فرم سایت" : "مشتری جدید";
  }

  function go(view: View) { st.view = view; st.formError = null; render(); }
  function ticksFromMember(m: Member): Ticks { return { ownsNone: m.ownsNone, ownsP1: m.ownsP1, ownsP2: m.ownsP2, ownsP3: m.ownsP3 }; }

  function startCreate() {
    st.name = ""; st.selected = []; st.ticks = {}; st.leadId = null; st.p1Order = []; st.editTeamId = null;
    go("create-name");
  }
  function startEdit(team: Team) {
    st.editTeamId = team.id; st.addTeamId = null; st.name = team.name;
    st.selected = team.members.map((m) => m.salespersonId);
    st.ticks = Object.fromEntries(team.members.map((m) => [m.salespersonId, ticksFromMember(m)]));
    st.leadId = team.leadSalespersonId;
    st.p1Order = team.members.filter((m) => m.ownsP1).sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.salespersonId);
    go("lead-mark");
  }
  function startAdd(team: Team) {
    st.addTeamId = team.id; st.editTeamId = null; st.addSp = null;
    st.ticks = { 0: emptyTicks() } as TickMap; st.leadId = null; st.p1Order = [];
    go("add-pick");
  }

  function setTick(id: number, key: keyof Ticks, on: boolean) {
    const cur = { ...(st.ticks[id] || emptyTicks()), [key]: on };
    st.ticks[id] = cur;
    if (key === "ownsP1") {
      if (on && !st.p1Order.includes(id)) st.p1Order = [...st.p1Order, id];
      if (!on) st.p1Order = st.p1Order.filter((x) => x !== id);
    }
  }
  function applyTemplate(id: number, which: "first" | "p1") {
    const cur = emptyTicks();
    if (which === "first") { cur.ownsNone = true; cur.ownsP2 = true; cur.ownsP3 = true; }
    else cur.ownsP1 = true;
    const wasP1 = st.ticks[id]?.ownsP1;
    st.ticks[id] = cur;
    if (cur.ownsP1 && !wasP1 && !st.p1Order.includes(id)) st.p1Order = [...st.p1Order, id];
    if (!cur.ownsP1) st.p1Order = st.p1Order.filter((x) => x !== id);
    if (which === "first" && st.leadId == null) st.leadId = id;
  }

  function usersHref() {
    const resume = st.view;
    const ret = `/sales-teams?resume=${encodeURIComponent(resume)}`;
    try { sessionStorage.setItem("nafis.sales-teams.wizard", JSON.stringify({ view: st.view, name: st.name, selected: st.selected, ticks: st.ticks, leadId: st.leadId, p1Order: st.p1Order, addTeamId: st.addTeamId, editTeamId: st.editTeamId, addSp: st.addSp })); } catch { /* ignore */ }
    return `/users?return=${encodeURIComponent(ret)}&new=1`;
  }

  function titleOf(view: View): [string, string] {
    const map: Record<View, [string, string]> = {
      list: ["تیم‌های فروش", ""], empty: ["تیم‌های فروش", ""],
      "create-name": ["تیم جدید", "مرحلهٔ ۱ از ۴"], "create-members": ["تیم جدید", "مرحلهٔ ۲ از ۴"],
      "create-priorities": ["تیم جدید", "مرحلهٔ ۳ از ۴"], "create-review": ["تیم جدید", "مرحلهٔ ۴ از ۴"],
      "err-unowned": ["تیم جدید", "مرحلهٔ ۳ از ۴"], "err-duplicate": ["تیم جدید", "مرحلهٔ ۳ از ۴"],
      "add-pick": ["عضو جدید", "مرحلهٔ ۱ از ۳"], "add-priorities": ["عضو جدید", "مرحلهٔ ۲ از ۳"], "add-review": ["عضو جدید", "مرحلهٔ ۳ از ۳"],
      "lead-mark": ["سرپرست تیم", ""], deactivate: ["تیم‌های فروش", ""], readonly: ["تیم من", ""],
      intake: ["تقسیم مشتری جدید", ""], "intake-edit": ["تقسیم مشتری جدید", "ویرایش"], "intake-err": ["تقسیم مشتری جدید", "ویرایش"],
      loading: ["تیم‌های فروش", ""], error: ["تیم‌های فروش", ""],
    };
    if (opts.me.readonly && (view === "list" || view === "readonly")) return ["تیم من", ""];
    return map[view];
  }

  const prog = (labels: string[], now: number) =>
    `<nav class="st-prog" aria-label="پیشرفت"><ol>${labels.map((lb, i) => `<li class="${i < now ? "done" : i === now ? "now" : ""}"><i></i><span>${fd(i + 1)}. ${lb}</span></li>`).join("")}</ol></nav>`;

  function wizActs(back: string | null, nextLabel: string, disabled: boolean, nextAction: string, cancelList = false) {
    const backBtn = back
      ? `<button class="btn gh" type="button" data-act="${back}">قبلی</button>`
      : `<button class="btn gh" type="button" data-act="${cancelList ? "list" : "list"}">انصراف</button>`;
    return `<div class="st-wiz-acts"><div class="st-row">${backBtn}<button class="btn pri" type="button" data-act="${nextAction}"${disabled ? " aria-disabled=\"true\" disabled" : ""}>${nextLabel}</button></div></div>`;
  }

  function expertBtn(p: Person, pressed: boolean) {
    const on = Boolean(p.available && pressed);
    const badge = p.isTrainee ? '<span class="st-badge trn">کارآموز</span>' : "";
    return `<li><button class="st-ex" type="button" data-act="toggle-person" data-id="${p.salespersonId}" ${p.available ? "" : "disabled aria-disabled=\"true\""} aria-pressed="${on ? "true" : "false"}"><span class="st-ex-main"><span class="st-ex-id"><b>${p.displayName}</b>${badge}</span><small>${p.extensionLabel}${p.reason ? "؛ " + p.reason : ""}</small></span></button></li>`;
  }

  function tmpRow(active: "first" | "p1" | "", id: number) {
    return `<div class="st-tmps" aria-label="قالب سریع"><button class="st-tmp" type="button" data-act="tmp" data-id="${id}" data-tmp="first" aria-pressed="${active === "first" ? "true" : "false"}">تماس اول</button><button class="st-tmp" type="button" data-act="tmp" data-id="${id}" data-tmp="p1" aria-pressed="${active === "p1" ? "true" : "false"}">اولویت ۱</button></div>`;
  }
  function tog(t: Ticks, rot: boolean, id: number) {
    const items: [keyof Ticks, string][] = [["ownsNone", "بدون اولویت"], ["ownsP1", "۱"], ["ownsP2", "۲"], ["ownsP3", "۳"]];
    return `<div class="st-tog" role="group" aria-label="اولویت‌ها">${items.map(([k, lb]) => {
      const on = t[k];
      const label = k === "ownsP1" && rot && on ? "اولویت ۱، نوبتی" : (lb === "بدون اولویت" ? lb : "اولویت " + lb);
      return `<button type="button" data-act="tick" data-id="${id}" data-k="${k}" aria-pressed="${on ? "true" : "false"}">${label}</button>`;
    }).join("")}</div>`;
  }
  function mcard(id: number) {
    const t = st.ticks[id] || emptyTicks();
    const rot = p1Rotating(st.ticks, st.view.startsWith("add-") ? [id, ...(findTeam(st.addTeamId || 0)?.members.map((m) => m.salespersonId) || [])] : st.selected);
    return `<article class="card st-mcard"><div class="st-mcard-hd"><div><h3>${personName(id)}</h3><p class="st-who"><span>${personExt(id)}</span></p></div><label class="st-lead"><input type="radio" name="st-lead" data-act="lead" data-id="${id}" ${st.leadId === id ? "checked" : ""}><i aria-hidden="true"></i>سرپرست تیم</label></div>${tmpRow(templateOf(t), id)}${tog(t, rot && t.ownsP1, id)}</article>`;
  }

  function memRow(m: Member, leadId: number | null, rot: boolean) {
    return `<li class="st-mem"><div class="st-who"><b>${m.displayName}</b><span>${leadId === m.salespersonId ? "سرپرست تیم؛ " : ""}${m.extensionLabel}</span></div><div class="st-pris">${m.priorities.map((t) => priChip(t, rot && m.ownsP1)).join("")}</div></li>`;
  }
  function teamCard(t: Team, ro: boolean, canOff: boolean) {
    const rot = t.members.filter((m) => m.ownsP1).length === 2;
    return `<article class="card st-team">
      <div class="st-team-hd"><div><h3>${t.name}</h3><p class="st-meta">سرپرست: ${t.leadName ?? "—"}</p></div><span class="st-badge ${t.enabled ? "on" : "off"}">${t.enabled ? "فعال" : "غیرفعال"}</span>${ro ? '<span class="st-badge ro">فقط مشاهده</span>' : ""}</div>
      <ul class="st-mems">${t.members.map((m) => memRow(m, t.leadSalespersonId, rot)).join("")}</ul>
      ${ro || !st.canManage ? "" : `<div class="st-card-acts"><div class="st-row"><button class="btn pri" type="button" data-act="add" data-id="${t.id}" ${t.enabled ? "" : "disabled"}>عضو جدید</button><button class="btn gh" type="button" data-act="edit" data-id="${t.id}">ویرایش</button></div>${canOff ? `<div class="st-row"><button class="btn lk" type="button" data-act="deactivate" data-id="${t.id}" style="color:var(--nf-danger)">${t.enabled ? "غیرفعال کردن" : "فعال کردن"}</button></div>` : ""}</div>`}
    </article>`;
  }
  function intakeCard(editHref = true) {
    if (!st.canManage || !st.intake.length) return "";
    const lines = st.intake.map((r) => `<p class="st-sent">${r.sentence}</p>`).join("");
    return `<section class="card st-intake st-section" aria-label="تقسیم مشتری جدید"><h3>تقسیم مشتری جدید</h3>${lines}<div class="st-actions"><button class="btn ${editHref ? "gh" : "pri"}" type="button" data-act="intake-edit">ویرایش</button></div></section>`;
  }

  function reviewLines(ids: number[]) {
    const rot = p1Rotating(st.ticks, ids);
    const p1s = st.p1Order.filter((id) => ids.includes(id) && st.ticks[id]?.ownsP1);
    return ids.map((id) => {
      const t = st.ticks[id] || emptyTicks();
      const labels = priList(t, rot).map((lb) => lb === "۱" && rot ? "اولویت ۱، نوبتی" : (lb === "بدون اولویت" ? lb : "اولویت " + lb));
      const extra = (t.ownsP1 && rot && p1s[0] === id && p1s[1]) ? ` (${personName(id).replace(/^خانم |^آقای /, "")}، سپس ${personName(p1s[1]).replace(/^خانم |^آقای /, "")})` : "";
      void extra;
      const lead = st.leadId === id ? "سرپرست تیم؛ " : "";
      return `<li><b>${personName(id)}</b>؛ ${lead}${personExt(id)}؛ ${labels.join("، ")}</li>`;
    }).join("");
  }

  function loseForAdd(): string[] {
    const team = findTeam(st.addTeamId || 0);
    const t = st.ticks[st.addSp || 0];
    if (!team || !t) return [];
    const lines: string[] = [];
    const chk = (on: boolean, pred: (m: Member) => boolean, label: string) => {
      if (!on) return;
      const prev = team.members.find(pred);
      if (prev) lines.push(`${label} از ${prev.displayName} گرفته می‌شود.`);
    };
    chk(t.ownsNone, (m) => m.ownsNone, "بدون اولویت");
    chk(t.ownsP2, (m) => m.ownsP2, "اولویت ۲");
    chk(t.ownsP3, (m) => m.ownsP3, "اولویت ۳");
    return lines;
  }

  function draftFromIntake(intake: IntakeRow[]): Record<IntakeSource, Record<number, number>> {
    const out: Record<IntakeSource, Record<number, number>> = { new_customers: {}, site_leads: {} };
    for (const t of st.teams) {
      out.new_customers[t.id] = t.id === 1 ? 100 : 0;
      out.site_leads[t.id] = t.id === 1 ? 100 : 0;
    }
    for (const row of intake) {
      const map: Record<number, number> = {};
      if (row.teams?.length) for (const t of row.teams) map[t.teamId] = t.percent;
      else for (const id of row.teamIds || []) map[id] = 0;
      if (row.teams?.length || row.teamIds?.length) out[row.source] = { ...out[row.source], ...map };
    }
    return out;
  }
  function viewHtml(view: View): string {
    const ro = !st.canManage || view === "readonly";
    if (view === "loading") return `<div class="st-head"><div><h2>${ro ? "تیم من" : "تیم‌های فروش"}</h2></div></div><div class="st-skel" role="status" aria-live="polite"><span class="sr-only">در حال بارگذاری</span><i></i><i></i></div>`;
    if (view === "error") return `<div class="st-head"><div><h2>تیم‌های فروش</h2></div></div><section class="card st-state" role="alert"><h2>فهرست تیم‌ها الآن نیامد</h2><p>چیزی عوض نشد.</p><button class="btn pri" type="button" data-act="reload">تلاش دوباره</button></section>`;
    if (view === "empty") return `<div class="st-head"><div><h2>تیم‌های فروش</h2></div></div><section class="card st-empty"><h2>هنوز تیمی ساخته نشده است</h2><p>تیم بین ۲ تا ۴ کارشناس دارد.</p>${st.canManage ? '<button class="btn pri" type="button" data-act="create">تیم جدید</button>' : ""}</section>`;
    if (view === "list" || view === "readonly") {
      const title = ro ? "تیم من" : "تیم‌های فروش";
      const head = `<div class="st-head"><div><h2>${title}</h2>${ro ? "" : `<p>${st.todayLabel}</p>`}</div>${st.canManage ? '<div class="st-actions"><button class="btn pri" type="button" data-act="create">تیم جدید</button></div>' : ""}</div>`;
      return `${head}${st.canManage ? intakeCard() : ""}<div class="st-cards">${st.teams.map((t) => teamCard(t, ro, st.canDisable)).join("")}</div>`;
    }
    if (view === "create-name") return `<div class="st-wiz">${prog(STEPS4, 0)}<h2>نام تیم</h2><p class="st-help">نامی که در فهرست و تقسیم مشتری دیده می‌شود.</p><div class="st-field"><label for="st-name">نام تیم</label><input class="inp" id="st-name" value="${escapeAttr(st.name)}" autocomplete="off"></div>${wizActs(null, "بعدی", false, "to-members")}</div>`;
    if (view === "create-members") {
      const valid = validSelected();
      const n = valid.length;
      const traineeOn = valid.some((id) => person(id)?.isTrainee);
      return `<div class="st-wiz">${prog(STEPS4, 1)}<h2>اعضای تیم</h2><p class="st-help">بین ۲ تا ۴ کارشناس فعال که هنوز در تیمی نیستند.</p><p class="st-count">${fd(n)} نفر انتخاب شده‌اند؛ حداکثر ۴ نفر.</p><ul class="st-pick">${st.people.map((p) => expertBtn(p, valid.includes(p.salespersonId))).join("")}</ul>${traineeOn ? `<p class="st-note">${TRAINEE_NOTE}</p>` : ""}<p><a class="st-link" href="${usersHref()}">اگر این فرد حساب ندارد، ساخت کاربر جدید</a></p>${wizActs("create-name", "بعدی", n < 2 || n > 4, "to-priorities")}</div>`;
    }
    if (view === "create-priorities" || view === "err-unowned" || view === "err-duplicate") {
      const errs = validateTicks(st.selected, st.ticks, st.leadId);
      const msg = st.formError || errs[0]?.message;
      return `<div class="st-wiz">${prog(STEPS4, 2)}<h2>اولویت هر عضو</h2><p class="st-help">قالب‌ها فقط انتخاب سریع‌اند؛ نقش ثابتی نیست.</p>${msg ? `<p class="st-err" role="alert">${msg}</p>` : ""}<div class="st-mcards">${st.selected.map(mcard).join("")}</div>${wizActs("create-members", "بعدی", errs.length > 0, "to-review")}</div>`;
    }
    if (view === "create-review") {
      return `<div class="st-wiz">${prog(STEPS4, 3)}<h2>بررسی و ثبت</h2><p class="st-help">نام تیم: ${st.name}</p><ul class="st-rev">${reviewLines(st.selected)}</ul><p class="st-note">${NOTE_NEW}</p><p class="st-note">${NOTE_PANEL}</p>${wizActs("create-priorities", st.editTeamId ? "ثبت" : "ثبت تیم", false, "save-create")}</div>`;
    }
    if (view === "add-pick") {
      const team = findTeam(st.addTeamId || 0);
      const sel = st.addSp ? person(st.addSp) : null;
      return `<div class="st-wiz">${prog(STEPS3, 0)}<h2>انتخاب کارشناس</h2><p class="st-help">افزودن به ${team?.name ?? "تیم"}. فقط کارشناس فعالِ بدون تیم.</p><ul class="st-pick">${st.people.map((p) => expertBtn(p, st.addSp === p.salespersonId)).join("")}</ul>${sel?.isTrainee ? `<p class="st-note">${TRAINEE_NOTE}</p>` : ""}<p><a class="st-link" href="${usersHref()}">اگر این فرد حساب ندارد، ساخت کاربر جدید</a></p>${wizActs("list", "بعدی", !st.addSp, "to-add-pri")}</div>`;
    }
    if (view === "add-priorities") {
      const id = st.addSp!;
      return `<div class="st-wiz">${prog(STEPS3, 1)}<h2>اولویت عضو تازه</h2><p class="st-help">${personName(id)}؛ ${personExt(id)}</p>${st.formError ? `<p class="st-err" role="alert">${st.formError}</p>` : ""}<div class="st-mcards">${mcard(id)}</div>${wizActs("add-pick", "بعدی", false, "to-add-review")}</div>`;
    }
    if (view === "add-review") {
      const id = st.addSp!;
      const t = st.ticks[id] || emptyTicks();
      const labels = priList(t, false).map((lb) => lb === "بدون اولویت" ? lb : "اولویت " + lb);
      const team = findTeam(st.addTeamId || 0);
      const sel = person(id);
      const lose = loseForAdd();
      return `<div class="st-wiz">${prog(STEPS3, 2)}<h2>بررسی و ثبت</h2><ul class="st-rev"><li><b>${personName(id)}</b> به ${team?.name ?? "تیم"} اضافه می‌شود؛ ${personExt(id)}؛ ${labels.join("، ")}</li></ul>${lose.map((l) => `<p class="st-lose">${l}</p>`).join("")}${sel?.isTrainee ? `<p class="st-note">${TRAINEE_NOTE}</p>` : ""}<p class="st-note">${NOTE_NEW}</p><p class="st-note">${NOTE_PANEL}</p>${wizActs("add-priorities", "ثبت", false, "save-add")}</div>`;
    }
    if (view === "lead-mark") {
      const team = findTeam(st.editTeamId || 0);
      const errs = validateTicks(st.selected, st.ticks, st.leadId);
      return `<div class="st-wiz"><h2>سرپرست ${team?.name ?? st.name}</h2><p class="st-help">در هر تیم فقط یک سرپرست است.</p>${errs[0] ? `<p class="st-err" role="alert">${errs[0].message}</p>` : ""}<div class="st-mcards">${st.selected.map(mcard).join("")}</div><p class="st-note">${NOTE_NEW}</p><div class="st-wiz-acts"><div class="st-row"><button class="btn gh" type="button" data-act="list">انصراف</button><button class="btn pri" type="button" data-act="save-edit" ${errs.length ? "disabled aria-disabled=\"true\"" : ""}>ثبت</button></div></div></div>`;
    }
    if (view === "intake" || view === "intake-edit" || view === "intake-err") {
      const ro = view === "intake";
      const live = !ro;
      const enabledTeams = st.teams.filter((t) => t.enabled);
      const srcBox = (source: IntakeSource) => {
        const percents = st.intakeDraft[source] || {};
        const sum = intakeSum(percents);
        const bad = sum !== 100;
        const errText = st.intakeError[source] || (live && bad ? sumError(source, sum) : "");
        const rows = enabledTeams.map((t) => {
          const val = percents[t.id] ?? 0;
          const zero = val === 0;
          const id = `st-pct-${source}-${t.id}`;
          return `<div class="st-pct-row${zero ? " muted" : ""}"><div class="st-pct-who"><span class="st-pct-name">${t.name}</span>${zero ? '<span class="st-noshr">بدون سهم ورودی</span>' : ""}</div><label class="st-pct"><span class="sr-only">درصد ${t.name}</span><input id="${id}" class="st-pct-in" dir="ltr" inputmode="numeric" maxlength="3" value="${fd(val)}" ${ro ? "readonly" : ""} aria-label="درصد ${t.name}" data-act="intake-percent" data-source="${source}" data-id="${t.id}"><span class="st-pct-suf" aria-hidden="true">٪</span></label></div>`;
        }).join("");
        return `<section class="card st-src" data-src="${source}"${live ? ' data-live="1"' : ""}><h3>${sourceLabel(source)}</h3>${rows}<p class="st-total${bad ? " bad" : ""}" data-sum>جمع: ${fd(sum)}٪</p>${errText ? `<p class="st-err" role="alert">${errText}</p>` : ""}</section>`;
      };
      if (ro) {
        return `<div class="st-head"><div><h2>تقسیم مشتری جدید</h2></div></div><div class="st-wiz">${srcBox("new_customers")}${srcBox("site_leads")}<div class="st-wiz-acts"><div class="st-row"><button class="btn pri" type="button" data-act="intake-edit">ویرایش</button></div></div></div>`;
      }
      const sums = (["new_customers", "site_leads"] as IntakeSource[]).map((source) => {
        const sum = intakeSum(st.intakeDraft[source] || {});
        const bad = sum !== 100;
        const err = st.intakeError[source] || (bad ? sumError(source, sum) : "");
        return { source, sum, bad, err };
      });
      const allOk = sums.every((x) => !x.bad);
      const footRows = sums.map((x) => `<p class="${x.bad ? "st-total bad" : "st-total"}" data-foot="${x.source}">${sourceLabel(x.source)}، جمع: ${fd(x.sum)}٪</p>${x.err ? `<p class="st-err" role="alert">${x.err}</p>` : ""}`).join("");
      return `<div class="st-wiz"><h2>ویرایش تقسیم</h2><p class="st-help">برای هر منبع، درصد هر تیم فعال را با عدد درست وارد کنید. جمع هر منبع باید ۱۰۰٪ باشد.</p>${srcBox("new_customers")}${srcBox("site_leads")}<div class="st-intake-foot is-sticky"><div class="st-foot-sums">${footRows}</div><div class="st-row"><button class="btn gh" type="button" data-act="intake">انصراف</button><button class="btn pri" type="button" data-act="save-intake" id="st-save" ${allOk ? "" : "disabled aria-disabled=\"true\""}>ثبت</button></div></div></div>`;
    }
    if (view === "deactivate") {
      const team = findTeam(st.disableTeamId || 0);
      const blocked = Boolean(team && team.intakeSources.length);
      const list = viewHtml("list");
      const title = team?.enabled ? `غیرفعال کردن ${team?.name ?? "تیم"}` : `فعال کردن ${team?.name ?? "تیم"}`;
      const body = blocked
        ? `<p class="st-err" id="st-off-d" role="alert">${st.formError || "این تیم در تقسیم مشتری جدید یا لید فرم سایت بیش از ۰٪ دارد. تا وقتی سهمش ۰٪ نشود، تیم غیرفعال نمی‌شود."}</p><div class="st-row"><button class="btn gh" type="button" data-act="list">انصراف</button><button class="btn pri" type="button" data-act="intake">رفتن به تقسیم مشتری جدید</button></div>`
        : team && !team.enabled
          ? `<p id="st-off-d">تیم غیرفعال دوباره فعال می‌شود؟ اگر عضوی به تیم دیگری رفته باشد باید دوباره انتخاب شود.</p><div class="st-row"><button class="btn gh" type="button" data-act="list">انصراف</button><button class="btn pri" type="button" data-act="do-enable">فعال کردن</button></div>`
          : `<p id="st-off-d">با غیرفعال شدن، عضویت تمام می‌شود و مشتری‌های فعلی پیش همان کارشناس می‌مانند.</p><div class="st-row"><button class="btn gh" type="button" data-act="list">انصراف</button><button class="btn dang" type="button" data-act="do-disable">غیرفعال کردن</button></div>`;
      return `${list}<div class="st-scrim" aria-hidden="true"></div><div class="st-modal card" role="dialog" aria-modal="true" aria-labelledby="st-off-t" aria-describedby="st-off-d"><h2 id="st-off-t">${title}</h2>${body}</div>`;
    }
    return viewHtml("list");
  }

  function escapeAttr(s: string) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  function chromeWrap(inner: string) {
    if (!opts.chrome) return `<main class="st-page">${inner}</main>`;
    const [t0, t1] = titleOf(st.view);
    const ro = !st.canManage || st.view === "readonly";
    const ME = { n: opts.me.displayName || opts.me.roleLabel, a: (opts.me.displayName || opts.me.roleLabel || "؟").trim()[0] || "؟", r: opts.me.roleLabel };
    const I = (id: string) => `<svg class="i" aria-hidden="true"><use href="#${id}"></use></svg>`;
    const NAV: Record<string, [string, string]> = { today: ["i-today", "امروز"], cust: ["i-users", "مشتریان"], files: ["i-file", "پرونده‌ها"], rem: ["i-bell", "یادآورها"], msg: ["i-send", "پیام‌رسان‌ها"], team: ["i-chat", "داخلی"], ast: ["i-bot", "دستیار"], more: ["i-grid", "بیشتر"] };
    const dkItem = (k: string) => `<li><a class="dk-i" href="#${k}" aria-label="${NAV[k][1]}"${k === "more" ? ' aria-current="page"' : ""}><span class="dk-ic">${I(NAV[k][0])}</span><span class="dk-lb" aria-hidden="true">${NAV[k][1]}</span><span class="dk-tip" aria-hidden="true">${NAV[k][1]}</span></a></li>`;
    const dock = `<nav class="dock" aria-label="بخش‌های اصلی"><ul class="dk-g">${["today", "cust", "files", "rem"].map(dkItem).join("")}</ul><a class="dk-p" href="#new"><span class="pi">${I("i-plus")}</span>الان مشتری جدید دارم</a><ul class="dk-g">${["msg", "team", "ast", "more"].map(dkItem).join("")}</ul></nav>`;
    const tabbar = `<nav class="tb" aria-label="بخش‌های اصلی">${[["today"], ["cust"], ["new", "i-plus", "مشتری جدید"], ["files"], ["more"]].map(([k, ic, t]) => `<a class="tb-i" href="#${k}" aria-label="${t || NAV[k][1]}"${k === "more" ? ' aria-current="page"' : ""}><span class="tb-ic">${I((ic as string) || NAV[k][0])}</span><span aria-hidden="true">${t || NAV[k][1]}</span></a>`).join("")}</nav>`;
    const mobile = (typeof window !== "undefined") && (window.matchMedia("(max-width:1023.98px)").matches || window.innerWidth < 1024);
    const top = `<header class="top"><div class="top-in">
 <a class="brand" href="#home" aria-label="گروه مالی نفیس، ${ro ? "پنل کارشناس" : "پنل مشتریان"}"><span class="logo" aria-hidden="true"></span><small>${ro ? "پنل کارشناس" : "پنل مشتریان"}</small></a>
 <div class="ttl"><h1>${t0}</h1>${t1 ? `<p>${t1}</p>` : ""}</div>
 <div class="acts-top">${ro ? `<span class="lkchip" role="note" aria-label="پنل محدود">${I("i-lock")}<span class="lt" aria-hidden="true">پنل محدود</span></span>` : ""}<span class="stx" title="پشتیبانی تیم">در دسترس</span>
  <button class="me" type="button" aria-label="${ME.n}، ${ME.r}: حساب کاربری" aria-haspopup="menu"><span class="nm">${ME.n}</span><span class="av">${ME.a}</span></button>
 </div></div></header>`;
    return `${top}<main class="pg st-page">${inner}</main>${mobile ? tabbar : dock}`;
  }

  function render() {
    let view = st.view;
    if (view === "list" && !st.loading && !st.teams.length && st.canManage) view = "empty";
    root.innerHTML = chromeWrap(viewHtml(view));
    const nameInp = root.querySelector<HTMLInputElement>("#st-name");
    if (nameInp) {
      nameInp.addEventListener("input", () => { st.name = nameInp.value; });
      nameInp.focus();
      nameInp.selectionStart = nameInp.value.length;
    }
    root.querySelectorAll<HTMLInputElement>("input[data-act=intake-percent]:not([readonly])").forEach((inp) => {
      inp.addEventListener("input", () => {
        const source = inp.getAttribute("data-source") as IntakeSource;
        const id = Number(inp.getAttribute("data-id"));
        if (!source || !id) return;
        let raw = enDigit(inp.value).replace(/[^0-9]/g, "").slice(0, 3);
        if (Number.parseInt(raw || "0", 10) > 100) raw = "100";
        const n = readPct(raw || "0");
        inp.value = fd(raw || "0");
        st.intakeDraft[source] = { ...st.intakeDraft[source], [id]: n };
        delete st.intakeError[source];
        const box = inp.closest(".st-src");
        const row = inp.closest(".st-pct-row");
        if (row) {
          row.classList.toggle("muted", n === 0);
          const who = row.querySelector(".st-pct-who");
          let tag = row.querySelector(".st-noshr");
          if (n === 0 && !tag && who) who.insertAdjacentHTML("beforeend", '<span class="st-noshr">بدون سهم ورودی</span>');
          else if (n !== 0 && tag) tag.remove();
        }
        const sum = intakeSum(st.intakeDraft[source] || {});
        const ok = sum === 100;
        const tot = box?.querySelector("[data-sum]");
        if (tot) { tot.textContent = `جمع: ${fd(sum)}٪`; tot.classList.toggle("bad", !ok); }
        let err = box?.querySelector(".st-err");
        const msg = ok ? "" : (st.intakeError[source] || sumError(source, sum));
        if (msg) {
          if (!err) { box?.insertAdjacentHTML("beforeend", `<p class="st-err" role="alert">${msg}</p>`); err = box?.querySelector(".st-err"); }
          else err.textContent = msg;
          (err as HTMLElement).hidden = false;
        } else if (err) err.remove();
        const foot = root.querySelector(`[data-foot="${source}"]`);
        if (foot) { foot.textContent = `${sourceLabel(source)}، جمع: ${fd(sum)}٪`; foot.classList.toggle("bad", !ok); foot.classList.add("st-total"); }
        const allOk = intakeSum(st.intakeDraft.new_customers) === 100 && intakeSum(st.intakeDraft.site_leads) === 100;
        const footErrs = root.querySelectorAll(".st-intake-foot .st-err");
        footErrs.forEach((el) => {
          const prev = el.previousElementSibling as HTMLElement | null;
          const src = prev?.getAttribute("data-foot") as IntakeSource | null;
          if (!src) return;
          const ssum = intakeSum(st.intakeDraft[src] || {});
          if (ssum === 100) el.remove();
          else el.textContent = st.intakeError[src] || sumError(src, ssum);
        });
        (["new_customers", "site_leads"] as IntakeSource[]).forEach((src) => {
          const ssum = intakeSum(st.intakeDraft[src] || {});
          if (ssum === 100) return;
          const footSum = root.querySelector(`[data-foot="${src}"]`);
          if (footSum && !footSum.nextElementSibling?.classList.contains("st-err")) {
            footSum.insertAdjacentHTML("afterend", `<p class="st-err" role="alert">${st.intakeError[src] || sumError(src, ssum)}</p>`);
          }
        });
        const save = root.querySelector<HTMLButtonElement>("[data-act=save-intake]");
        if (save) {
          save.disabled = !allOk;
          if (allOk) save.removeAttribute("aria-disabled");
          else save.setAttribute("aria-disabled", "true");
        }
      });
    });
  }

  async function onClick(ev: Event) {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) {
      if ((ev.target as HTMLElement).classList.contains("st-scrim")) go("list");
      return;
    }
    if (btn.getAttribute("aria-disabled") === "true" || (btn as HTMLButtonElement).disabled) { ev.preventDefault(); return; }
    const act = btn.getAttribute("data-act") || "";
    const id = Number(btn.getAttribute("data-id") || 0);
    if (act === "intake-percent") return;
    ev.preventDefault();
    try {
      if (act === "list" || act === "create-name" || act === "create-members" || act === "create-priorities" || act === "intake" || act === "add-pick" || act === "add-priorities") go(act as View);
      else if (act === "create") startCreate();
      else if (act === "reload") await load();
      else if (act === "to-members") { st.name = (root.querySelector("#st-name") as HTMLInputElement)?.value?.trim() || st.name; if (!st.name) { st.formError = "نام تیم را بنویسید."; render(); return; } go("create-members"); }
      else if (act === "toggle-person") {
        if (!isAvailable(id)) return;
        if (st.view === "add-pick") { st.addSp = st.addSp === id ? null : id; render(); return; }
        const on = validSelected().includes(id);
        if (on) { st.selected = st.selected.filter((x) => x !== id); delete st.ticks[id]; if (st.leadId === id) st.leadId = null; st.p1Order = st.p1Order.filter((x) => x !== id); }
        else if (validSelected().length < 4) { st.selected = [...validSelected(), id]; st.ticks[id] = st.ticks[id] || emptyTicks(); }
        render();
      }
      else if (act === "to-priorities") {
        st.selected = validSelected();
        if (st.selected.length < 2 || st.selected.length > 4) return;
        go("create-priorities");
      }
      else if (act === "tick") {
        const k = btn.getAttribute("data-k") as keyof Ticks;
        const on = btn.getAttribute("aria-pressed") !== "true";
        setTick(id, k, on); st.formError = null; render();
      }
      else if (act === "tmp") { applyTemplate(id, btn.getAttribute("data-tmp") as "first" | "p1"); render(); }
      else if (act === "lead") { st.leadId = id; render(); }
      else if (act === "to-review") {
        const errs = validateTicks(st.selected, st.ticks, st.leadId);
        if (errs.length) { st.formError = errs[0]!.message; st.view = errs.some((e) => e.message.includes("فقط برای یک نفر")) ? "err-duplicate" : (errs.some((e) => e.message.includes("مسئول ندارد")) ? "err-unowned" : "create-priorities"); render(); return; }
        go("create-review");
      }
      else if (act === "save-create") await saveCreate();
      else if (act === "add") { const t = findTeam(id); if (t) startAdd(t); }
      else if (act === "edit") { const t = findTeam(id); if (t) startEdit(t); }
      else if (act === "deactivate") { st.disableTeamId = id; go("deactivate"); }
      else if (act === "to-add-pri") {
        if (!st.addSp || !isAvailable(st.addSp)) return;
        st.ticks[st.addSp] = st.ticks[st.addSp] || emptyTicks();
        go("add-priorities");
      }
      else if (act === "to-add-review") go("add-review");
      else if (act === "save-add") await saveAdd();
      else if (act === "save-edit") await saveEdit();
      else if (act === "intake-edit") {
        st.formError = null;
        st.intakeError = {};
        st.intakeDraft = draftFromIntake(st.intake);
        go("intake-edit");
      }
      else if (act === "save-intake") await saveIntake();
      else if (act === "do-disable") await doDisable();
      else if (act === "do-enable") await doEnable();
    } catch (e) {
      st.error = (e as Error).message || "فهرست تیم‌ها الآن نیامد";
      st.view = "error";
      render();
    }
  }

  async function saveCreate() {
    if (st.busy) return;
    st.busy = true;
    try {
      st.selected = validSelected();
      const body = { name: st.name, members: memberPayload(st.selected, st.ticks, st.leadId, st.p1Order) };
      if (st.editTeamId) await api(`/sales-teams/${st.editTeamId}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/sales-teams", { method: "POST", body: JSON.stringify(body) });
      await load("list");
    } catch (e) {
      st.formError = (e as Error).message; st.view = "create-priorities"; render();
    } finally { st.busy = false; }
  }
  async function saveEdit() {
    if (st.busy || !st.editTeamId) return;
    st.busy = true;
    try {
      await api(`/sales-teams/${st.editTeamId}`, { method: "PATCH", body: JSON.stringify({ name: st.name, members: memberPayload(st.selected, st.ticks, st.leadId, st.p1Order) }) });
      await load("list");
    } catch (e) { st.formError = (e as Error).message; render(); }
    finally { st.busy = false; }
  }
  async function saveAdd() {
    if (st.busy || !st.addTeamId || !st.addSp) return;
    st.busy = true;
    try {
      const t = st.ticks[st.addSp] || emptyTicks();
      await api(`/sales-teams/${st.addTeamId}/members`, { method: "POST", body: JSON.stringify({ member: { salespersonId: st.addSp, isLead: st.leadId === st.addSp, ...t, sortOrder: st.p1Order.indexOf(st.addSp) } }) });
      await load("list");
    } catch (e) { st.formError = (e as Error).message; st.view = "add-priorities"; render(); }
    finally { st.busy = false; }
  }
  async function saveIntake() {
    if (st.busy) return;
    st.busy = true;
    try {
      const sources = (["new_customers", "site_leads"] as IntakeSource[]).map((source) => ({
        source,
        teams: Object.entries(st.intakeDraft[source] || {}).map(([teamId, percent]) => ({ teamId: Number(teamId), percent: Number(percent) || 0 })),
      }));
      const body = await api("/sales-teams/intake", { method: "PUT", body: JSON.stringify({ sources }) });
      st.intake = body.intake;
      st.intakeError = {};
      go("intake");
    } catch (e: any) {
      const src = e.body?.source as IntakeSource | undefined;
      st.intakeError = src ? { [src]: e.message } : st.intakeError;
      st.formError = e.message;
      st.view = "intake-err";
      render();
    }
    finally { st.busy = false; }
  }
  async function doDisable() {
    if (!st.disableTeamId) return;
    try {
      await api(`/sales-teams/${st.disableTeamId}/disable`, { method: "POST", body: "{}" });
      await load("list");
    } catch (e: any) {
      const team = findTeam(st.disableTeamId);
      if (team) team.intakeSources = e.body?.sources || team.intakeSources;
      st.formError = e.message;
      go("deactivate");
    }
  }
  async function doEnable() {
    if (!st.disableTeamId) return;
    try {
      await api(`/sales-teams/${st.disableTeamId}/enable`, { method: "POST", body: "{}" });
      await load("list");
    } catch (e) { st.formError = (e as Error).message; render(); }
  }

  async function load(next?: View) {
    st.loading = true; st.view = "loading"; render();
    try {
      const list = await api("/sales-teams");
      st.teams = list.teams || [];
      st.intake = list.intake || [];
      st.intakeDraft = draftFromIntake(st.intake);
      st.todayLabel = list.todayLabel || "";
      st.canManage = list.canManage ?? opts.me.canManage;
      st.canDisable = list.canDisable ?? opts.me.canDisable;
      if (st.canManage) {
        try { st.people = (await api("/sales-teams/picker")).people || []; } catch { st.people = []; }
      }
      st.loading = false; st.error = null;
      if (opts.me.readonly) st.view = "readonly";
      else st.view = next || (st.teams.length ? "list" : "empty");
      render();
    } catch (e) {
      st.loading = false; st.error = (e as Error).message; st.view = "error"; render();
    }
  }

  async function applyForced(scene: View) {
    // Seed from the live API, then park the UI in the requested scene (shot fixture).
    try {
      const list = await api("/sales-teams");
      st.teams = list.teams || [];
      st.intake = list.intake || [];
      st.todayLabel = list.todayLabel || "سه‌شنبه ۱۹ آبان ۱۴۰۵";
      st.canManage = scene === "readonly" ? false : (opts.me.canManage || scene === "deactivate");
      st.canDisable = scene === "deactivate" || (scene !== "list" && opts.me.canDisable);
      if (scene === "list") st.canDisable = false; // manager list (scene 1)
      if (scene === "deactivate") st.canDisable = true;
      try { st.people = (await api("/sales-teams/picker")).people || []; } catch { st.people = []; }
    } catch { /* still show the scene */ }
    st.loading = false;
    const t2 = st.teams.find((t) => t.name.includes("۲")) || st.teams[1];
    const t1 = st.teams.find((t) => t.name.includes("۱")) || st.teams[0];
    const byName = (n: string) => st.people.find((p) => p.displayName.includes(n));
    const kherad = byName("خردکار")?.salespersonId;
    const aslani = byName("اصلانیان")?.salespersonId;
    const younesi = byName("یونسی")?.salespersonId;
    if (scene === "create-name" || scene.startsWith("create-") || scene.startsWith("err-")) {
      st.name = t2?.name || "تیم فروش ۲";
      if (kherad && aslani && scene !== "create-members") {
        st.selected = [kherad, aslani];
        st.ticks[kherad] = { ownsNone: true, ownsP1: false, ownsP2: scene !== "err-unowned", ownsP3: true };
        st.ticks[aslani] = { ownsNone: scene === "err-duplicate", ownsP1: true, ownsP2: false, ownsP3: false };
        st.leadId = kherad;
        st.p1Order = [aslani];
      }
    }
    if (scene === "create-members") {
      st.selected = st.selected.filter(isAvailable);
    }
    if (scene.startsWith("add-") && t2) {
      const exp22 = st.people.find((p) => p.salespersonId === 22) || byName("کارشناس ۲۲") || byName("۲۲");
      const who = scene === "add-review" ? exp22?.salespersonId : younesi;
      if (who) {
        st.addTeamId = t2.id;
        st.addSp = who;
        st.ticks[who] = { ownsNone: false, ownsP1: false, ownsP2: true, ownsP3: false };
      }
    }
    if (scene === "lead-mark" && t1) startEdit(t1);
    if (scene === "deactivate" && t1) st.disableTeamId = t1.id;
    st.intakeDraft = draftFromIntake(st.intake);
    if (scene === "intake-err") {
      const t1 = st.teams.find((t) => t.name.includes("۱"))?.id || 1;
      const t2id = st.teams.find((t) => t.name.includes("۲"))?.id || 2;
      st.intakeDraft = {
        new_customers: { ...st.intakeDraft.new_customers, [t1]: 90, [t2id]: 0 },
        site_leads: { ...st.intakeDraft.site_leads, [t1]: 100, [t2id]: 0 },
      };
      st.intakeError = { new_customers: sumError("new_customers", 90) };
    }
    if (scene === "empty") { st.teams = []; }
    if (scene === "error") { st.view = "error"; render(); return; }
    if (scene === "loading") { st.view = "loading"; render(); return; }
    st.view = scene === "err-unowned" || scene === "err-duplicate" ? scene : scene;
    if (scene === "err-unowned") st.formError = "اولویت ۲ هنوز مسئول ندارد.";
    if (scene === "err-duplicate") st.formError = "بدون اولویت فقط برای یک نفر است.";
    render();
  }

  // resume from users page
  try {
    const q = new URLSearchParams(location.search);
    const picked = Number(q.get("pickedSalespersonId") || 0);
    const raw = sessionStorage.getItem("nafis.sales-teams.wizard");
    if (raw && (q.get("resume") || picked)) {
      const saved = JSON.parse(raw);
      Object.assign(st, saved);
      if (picked && st.view === "create-members" && isAvailable(picked) && !st.selected.includes(picked)) st.selected.push(picked);
      if (picked && st.view === "add-pick" && isAvailable(picked)) st.addSp = picked;
    }
  } catch { /* ignore */ }

  if (opts.forcedScene) void applyForced(opts.forcedScene);
  else void load();

  const onPop = () => { /* stay */ };
  window.addEventListener("resize", render);
  root.addEventListener("click", onClick);
  return () => { window.removeEventListener("resize", render); root.removeEventListener("click", onClick); root.innerHTML = ""; void onPop; };
}

export default mountSalesTeams;
