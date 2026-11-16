// بخش ۴ — مدت اعتبار استعلام‌ها (§3.3). A new duration only applies to checks done after it is saved.
import type { SectionProps } from '../SalesManagerConsolePage';
import type { Validity, ValidDoc } from '../api';
import { c, clone, fa, Chip, Pick, Seg, Stp } from '../ui';

const OPTS: [string, number | null][] = [['۲۴ ساعت', 24], ['۲ روز', 48], ['یک هفته', 168], ['یک ماه', 720], ['یک سال', 8760], ['همیشه معتبر', null]];
export const validFa = (v: Validity) => v.mode === 'forever' ? 'همیشه معتبر' : OPTS.find((o) => o[1] === v.hours)?.[0] ?? (v.hours % 24 === 0 ? `${fa(v.hours / 24)} روز` : `${fa(v.hours)} ساعت`);
export function ValidSection({ st, doc, set }: SectionProps<'valid'>) {
  const card = (k: 'identity' | 'credit', title: string, eff: (v: Validity) => string) => {
    const v = doc[k]; const saved = st.docs.valid[k];
    const preset = v.mode === 'forever' ? 'همیشه معتبر' : OPTS.find((o) => o[1] === v.hours)?.[0];
    const custom = !preset;
    const put = (nv: Validity) => { const d: ValidDoc = clone(doc); d[k] = nv; set(d); };
    const unitDays = v.mode === 'hours' && v.hours % 24 === 0 && v.hours >= 48;
    const changed = JSON.stringify(v) !== JSON.stringify(saved);
    return (
      <div className={c('vcard')}>
        <h3>{title} <Chip k={v.mode === 'forever' ? 'ok' : 'b'}>{validFa(saved)}</Chip></h3>
        <div className={c('opts')}>
          {OPTS.map(([l, h]) => <Pick key={l} on={preset === l} onClick={() => put(h == null ? { mode: 'forever', hours: v.hours || 24 } : { mode: 'hours', hours: h })}>{l}</Pick>)}
          <Pick on={custom} onClick={() => put({ mode: 'hours', hours: 36 })}>دلخواه</Pick>
        </div>
        {custom ? (
          <div className={c('row1')}>
            <span className={c('lbl')}>دلخواه</span>
            {unitDays
              ? <Stp label="روز" value={v.hours / 24} min={1} max={365} onChange={(x) => put({ mode: 'hours', hours: x * 24 })} />
              : <Stp label="ساعت" value={v.hours} min={1} max={8760} onChange={(x) => put({ mode: 'hours', hours: x })} />}
            <Seg label="واحد" value={unitDays ? 'd' : 'h'} options={[['h', 'ساعت'], ['d', 'روز']]} onChange={(u) => put({ mode: 'hours', hours: u === 'd' ? Math.max(2, Math.round(v.hours / 24)) * 24 : 36 })} />
            {changed ? <Chip k="g">پیش‌نویس</Chip> : null}
          </div>
        ) : null}
        <p className={c('eff')} style={{ marginTop: custom ? 8 : 0 }}>{eff(v)}</p>
      </div>
    );
  };
  return (
    <>
      <div className={c('vgrid')}>
        {card('identity', 'احراز هویت', (v) => v.mode === 'forever' ? 'نام، کد ملی و تاریخ تولد یک بار استعلام می‌شود و دیگر دوباره پرسیده نمی‌شود.' : `نتیجه‌ی احراز هویت ${validFa(v)} معتبر است؛ بعد از آن استعلام دوباره لازم است.`)}
        {card('credit', 'اعتبارسنجی', (v) => v.mode === 'forever' ? 'نتیجه‌ی اعتبارسنجی همیشه معتبر می‌ماند و «استعلام دوباره» فعال نمی‌شود.' : `نتیجه‌ی اعتبارسنجی ${validFa(v)} معتبر است؛ بعد از آن «استعلام دوباره» فعال می‌شود.`)}
      </div>
      <p className={c('hint')} style={{ marginTop: 10 }}>مدت تازه فقط روی استعلام‌های بعد از ذخیره اعمال می‌شود.</p>
    </>
  );
}
