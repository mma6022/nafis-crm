// بخش ۳ — دسترسی کارشناس‌ها (§3.2). Enforced on the server for the expert's list endpoints; «همه» never widens the existing rules.
import type { SectionProps } from '../SalesManagerConsolePage';
import type { AccessDoc, Level } from '../api';
import { c, clone, fa, I, Chip, Seg } from '../ui';

const LV: [Level, string][] = [['locked', 'قفل'], ['own', 'فقط خودش'], ['team', 'تیمش'], ['all', 'همه']];
export function AccessSection({ st, doc, docs, set }: SectionProps<'access'>) {
  const saved = st.docs.access.policies;
  const pol = (id: string) => doc.policies[id] ?? { customers: 'own' as Level, loan_files: 'own' as Level };
  const upd = (fn: (d: AccessDoc) => void, n = 1) => { const d = clone(doc); fn(d); set(d, n); };
  const setOne = (id: string, k: 'customers' | 'loan_files', v: Level) => upd((d) => { d.policies[id] = { ...pol(id), [k]: v }; });
  const teams = docs.teams.teams.filter((t) => !t.deleted);
  return (
    <>
      <div className={c('row1')}><span className={c('hint')}>«قفل» یعنی صفحه‌ی لیست برایش باز نمی‌شود؛ کارهای صف خودش همچنان باز می‌شوند.</span></div>
      <table className={c('tbl')} style={{ marginTop: 8 }}>
        <thead><tr><th>کارشناس</th><th>لیست مشتریان</th><th>پرونده‌های تسهیلات</th></tr></thead>
        <tbody>
          {teams.map((t) => {
            const ms = docs.teams.experts.filter((e) => e.teamId === t.id);
            const all = (k: 'customers' | 'loan_files') => (
              <select className={c('btn lk sel')} value="" aria-label={`یکسان برای همه‌ی ${t.name}`} onChange={(e) => { const v = e.target.value as Level; if (v) upd((d) => { for (const m of ms) d.policies[m.id] = { ...pol(m.id), [k]: v }; }, ms.length); }}>
                <option value="">یکسان برای همه‌ی تیم…</option>{LV.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            );
            return [
              <tr key={t.id} className={c('team')}><td>{t.name} <span className={c('hint')}>{fa(ms.length)} کارشناس</span></td><td><I n="copy" />{all('customers')}</td><td><I n="copy" />{all('loan_files')}</td></tr>,
              ...ms.map((e) => {
                const p = pol(e.id); const s = saved[e.id];
                const dirty = !s || s.customers !== p.customers || s.loan_files !== p.loan_files;
                return (
                  <tr key={e.id}>
                    <td className={c('nm')}><b>{e.displayName}</b> {e.role === 'lead' ? <span className={c('hint')}>سرپرست</span> : null} {dirty && st.docs.access.policies[e.id] ? <Chip k="g">تغییر ذخیره‌نشده</Chip> : null}</td>
                    <td><Seg label={`لیست مشتریان ${e.displayName}`} lockFirst value={p.customers} options={LV} onChange={(v) => setOne(e.id, 'customers', v)} /></td>
                    <td><Seg label={`پرونده‌های ${e.displayName}`} lockFirst value={p.loan_files} options={LV} onChange={(v) => setOne(e.id, 'loan_files', v)} /></td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
      <p className={c('hint')} style={{ marginTop: 8 }}>کارشناس تازه با «فقط مشتریان خودش» شروع می‌کند. مدیر فروش و ادمین همیشه «همه» را دارند.</p>
    </>
  );
}
