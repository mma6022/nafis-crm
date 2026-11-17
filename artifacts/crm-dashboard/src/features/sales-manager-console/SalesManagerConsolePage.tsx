// «مدیریت تیم فروش» v1.1 — one page, no tabs, eight sections (design: nafis-design/mockups/sales-manager-console).
// Server decides who may open it (admin-role only, t815s2681; 403 for sales managers, leads, and experts; 404 while flag.sales_manager_console_v1 is OFF).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import './smc.css';
import { smcApi, useSmcMe, useSmcState, useMergeState, SECTION_IDS, type ApiError, type Docs, type FoldKey, type LiveTeam, type MergeState, type SectionId, type SmcState, type TeamPreview } from './api';
import { MergeContext, type MergeCtx } from './merge-ctx';
import { MergeBanner, MergeDaily, MergeDiscipline, MergeDist, MergeModel } from './MergeBlocks';
import { c, fa, I, Chip } from './ui';
import { TeamsSection } from './sections/Teams';
import { DailySection } from './sections/Daily';
import { AccessSection } from './sections/Access';
import { ValidSection } from './sections/Valid';
import { ModelSection } from './sections/Model';
import { DistSection } from './sections/Dist';
import { StepsSection } from './sections/Steps';
import { AuditSection } from './sections/Audit';

type AnyId = SectionId | 'audit' | 'discipline';
const SECS_V11: [AnyId, string][] = [
  ['teams', 'تیم‌ها و کارشناس‌ها'], ['daily', 'لیست روزانه‌ی کارشناس‌ها'], ['access', 'دسترسی کارشناس‌ها'], ['valid', 'مدت اعتبار استعلام‌ها'],
  ['model', 'مدل چیدن لیست روزانه'], ['dist', 'تقسیم مشتری بین تیم‌ها و کارشناس‌ها'], ['steps', 'مراحل پرونده‌ی تسهیلات'], ['audit', 'تاریخچه‌ی تغییرات'],
];
/** v1.2 (merge-v1.2.md §3): nine sections, one page, no tabs. */
const SECS_V12: [AnyId, string][] = [
  ['teams', 'تیم‌ها و کارشناس‌ها'], ['daily', 'لیست روزانه و ظرفیت'], ['access', 'دسترسی کارشناس‌ها'], ['valid', 'مدت اعتبار استعلام‌ها'],
  ['model', 'مدل لیست و صف تماس'], ['dist', 'تقسیم مشتری و قانون ثبت'], ['steps', 'مراحل پرونده‌ی تسهیلات'], ['discipline', 'نظم پیگیری و تحویل'], ['audit', 'تاریخچه‌ی تغییرات'],
];
const isDoc = (id: AnyId): id is SectionId => id !== 'audit' && id !== 'discipline';
export type SectionProps<K extends SectionId> = {
  st: SmcState; doc: Docs[K]; docs: Docs; set: (next: Docs[K], changes?: number) => void; saveNow: () => Promise<void>;
};
type Confirm = { sections: SectionId[]; rows: { section: SectionId; lines: string[]; errors: { message: string }[] }[]; conflict?: string; busy?: boolean; error?: string };

export default function SalesManagerConsolePage() {
  const q = useSmcState();
  const me = useSmcMe(true);
  const merged = Boolean(me.data?.merged);
  const mq = useMergeState(merged);
  if (q.isLoading || me.isLoading || (merged && mq.isLoading)) return <main className="smc-root smc-page" dir="rtl" lang="fa"><p className={c('loading')}>در حال باز کردن…</p></main>;
  const err = q.error as ApiError | null;
  if (err) {
    const msg = err.status === 403 ? 'این صفحه فقط برای مدیر فروش و ادمین است.' : err.status === 404 ? 'این صفحه هنوز فعال نیست.' : 'صفحه باز نشد؛ دوباره تلاش کنید.';
    return <main className="smc-root smc-page" dir="rtl" lang="fa"><div className={c('card denied')} role="alert"><I n="lock" /><b>{msg}</b></div></main>;
  }
  return <Console st={q.data!} m={merged ? mq.data ?? null : null} roles={me.data?.accessRoles} />;
}

