import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ChevronRight, Users } from 'lucide-react';
import { messageError, shApi } from './api';
import { Switch, useShToast } from './ui';

type Row = { userId: number; name: string; manage: boolean; customersMessage: boolean; viewScope: 'own' | 'all' | 'none' };
type Data = { bot: { id: number; name: string; handle: string | null; status: string }; groups: { key: string; name: string; rows: Row[] }[] };
const SCOPES: [Row['viewScope'], string][] = [['own', 'فقط مشتریان خودش'], ['all', 'همه'], ['none', 'هیچ']];
export function AccessPage({ botId }: { botId: number }) {
  const q = useQuery<Data>({ queryKey: ['sh-access', botId], queryFn: () => shApi(`/bots/${botId}/access`), retry: false });
  const [rows, setRows] = useState<Record<number, Row>>({}); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const { toast, node } = useShToast();
  useEffect(() => { if (q.data) setRows(Object.fromEntries(q.data.groups.flatMap((g) => g.rows).map((r) => [r.userId, r]))); }, [q.data]);
  const set = (id: number, p: Partial<Row>) => setRows((s) => ({ ...s, [id]: { ...s[id], ...p } }));
  const save = async () => { setBusy(true); setErr(''); try { await shApi(`/bots/${botId}/access`, 'PUT', { rows: Object.values(rows) }); await q.refetch(); toast('دسترسی‌ها ذخیره شد.'); } catch (e) { setErr(messageError(e)); } finally { setBusy(false); } };
  if (q.isLoading) return <div className="sh sh-page"><p className="sh-sub">در حال دریافت…</p></div>;
  if (!q.data) return <div className="sh sh-page"><p className="sh-err" role="alert">این ربات پیدا نشد.</p></div>;
  const b = q.data.bot;
  return <div className="sh sh-page" dir="rtl" data-testid="sh-access">
    <div className="sh-row" style={{ marginBottom: 16 }}><Link href="/social-hub" className="sh-ib" aria-label="بازگشت"><ChevronRight aria-hidden="true" /></Link>
      <div className="sh-sp"><h1 className="sh-h2">{b.name}</h1><div className="sh-sub" dir="auto" style={{ textAlign: 'right' }}>{b.handle ? `@${b.handle.replace(/^@/, '')}` : 'هنوز نشانی ندارد'}</div></div>
      <span className={`sh-chip ${b.status === 'connected' ? 'ok' : 'amber'}`}>{b.status === 'connected' ? 'متصل' : 'در انتظار اتصال'}</span></div>
    <div className="sh-tbl">
      <div className="sh-tr acc hd"><span>تیم و کارشناس</span><span>مدیریت ربات</span><span>مشتریانش</span><span>دیدن گفتگوها</span></div>
      {q.data.groups.map((g) => <div key={g.key}><div className="sh-grp" style={{ padding: '10px 16px', background: 'var(--sh-tint)' }}><Users aria-hidden="true" />{g.name}</div>
        {g.rows.map((r0) => { const r = rows[r0.userId] ?? r0; return <div className="sh-tr acc" key={r.userId} data-testid="sh-acc-row">
          <span className="sh-row"><span className="sh-ava" aria-hidden="true">{r.name.replace(/^(آقای|خانم)\s+/, '').slice(0, 1)}</span><b>{r.name}</b></span>
          <Switch on={r.manage} label="مدیریت ربات" onChange={(v) => set(r.userId, { manage: v })} />
          <Switch on={r.customersMessage} label="مشتریانش به این ربات پیام می‌دهند" onChange={(v) => set(r.userId, { customersMessage: v })} />
          <div className="sh-seg" role="radiogroup" aria-label={`دیدن گفتگوها، ${r.name}`}>{SCOPES.map(([k, l]) => <button type="button" role="radio" aria-checked={r.viewScope === k} key={k} className={r.viewScope === k ? 'on' : ''} onClick={() => set(r.userId, { viewScope: k })}>{l}</button>)}</div>
        </div>; })}</div>)}
    </div>
    {err ? <p className="sh-err" role="alert">{err}</p> : null}
    <div className="sh-row" style={{ marginTop: 16 }}><button type="button" className="sh-btn pri" disabled={busy} onClick={() => void save()} data-testid="sh-acc-save">ذخیره تغییرات</button><Link href="/social-hub" className="sh-btn ghost">انصراف</Link></div>
    {node}
  </div>;
}
