// بخش ۱ — تیم‌ها و کارشناس‌ها (§3.0). No password or account creation here: an expert only links to an existing user.
import { useState } from 'react';
import type { SectionProps } from '../SalesManagerConsolePage';
import type { Expert, TeamPreview, TeamsDoc } from '../api';
import { c, clone, fa, I, Chip, Seg, latin, uid, relDay, addDays, safeN, safeText } from '../ui';
import { useMerge, priorityChips } from '../merge-ctx';

const short = (n: string) => n.replace(/^(خانم|آقای) /, '');
const statusFa = (e: Expert, today: string) => (e.status === 'active' ? 'فعال' : e.status === 'inactive' ? 'غیرفعال' : e.leaveUntil && e.leaveUntil < today ? 'فعال (مرخصی تمام شد)' : `مرخصی${e.leaveUntil ? ` تا ${relDay(today, e.leaveUntil)}` : ''}`);

export function TeamsSection({ st, doc, set }: SectionProps<'teams'>) {
  const [moving, setMoving] = useState<{ id: string; to: string; keep: boolean } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const mg = useMerge(); // v1.2: live sales_teams name / active (+ members on deactivate) + member priorities
  const [ask, setAsk] = useState<TeamPreview & { enabled: boolean } | null>(null); // the confirm step before (de)activating a live team
  const teams = doc.teams.filter((t) => !t.deleted);
  const person = (id: string) => st.people.find((p) => p.id === id);
  const upd = (fn: (d: TeamsDoc) => void, n = 1) => { const d = clone(doc); fn(d); set(d, n); };

  const doMove = () => {
    if (!moving) return;
    upd((d) => {
      const e = d.experts.find((x) => x.id === moving.id)!; const from = e.teamId;
      for (const t of d.teams) if (t.leadExpertId === e.id && t.id !== moving.to) t.leadExpertId = null;
      if (e.role === 'lead') e.role = 'expert';
      e.teamId = moving.to;
      d.moves = [...(d.moves ?? []).filter((m) => m.expertId !== e.id), { expertId: e.id, from, to: moving.to, keepCustomers: moving.keep }];
    });
    setMoving(null);
  };
  const teamCard = (tid: string) => {
    const t = doc.teams.find((x) => x.id === tid)!; const ms = doc.experts.filter((e) => e.teamId === tid);
    const lead = doc.experts.find((e) => e.id === t.leadExpertId);
    const live = mg?.liveTeam(tid) ?? null;
    return (
      <div key={tid} className={c('team-c', live && !live.enabled && 'dis')} data-live-team={live?.id} onDragOver={(e) => { if (drag) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); const ex = doc.experts.find((x) => x.id === drag); if (ex && ex.teamId !== tid) setMoving({ id: ex.id, to: tid, keep: true }); setDrag(null); }}>
        <div className={c('tch')}>
          {renaming === tid
            ? <input className={c('inp')} defaultValue={live?.name ?? t.name} aria-label="نام تیم" autoFocus onBlur={(e) => {
                const v = e.target.value.trim();
                if (live && mg) { if (v && v !== live.name) void mg.rename(live.id, v); } // v1.2: the live team name (sales_teams), saved at once and audited
                else if (v && v !== t.name) upd((d) => { d.teams.find((x) => x.id === tid)!.name = v; });
                setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            : <h3>{live?.name ?? t.name}</h3>}
          <span className={c('hint')} data-testid={`sam-count-${tid}`}>{live && !live.enabled ? (live.members.length ? `${safeN(live.members.length)} کارشناس` : 'بدون عضو') : `${safeN(ms.length)} کارشناس`}</span>{live && !live.enabled ? <span data-testid={`sam-off-note-${live.id}`}><Chip k="g">غیرفعال</Chip></span> : null}<span className={c('sp')} />
          <button className={c('ib')} type="button" aria-label="تغییر نام تیم" onClick={() => setRenaming(tid)}><I n="edit" /></button>
          {live && mg ? (
            <button className={c('btn off')} type="button" disabled={mg.busy === live.id} data-testid={`sam-toggle-${live.id}`}
              onClick={async () => { const p = await mg.preview(live.id, !live.enabled); if (p) setAsk({ ...p, enabled: !live.enabled }); }}>{live.enabled ? 'غیرفعال کردن' : 'فعال کردن'}</button>
          ) : null}
          <button className={c('ib')} type="button" aria-label={ms.length ? 'حذف تیم؛ اول اعضا را منتقل کنید' : 'حذف تیم'} disabled={ms.length > 0}
            onClick={() => upd((d) => { const x = d.teams.find((y) => y.id === tid)!; if (x.id.startsWith('n')) d.teams = d.teams.filter((y) => y.id !== tid); else x.deleted = true; })}><I n="trash" /></button>
        </div>
        {live && mg && ask && ask.teamId === live.id ? (
          <div className={c('mvc sam-ask')} role="group" aria-label={ask.enabled ? 'فعال کردن تیم' : 'غیرفعال کردن تیم'} data-testid={`sam-confirm-${live.id}`}>
            {ask.enabled ? <>
              <b>«{live.name}» فعال شود؟</b>
              <span className={c('hint')}>{ask.returning.length ? `${ask.returning.join('، ')} دوباره عضو این تیم می‌شوند، با همان اولویت‌ها.` : 'عضوی برای برگشتن پیدا نشد؛ اول از «تیم‌های فروش» عضو اضافه کنید.'}</span>
            </> : <>
              <b>«{live.name}» غیرفعال شود؟</b>
              {ask.blocked ? <p className={c('err')} role="alert">{ask.blocked}</p> : <>
                <span className={c('hint')}>{ask.removed.length ? `${ask.removed.join('، ')} از این تیم بیرون می‌آیند؛ مشتری‌ها پیششان می‌مانند.` : 'این تیم عضوی ندارد.'}</span>
              </>}
            </>}
            <div className={c('row1')}><span className={c('sp')} />
              <button className={c('btn gh')} type="button" onClick={() => setAsk(null)}>انصراف</button>
              {!ask.blocked && (ask.enabled ? ask.returning.length > 0 : true) ? (
                <button className={c('btn', ask.enabled ? 'pri' : 'bad gh')} type="button" data-testid={`sam-confirm-yes-${live.id}`} disabled={mg.busy === live.id}
                  onClick={async () => { await mg.toggle(live.id, ask.enabled); setAsk(null); }}>{ask.enabled ? 'بله، فعال کن' : 'بله، غیرفعال کن'}</button>
              ) : null}
            </div>
          </div>
        ) : null}
        {live && !live.enabled ? null : <>
        <div className={c('row1 tlead')}>
          <span className={c('lbl')}>سرپرست</span>
          <select className={c('tok n sel')} aria-label={`سرپرست ${t.name}`} value={lead?.id ?? ''} onChange={(e) => upd((d) => {
            const v = e.target.value || null; const x = d.teams.find((y) => y.id === tid)!; x.leadExpertId = v;
            for (const m of d.experts) if (m.teamId === tid) m.role = m.id === v ? 'lead' : 'expert';
          })}>
            <option value="">بدون سرپرست</option>
            {ms.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
        {ms.map((e) => {
          const p = person(e.id); const mv = moving?.id === e.id;
          return (
            <div key={e.id}>
              <div className={c('mem', mv && 'mv')} draggable={!mv} onDragStart={() => setDrag(e.id)} onDragEnd={() => setDrag(null)}>
                <span className={c('hdl')} aria-hidden="true"><I n="grip" /></span>
                <span className={c('av sm')}>{short(e.displayName)[0]}</span>
                <span className={c('mn')}>
                  <b>{e.displayName}<span className={c('mchips')}><Chip k={e.status === 'active' ? 'ok' : 'g'}>{statusFa(e, st.today)}</Chip>{e.role === 'lead' ? <Chip k="b">سرپرست</Chip> : null}</span></b>
                  <small>{e.extension ? `داخلی ${safeText(e.extension)}` : 'بدون داخلی'}، {e.role === 'lead' ? 'سرپرست' : 'کارشناس فروش'}، {safeN(p?.customers ?? 0)} مشتری{e.userId ? '' : '، بدون حساب کاربری'}</small>
                  {live ? (() => { const lm = live.members.find((x) => x.salespersonId === e.salespersonId); const ch = lm ? priorityChips(lm, live) : [];
                    return ch.length ? <span className={c('pchips')} aria-label="اولویت‌های این کارشناس">{ch.map((x) => <Chip key={x} k="b">{x}</Chip>)}</span> : null; })() : null}
                </span>
                <select className={c('tok n sel')} aria-label={`انتقال ${e.displayName} به تیم دیگر`} value="" onChange={(ev) => { if (ev.target.value) setMoving({ id: e.id, to: ev.target.value, keep: true }); }}>
                  <option value="">{mv ? doc.teams.find((x) => x.id === moving!.to)?.name : 'انتقال به تیم…'}</option>
                  {teams.filter((x) => x.id !== tid).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className={c('ib')} type="button" aria-label={`ویرایش ${e.displayName}`} onClick={() => setEditing(editing === e.id ? null : e.id)}><I n="edit" /></button>
              </div>
              {mv ? (
                <div className={c('mvc')}>
                  <b>انتقال {e.displayName} از {t.name} به {doc.teams.find((x) => x.id === moving!.to)?.name}</b>
                  <div className={c('row1')}>
                    <button type="button" role="switch" aria-checked={moving!.keep} className={c('tgl', moving!.keep && 'on')} onClick={() => setMoving({ ...moving!, keep: !moving!.keep })}>
                      <span className={c('sw')} />{safeN(p?.customers ?? 0)} مشتری و {safeN(p?.openFiles ?? 0)} پرونده‌ی باز با خودش بمانند
                    </button>
                  </div>
                  {!moving!.keep ? <span className={c('hint')}>مشتری‌هایش با قانون‌های داخل {t.name} بین بقیه‌ی همین تیم تقسیم می‌شوند و در تاریخچه‌ی تقسیم ثبت می‌شوند.</span> : null}
                  {p?.rulesNaming ? <div className={c('row1')}><Chip k="r">{fa(p.rulesNaming)} قانون تقسیم {t.name} نام او را دارد</Chip><a className={c('btn lk')} href="#s-dist">دیدن قانون</a></div> : null}
                  <div className={c('row1')}>
                    <span className={c('hint')}>{p?.hasModel ? `مدل «${p.hasModel}» و دسترسی‌اش عوض نمی‌شود.` : 'دسترسی‌اش عوض نمی‌شود.'}</span><span className={c('sp')} />
                    <button className={c('btn gh')} type="button" onClick={() => setMoving(null)}>لغو</button>
                    <button className={c('btn pri')} type="button" onClick={doMove}>انتقال</button>
                  </div>
                </div>
              ) : null}
              {editing === e.id ? <ExpertForm st={st} doc={doc} init={e} onCancel={() => setEditing(null)} onSave={(x) => { upd((d) => { const i = d.experts.findIndex((y) => y.id === x.id); d.experts[i] = x; syncLead(d, x); }); setEditing(null); }} /> : null}
            </div>
          );
        })}
        </>}
        {moving && moving.to === tid ? <div className={c('mem ghost')}><span className={c('hint')}><I n="down" /> {doc.experts.find((x) => x.id === moving.id)?.displayName} اینجا می‌آید</span></div> : null}
        {adding === tid
          ? <ExpertForm st={st} doc={doc} teamId={tid} onCancel={() => setAdding(null)} onSave={(x) => { upd((d) => { d.experts.push(x); syncLead(d, x); }); setAdding(null); }} />
          : <button className={c('btn dash wide')} type="button" onClick={() => setAdding(tid)}><I n="plus" />کارشناس تازه در این تیم</button>}
      </div>
    );
  };
  const nextName = () => { let i = teams.length + 1; while (doc.teams.some((t) => t.name === `تیم ${fa(i)}` && !t.deleted)) i++; return `تیم ${fa(i)}`; };
  return (
    <>
      <div className={c('teams')}>
        {teams.map((t) => teamCard(t.id))}
        <button className={c('team-c add')} type="button" onClick={() => upd((d) => { d.teams.push({ id: uid('n'), name: nextName(), leadExpertId: null }); })}>
          <I n="plus" /><b>تیم تازه</b><span className={c('hint')}>با نام دلخواه</span>
        </button>
      </div>
    </>
  );
}
function syncLead(d: TeamsDoc, x: Expert) {
  const t = d.teams.find((y) => y.id === x.teamId); if (!t) return;
  if (x.role === 'lead') { t.leadExpertId = x.id; for (const m of d.experts) if (m.teamId === t.id && m.id !== x.id && m.role === 'lead') m.role = 'expert'; }
  else if (t.leadExpertId === x.id) t.leadExpertId = null;
}

function ExpertForm({ st, doc, init, teamId, onSave, onCancel }: { st: SectionProps<'teams'>['st']; doc: TeamsDoc; init?: Expert; teamId?: string; onSave: (e: Expert) => void; onCancel: () => void }) {
  const [e, setE] = useState<Expert>(init ?? { id: uid('x'), displayName: '', extension: null, role: 'expert', status: 'active', leaveUntil: null, userId: null, salespersonId: null, teamId: teamId ?? null });
  const [err, setErr] = useState<string | null>(null);
  const team = doc.teams.find((t) => t.id === e.teamId);
  const taken = new Set(doc.experts.filter((x) => x.id !== e.id && x.userId).map((x) => x.userId));
  const save = () => {
    const name = e.displayName.trim(); const ext = e.extension ? latin(e.extension).replace(/\D/g, '') : '';
    if (!name) return setErr('نام را بنویسید.');
    const dup = ext && doc.experts.find((x) => x.id !== e.id && x.extension === ext);
    if (dup) return setErr(`داخلی ${fa(ext)} مال ${dup.displayName} است.`);
    const u = st.users.find((x) => x.id === e.userId);
    onSave({ ...e, displayName: name, extension: ext || null, salespersonId: u?.salespersonId ?? (e.userId ? e.salespersonId : null) });
  };
  return (
    <div className={c('nex')}>
      <b style={{ color: 'var(--ink)' }}>{init ? `ویرایش ${init.displayName}` : `کارشناس تازه در ${team?.name ?? ''}`}</b>
      <div className={c('nexg')}>
        <label><span className={c('lbl')}>نام و نام خانوادگی</span><input className={c('inp')} value={e.displayName} placeholder="مثلاً مریم رحیمی" onChange={(x) => setE({ ...e, displayName: x.target.value })} /></label>
        <label><span className={c('lbl')}>داخلی</span><input className={c('inp')} value={fa(e.extension ?? '')} placeholder="مثلاً ۲۱۴" inputMode="numeric" onChange={(x) => setE({ ...e, extension: latin(x.target.value).replace(/\D/g, '').slice(0, 6) || null })} /></label>
      </div>
      <div className={c('row1')}>
        <span className={c('lbl')}>نقش</span><Seg label="نقش" value={e.role} options={[['expert', 'کارشناس فروش'], ['lead', 'سرپرست']]} onChange={(v) => setE({ ...e, role: v })} />
        <span className={c('lbl')}>وضعیت</span><Seg label="وضعیت" value={e.status} options={[['active', 'فعال'], ['leave', 'مرخصی'], ['inactive', 'غیرفعال']]} onChange={(v) => setE({ ...e, status: v, leaveUntil: v === 'leave' ? e.leaveUntil : null })} />
        {e.status === 'leave' ? <label className={c('row1')}><span className={c('lbl')}>تا</span><select className={c('tok n sel')} value={e.leaveUntil ?? ''} onChange={(x) => setE({ ...e, leaveUntil: x.target.value || null })} aria-label="مرخصی تا">
          <option value="">انتخاب روز</option>{Array.from({ length: 28 }, (_, i) => addDays(st.today, i)).map((d) => <option key={d} value={d}>{relDay(st.today, d)}</option>)}
        </select></label> : null}
      </div>
      <div className={c('row1')}>
        <span className={c('lbl')}>حساب کاربری</span>
        <select className={c('tok n sel')} aria-label="انتخاب از کاربران" value={e.userId ?? ''} onChange={(x) => setE({ ...e, userId: x.target.value ? Number(x.target.value) : null })}>
          <option value="">انتخاب از کاربران</option>
          {st.users.filter((u) => !taken.has(u.id) || u.id === e.userId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <span className={c('hint')}>حساب ورود و رمز اینجا ساخته نمی‌شود.</span>
      </div>
      {!e.userId ? <span className={c('hint')}>بدون حساب، لید تازه به او نمی‌رسد.</span> : null}
      {err ? <p className={c('err')} role="alert">{err}</p> : null}
      <div className={c('row1')}><span className={c('sp')} /><button className={c('btn gh')} type="button" onClick={onCancel}>لغو</button><button className={c('btn pri')} type="button" onClick={save}>{init ? 'ثبت' : 'افزودن'}</button></div>
    </div>
  );
}