function Console({ st, m, roles }: { st: SmcState; m: MergeState | null; roles?: string[] }) {
  const SECS = m ? SECS_V12 : SECS_V11;
  const qc = useQueryClient();
  const [work, setWork] = useState<Partial<Docs>>({});
  const [chg, setChg] = useState<Partial<Record<SectionId, number>>>({});
  const timers = useRef<Partial<Record<SectionId, ReturnType<typeof setTimeout>>>>({});
  const pending = useRef<Partial<Record<SectionId, () => Promise<void>>>>({});
  const initialOpen = useMemo(() => {
    const fromHash = /^#s-([a-z]+)$/.exec(location.hash)?.[1];
    const q = new URLSearchParams(location.search).get('open');
    return new Set((q ?? fromHash ?? 'teams').split(',').concat(fromHash && q ? [fromHash] : []));
  }, []);
  const [open, setOpen] = useState<Set<string>>(initialOpen);
  const [active, setActive] = useState<string>('teams');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const docOf = useCallback(<K extends SectionId>(s: K): Docs[K] => (work[s] ?? (st.drafts[s]?.doc as Docs[K] | undefined) ?? st.docs[s]) as Docs[K], [work, st]);
  const docs = useMemo(() => Object.fromEntries(SECTION_IDS.map((s) => [s, docOf(s)])) as Docs, [docOf]);
  const changesOf = (s: SectionId) => chg[s] ?? st.drafts[s]?.changes ?? 0;

  const putDraft = useCallback((s: SectionId, doc: unknown, changes: number) => {
    const base = st.drafts[s]?.baseVersion ?? st.meta[s].version;
    return smcApi('/drafts/' + s, { method: 'PUT', body: { doc, baseVersion: base, changes } }).then(() => undefined);
  }, [st]);
  const set = useCallback(<K extends SectionId>(s: K, next: Docs[K], add = 1) => {
    setWork((w) => ({ ...w, [s]: next }));
    setChg((m) => { const n = (m[s] ?? st.drafts[s]?.changes ?? 0) + add; const fire = () => putDraft(s, next, n);
      pending.current[s] = fire; clearTimeout(timers.current[s]);
      timers.current[s] = setTimeout(() => { delete pending.current[s]; void fire().catch(() => setToast('پیش‌نویس ذخیره نشد؛ دوباره تلاش کنید.')); }, s === 'daily' ? 0 : 500);
      return { ...m, [s]: n }; });
  }, [putDraft, st]);
  const flush = useCallback(async (only?: SectionId[]) => {
    const list = Object.entries(pending.current).filter(([s]) => !only || only.includes(s as SectionId)) as [SectionId, () => Promise<void>][];
    for (const [s, fn] of list) { clearTimeout(timers.current[s]); delete pending.current[s]; await fn(); }
  }, []);

  const reload = useCallback(async (drop: SectionId[]) => {
    setWork((w) => { const n = { ...w }; for (const s of drop) delete n[s]; return n; });
    setChg((m) => { const n = { ...m }; for (const s of drop) delete n[s]; return n; });
    await qc.invalidateQueries({ queryKey: ['smc-state'] });
    await qc.invalidateQueries({ queryKey: ['smc-queue'] });
    await qc.invalidateQueries({ queryKey: ['smc-audit'] });
  }, [qc]);
  const cancel = async (sections: SectionId[]) => {
    for (const s of sections) { clearTimeout(timers.current[s]); delete pending.current[s]; }
    await smcApi('/drafts/' + (sections.length === SECTION_IDS.length ? 'all' : sections[0]), { method: 'DELETE' });
    if (sections.length > 1 && sections.length !== SECTION_IDS.length) for (const s of sections.slice(1)) await smcApi('/drafts/' + s, { method: 'DELETE' });
    await reload(sections);
  };
  const askApply = async (sections: SectionId[]) => {
    try {
      await flush(sections);
      const r = await smcApi<{ rows: Confirm['rows'] }>('/apply/preview', { method: 'POST', body: { sections } });
      setConfirm({ sections, rows: r.rows });
    } catch (e) { setToast((e as ApiError).message); }
  };
  const doApply = async (force = false) => {
    if (!confirm) return;
    setConfirm({ ...confirm, busy: true, error: undefined });
    try {
      await smcApi('/apply', { method: 'POST', body: { sections: confirm.sections, force } });
      setConfirm(null); setToast('ذخیره و اعمال شد. در تاریخچه ثبت شد.');
      await reload(confirm.sections);
    } catch (e) {
      const b = (e as ApiError).body;
      if (b?.error === 'changed_since_open') setConfirm({ ...confirm, busy: false, conflict: b.message });
      else setConfirm({ ...confirm, busy: false, error: (e as ApiError).message });
    }
  };
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), m ? 8000 : 4000); return () => clearTimeout(t); }, [toast, m]);
  useEffect(() => () => { void flush(); }, [flush]);

  // Active section in the index (IntersectionObserver, §1 of the handoff).
  useEffect(() => {
    const els = SECS.map(([id]) => document.getElementById(`s-${id}`)).filter((x): x is HTMLElement => Boolean(x));
    const io = new IntersectionObserver((ents) => {
      const vis = ents.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActive(vis.target.id.slice(2));
    }, { rootMargin: '-80px 0px -55% 0px', threshold: 0 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  const scrollTabIntoRow = (id: string) => {
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('.smc-idx');
      const el = row?.querySelector<HTMLElement>(`a[href="#s-${id}"]`);
      if (!row || !el) return;
      const rr = row.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (er.left < rr.left + 2 || er.right > rr.right - 2) {
        el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
    });
  };
  useEffect(() => { // ?open=model or #s-model (v1.2 redirects from the old pages) → scroll to it once
    const first = /^#s-([a-z]+)$/.exec(location.hash)?.[1] ?? [...initialOpen][0];
    if (!first) return;
    requestAnimationFrame(() => {
      if (first !== 'teams') document.getElementById(`s-${first}`)?.scrollIntoView({ block: 'start' });
      scrollTabIntoRow(first);
    });
  }, [initialOpen]);

  const dirty = SECTION_IDS.filter((s) => changesOf(s) > 0);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const props = <K extends SectionId>(s: K): SectionProps<K> => ({ st, doc: docOf(s), docs, set: (n, a) => set(s, n, a), saveNow: () => flush([s]) });
  const body: Record<AnyId, () => ReactElement> = {
    teams: () => <TeamsSection {...props('teams')} />, daily: () => <DailySection {...props('daily')} />, access: () => <AccessSection {...props('access')} />,
    valid: () => <ValidSection {...props('valid')} />, model: () => <ModelSection {...props('model')} />, dist: () => <DistSection {...props('dist')} />,
    steps: () => <StepsSection {...props('steps')} />, audit: () => <AuditSection st={st} onReverted={() => { void qc.invalidateQueries({ queryKey: ['smc-merge'] }); return reload([]); }} />,
    discipline: () => (m ? <MergeDiscipline m={m} /> : <></>),
  };
  const extra: Partial<Record<AnyId, () => ReactElement>> = m ? { daily: () => <MergeDaily m={m} />, model: () => <MergeModel m={m} />, dist: () => <MergeDist m={m} /> } : {};
  const [busy, setBusy] = useState<number | null>(null);
  const [saving, setSaving] = useState<FoldKey | null>(null);
  const [undoId, setUndoId] = useState<number | null>(null);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['smc-merge'] }); await qc.invalidateQueries({ queryKey: ['smc-state'] }); await qc.invalidateQueries({ queryKey: ['smc-audit'] }); };
  const liveWrite = async (teamId: number, body: { name?: string; enabled?: boolean }, okMsg: string) => {
    setBusy(teamId);
    try { const r = await smcApi<{ auditId?: number }>(`/merge/teams/${teamId}`, { method: 'PUT', body }); setToast(okMsg); setUndoId(r.auditId || null); await refresh(); }
    catch (e) { setToast((e as ApiError).message); setUndoId(null); }
    finally { setBusy(null); }
  };
  const saveFolded = async (key: FoldKey, body: unknown, okMsg: string) => {
    setSaving(key);
    try {
      const r = await smcApi<{ changed: boolean; auditId: number }>(`/merge/section/${key}`, { method: 'PUT', body });
      setToast(r.changed ? okMsg : 'چیزی عوض نشده بود.'); setUndoId(r.changed ? r.auditId : null); await refresh(); return true;
    } catch (e) { setToast((e as ApiError).message); setUndoId(null); return false; }
    finally { setSaving(null); }
  };
  const undoLast = async () => {
    if (!undoId) return;
    try { await smcApi(`/audit/${undoId}/revert`, { method: 'POST' }); setToast('برگشت. در تاریخچه ثبت شد.'); }
    catch (e) { setToast((e as ApiError).message); }
    setUndoId(null); await refresh();
  };
  const mctx: MergeCtx | null = m ? {
    m, busy,
    liveTeam: (tid: string): LiveTeam | null => (/^t\d+$/.test(tid) ? m.values.teams.find((t) => `t${t.id}` === tid) ?? null : null),
    rename: (id, name) => liveWrite(id, { name }, 'نام تیم ذخیره شد. در تاریخچه ثبت شد.'),
    toggle: (id, enabled) => liveWrite(id, { enabled }, enabled ? 'تیم فعال شد و اعضایش برگشتند. در تاریخچه ثبت شد.' : 'تیم غیرفعال شد و اعضایش از تیم بیرون آمدند. در تاریخچه ثبت شد.'),
    preview: async (id, enabled) => { try { return await smcApi<TeamPreview>(`/merge/teams/${id}`, { method: 'PUT', body: { enabled, preview: true } }); } catch (e) { setToast((e as ApiError).message); return null; } },
    save: saveFolded, saving,
  } : null;
  const teamsLine = st.docs.teams.teams.filter((t) => !t.deleted).map((t) => `${t.name}: ${st.docs.teams.experts.filter((e) => e.teamId === t.id).map((e) => e.displayName.replace(/^(خانم|آقای) /, '')).join('، ') || 'خالی'}`);

  return (
    <MergeContext.Provider value={mctx}>
    <main className="smc-root smc-page" dir="rtl" lang="fa" data-testid="sales-manager-console" data-merged={m ? 'v12' : undefined}>
      <div className={c('ttl')}>
        <h1 className="smc-sr">{m ? 'مدیریت فروش' : 'مدیریت تیم فروش'}</h1>
        <span className={c('role')}><I n="lock" />{m && roles && !roles.includes('sales_manager') ? 'فقط ادمین' : 'فقط مدیر فروش و ادمین'}</span>
        <span className={c('hint')}>{m ? 'تیم‌ها، لیست روزانه، دسترسی، اعتبار استعلام، مدل و صف تماس، تقسیم و قانون ثبت، مراحل پرونده و نظم پیگیری در یک صفحه' : 'تیم‌ها، لیست روزانه، دسترسی، اعتبار استعلام، مدل، تقسیم و مراحل پرونده در یک صفحه'}</span>
      </div>
      <div className={c('pg')}>
        <nav className={c('idx')} aria-label="بخش‌های این صفحه">
          <h2>بخش‌ها</h2>
          {SECS.map(([id, t], i) => (
            <a key={id} href={`#s-${id}`} className={c(active === id && 'on')} onClick={() => { setOpen((o) => new Set(o).add(id)); scrollTabIntoRow(id); }}>
              <span className={c('n')}>{fa(i + 1)}</span>{t}{isDoc(id) && changesOf(id) > 0 ? <span className={c('dot')} aria-label="تغییر ذخیره‌نشده" /> : null}
            </a>
          ))}
          <p className={c('who')}>{teamsLine.map((l, i) => <span key={i}>{l}<br /></span>)}</p>
        </nav>
        <div className={c('main')}>
          {m ? <MergeBanner m={m} /> : null}
          {dirty.length ? (
            <div className={c('draftbar')} role="status">
              <span className={c('grow')}>
                <span className={c('draft-full')}>{fa(dirty.length)} بخش تغییر ذخیره‌نشده دارد. تا «ذخیره و اعمال» نزنید، روی کارشناس‌ها اثری ندارد.</span>
                <span className={c('draft-short')}>{fa(dirty.length)} بخش ذخیره‌نشده</span>
              </span>
              <button className={c('btn gh')} type="button" onClick={() => void cancel(dirty)}>لغو همه</button>
              <button className={c('btn pri')} type="button" onClick={() => void askApply(dirty)}>ذخیره و اعمال همه</button>
            </div>
          ) : null}
          {SECS.map(([id, title], i) => {
            const o = open.has(id); const d = isDoc(id) ? changesOf(id) : 0;
            return (
              <section key={id} className={c('sec card', o && 'open')} id={`s-${id}`}>
                <header className={c('sh')}>
                  <button className={c('sh-tg')} type="button" aria-expanded={o} aria-controls={`b-${id}`} onClick={() => toggle(id)}>
                    <span className={c('sn')}>{fa(i + 1)}</span>
                    <span className={c('stx')}><h2>{title}</h2><p>{id === 'discipline' ? (m ? disciplineSum(m) : '') : st.sums[id]}</p></span>
                    {d ? <Chip k="g">{fa(d)} تغییر ذخیره‌نشده</Chip> : !isDoc(id) ? (id === 'discipline' ? <Chip k="lock">فقط نمایش</Chip> : null) : <Chip k="ok">ذخیره‌شده</Chip>}
                    <I n="chev" cls="chev" />
                  </button>
                  {d ? (
                    <div className={c('sh-act')}>
                      <button className={c('btn gh')} type="button" onClick={() => void cancel([id as SectionId])}>لغو تغییرها</button>
                      <button className={c('btn pri')} type="button" onClick={() => void askApply([id as SectionId])}>ذخیره و اعمال</button>
                    </div>
                  ) : null}
                </header>
                {o ? <div className={c('sb')} id={`b-${id}`}>{body[id]()}{extra[id]?.()}</div> : null}
              </section>
            );
          })}
        </div>
      </div>
      {confirm ? <ConfirmDialog cf={confirm} onBack={() => setConfirm(null)} onApply={(f) => void doApply(f)} /> : null}
      {toast ? <div className={c('toast')} role="status">{toast}{undoId ? <button className={c('btn lk tundo')} type="button" data-testid="sam-undo" onClick={() => void undoLast()}>برگرداندن</button> : null}</div> : null}
    </main>
    </MergeContext.Provider>
  );
}
const disciplineSum = (m: MergeState) => `پنجره‌ی به‌موقع ${fa(m.values.discipline.onTimeMin)} دقیقه؛ تحویل مشتری: ${m.values.discipline.transferMode === 'block' ? 'جلوگیری' : 'فقط هشدار'}`;

