/** VOIP-ANYWHERE (t836u) — pure UI rules (no React), unit-tested in scripts/voip-anywhere-fixture.mjs.
 *  These only decide what is SHOWN. Who may start a call is still decided on the server (vcCustomerAllowed, expert lockdown, one_call, needs_result, no_extension). */
export type VcaMe = { on?: boolean; anywhere?: boolean; anywhereRegistrar?: boolean; oneCallButton?: boolean; s132?: unknown;
  call?: { id: number; customerId: number; state: string; active?: boolean; needsResult?: boolean; s132?: { phase?: string } | null } | null;
  s132b?: { busy?: boolean } } | null | undefined;
export type VcaUser = { id?: number; salespersonId?: number | null } | null | undefined;
export type VcaGate = { on: boolean; sp: number | null; registrar?: boolean };
export const VCA_LABEL = 'تماس';
const spOf = (u: VcaUser) => (u && u.salespersonId != null && Number.isSafeInteger(Number(u.salespersonId)) && Number(u.salespersonId) > 0 ? Number(u.salespersonId) : null);

/** On only when the server says so (flag + voip_call + extension + SIMOTEL-132 + salesperson) AND the session has a salesperson id. */
export function vcaGate(me: VcaMe, user: VcaUser): VcaGate {
  const sp = spOf(user);
  // Registrar (no salesperson) only under flag.voip_call.registrar_scope: the server sends anywhereRegistrar and answers which ids are hers.
  if (sp == null && me?.on && me.anywhere === true && me.anywhereRegistrar === true && me.s132) return { on: true, sp: null, registrar: true };
  return { on: Boolean(me?.on && me.anywhere === true && me.s132 && sp != null), sp };
}
/** Own customer only: the row's owner salesperson must be the expert's; a server-confirmed own hit (incoming wizard / LockedInbound) counts;
 *  rows without the owner use the read-only /voip-call/anywhere/own answer. Registrar / admin (no salesperson) → never. */
export function vcaCanCall(g: VcaGate, o: { customerId: number; salespersonId?: number | null; own?: boolean; ownIds?: Set<number> | null }): boolean {
  if (!g.on || !Number.isSafeInteger(o.customerId) || o.customerId <= 0) return false;
  if (g.registrar) return Boolean(o.ownIds?.has(o.customerId)); // registrar: ONLY the server's answer (registered / open filing / incoming grant)
  if (g.sp == null) return false;
  if (o.salespersonId !== undefined) return o.salespersonId != null && Number(o.salespersonId) === g.sp && o.own !== false;
  if (o.own === true) return true;
  return Boolean(o.ownIds?.has(o.customerId));
}
const LIVE = new Set(['requesting', 'ring_me', 'dial_cust', 'in_call']);
/** Row button state: 'mine' = this customer's call exists → show the full VoipCallBox panel; 'locked' = one call at a time; 'idle' = «تماس». */
export function vcaRowState(me: VcaMe, customerId: number): 'idle' | 'locked' | 'mine' {
  const c = me?.call ?? null;
  if (c && c.customerId === customerId) return 'mine';
  const ph = c?.s132?.phase;
  if (c && (LIVE.has(c.state) || c.needsResult || ph === 'waiting' || ph === 'late' || ph === 'first_form')) return 'locked';
  if (me?.s132b?.busy) return 'locked';
  return 'idle';
}
/** Designer rule: only ONE call button. With flag.voip_call_anywhere on AND VoIP on for this user (voip_call + extension): only the VoIP button,
 *  labelled «تماس»; «تماس سیستمی» hidden. Otherwise (flag off / no extension): today's buttons unchanged. */
export function vcaSingleButton(me: VcaMe): { showSystem: boolean; voipLabel?: string } {
  return me?.on && me.oneCallButton === true ? { showSystem: false, voipLabel: VCA_LABEL } : { showSystem: true };
}
/** Customer page buttons. Experts / everyone else = vcaSingleButton. A scoped registrar (anywhereRegistrar) gets the VoIP «تماس» ONLY for a
 *  customer the server confirmed as hers (registered / open filing / incoming grant); any other customer keeps «تماس سیستمی» as today
 *  (the server would answer 403 not_own_customer). Unknown yet (ownIds null) → system button only. Still exactly one call button. */
export function vcaDetailButtons(me: VcaMe, g: VcaGate, ownIds: ReadonlySet<number> | null | undefined, customerId: number): { showVoip: boolean; showSystem: boolean; voipLabel?: string } {
  if (!g.registrar) return { showVoip: true, ...vcaSingleButton(me) };
  return ownIds?.has(customerId) ? { showVoip: true, showSystem: false, voipLabel: VCA_LABEL } : { showVoip: false, showSystem: true };
}
/** Required first-call form auto-open: only for a call started from an anywhere button, once it reaches SIMOTEL-132 phase first_form
 *  (first call + answered). Non-first calls never reach first_form → nothing opens (status from the CDR, note from the summary). */
export function vcaAutoOpen(me: VcaMe, g: VcaGate, started: ReadonlySet<number>, shown: number | null): number | null {
  const c = me?.call; if (!g.on || !c || !started.has(c.id) || shown === c.id) return null;
  return c.s132?.phase === 'first_form' ? c.id : null;
}

/** Design v1.0 in_card / in_missed (spec §۶ default 1): the incoming card never shows a call button while the caller is on the line;
 *  «تماس دوباره» (VoIP) only once the incoming call was missed / ended — in this app: the wizard opened from «تماس‌های بی‌پاسخ امروز» (presetPhone). */
export const VCA_REDIAL_LABEL = 'تماس دوباره';
export function vcaIncomingButton(o: { onLine: boolean; missed: boolean; kind: 'own' | 'new' | 'dup' }): 'redial' | null {
  if (o.onLine || !o.missed || o.kind === 'dup') return null;
  return 'redial';
}
