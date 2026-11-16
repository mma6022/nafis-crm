// بخش ۸ — تاریخچه‌ی تغییرات. Every apply is one row with a full Persian sentence; «برگرداندن» writes a new row, nothing is erased.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { smcApi, type ApiError, type AuditRow, type SmcState } from '../api';
import { c, I, Chip, Pick } from '../ui';

const F: [string, string][] = [['', 'همه'], ['teams', 'تیم‌ها'], ['daily', 'لیست روزانه'], ['access', 'دسترسی'], ['valid', 'مدت اعتبار'], ['model', 'مدل'], ['dist', 'تقسیم'], ['steps', 'مراحل']];
export function AuditSection({ onReverted }: { st: SmcState; onReverted: () => void }) {
  const [sec, setSec] = useState('');
  const [ask, setAsk] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['smc-audit', sec], queryFn: () => smcApi<{ rows: AuditRow[] }>(`/audit${sec ? `?section=${sec}` : ''}`) });
  const revert = async (id: number) => {
    try { await smcApi(`/audit/${id}/revert`, { method: 'POST' }); setAsk(null); setMsg('برگردانده شد و در تاریخچه ثبت شد.'); onReverted(); void q.refetch(); }
    catch (e) { setMsg((e as ApiError).message); }
  };
  const rows = q.data?.rows ?? [];
  return (
    <>
      <div className={c('row1')} style={{ paddingTop: 16 }}>{F.map(([k, l]) => <Pick key={k} on={sec === k} onClick={() => setSec(k)}>{l}</Pick>)}</div>
      {msg ? <p className={c('hint')} role="status">{msg}</p> : null}
      {rows.length ? (
        <table className={c('tbl')} style={{ marginTop: 8 }}>
          <thead><tr><th>زمان</th><th>چه کسی</th><th>بخش</th><th>چه تغییری</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={c('hint')}>{r.atFa}</td>
                <td><b style={{ color: 'var(--ink)' }}>{r.who}</b></td>
                <td><Chip>{r.sectionFa}</Chip></td>
                <td>{r.revertOf ? <Chip k="g">برگرداندن</Chip> : null} {r.summary}</td>
                <td>{ask === r.id
                  ? <span className={c('row1')} style={{ gap: 6 }}><button className={c('btn gh')} type="button" onClick={() => setAsk(null)}>نه</button><button className={c('btn pri')} type="button" onClick={() => void revert(r.id)}>برگردان</button></span>
                  : <button className={c('btn lk')} type="button" onClick={() => setAsk(r.id)}><I n="undo" />برگرداندن</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className={c('hint')} style={{ marginTop: 8 }}>{q.isLoading ? 'در حال خواندن…' : 'هنوز تغییری ثبت نشده.'}</p>}
    </>
  );
}