const SEC_FA: Record<SectionId, string> = { teams: 'تیم‌ها', daily: 'لیست روزانه', access: 'دسترسی', valid: 'مدت اعتبار', model: 'مدل', dist: 'تقسیم', steps: 'مراحل' };
function ConfirmDialog({ cf, onBack, onApply }: { cf: Confirm; onBack: () => void; onApply: (force: boolean) => void }) {
  const errors = cf.rows.flatMap((r) => r.errors);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onBack]);
  return (
    <div className={c('scrim')} onClick={(e) => { if (e.target === e.currentTarget) onBack(); }}>
      <div className={c('dlg')} role="dialog" aria-modal="true" aria-labelledby="smc-dlg-t" ref={ref}>
        <h3 id="smc-dlg-t">{cf.sections.length === 1 ? `ذخیره و اعمال «${SEC_FA[cf.sections[0]!]}»؟` : `ذخیره و اعمال ${fa(cf.sections.length)} بخش؟`}</h3>
        <ul>
          {cf.rows.flatMap((r) => (r.lines.length ? r.lines : ['بدون تغییر محتوا']).slice(0, 12).map((l, i) => <li key={`${r.section}-${i}`}><span className={c('dt')} style={{ background: 'var(--brand)' }} />{cf.sections.length > 1 ? `${SEC_FA[r.section]}: ` : ''}{l}</li>))}
        </ul>
        {errors.length ? <p className={c('err')} role="alert">{errors[0]!.message}</p> : null}
        {cf.conflict ? <p className={c('err')} role="alert">{cf.conflict}</p> : null}
        {cf.error ? <p className={c('err')} role="alert">{cf.error}</p> : null}
        <p className={c('hint')}>از همین حالا روی کارشناس‌ها اعمال می‌شود و در تاریخچه با امکان برگرداندن ثبت می‌شود. کارهای فوری دست نمی‌خورند.</p>
        <div className={c('row1')}>
          <button className={c('btn gh')} type="button" onClick={onBack}>برگشت</button>
          {cf.conflict
            ? <button className={c('btn pri')} type="button" disabled={cf.busy} onClick={() => onApply(true)}>با این حال اعمال</button>
            : <button className={c('btn pri')} type="button" disabled={cf.busy || errors.length > 0} onClick={() => onApply(false)}>ذخیره و اعمال</button>}
        </div>
      </div>
    </div>
  );
}
