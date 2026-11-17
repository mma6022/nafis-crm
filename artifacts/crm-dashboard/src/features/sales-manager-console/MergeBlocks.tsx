// v1.2 «مدیریت فروش»: the options that lived only on the old pages (merge-v1.2.md §2). Values are the live ones, read through the old pages' own functions.
// Read-only on purpose: the only live table this page may write is sales_teams (team name / active). Changing any value below still needs
// Mohammad's separate OK for its table (call_queue_settings, sales_assist_settings, sales_intake_shares, default_owner_rule_settings, lead_intake_settings).
import type { ReactNode } from 'react';
import type { MergeState } from './api';
import { c, fa, I, Chip } from './ui';

const RO = () => <p className={c('hint ro')}><I n="lock" />مقدار زنده، فقط نمایش. تغییرش از این صفحه بعد از تأیید جداگانه‌ی محمد روشن می‌شود.</p>;
const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className={c('mrow')}><span className={c('lbl')}>{k}</span><b>{children}</b></div>;
const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className={c('mblock')} data-testid="sam-block"><h3>{title}</h3>{children}<RO /></div>
);
const teamName = (m: MergeState, id: number) => m.values.teams.find((t) => t.id === id)?.name ?? `تیم ${fa(id)}`;

export function MergeDaily({ m }: { m: MergeState }) {
  const d = m.values.daily;
  return (
    <Block title="ظرفیت و تنظیمات لیست روزانه (از «لیست‌های روزانه»)">
      <Row k="حد تغییر ظرفیت در روز">{fa(d.guardPct)}٪</Row>
      <Row k="مهلت کار تکمیلی">{fa(d.waitMin)} دقیقه</Row>
      <Row k="ظرفیت روز اول">{d.firstDayCapacity == null ? 'خودکار' : `${fa(d.firstDayCapacity)} کار`}</Row>
      <p className={c('hint')}>تغییر دستی ظرفیت یک کارشناس و گزارش بازه‌ای لیست‌ها فعلاً در «گزارش‌ها» می‌مانند.</p>
    </Block>
  );
}
export function MergeModel({ m }: { m: MergeState }) {
  const q = m.values.queue; const a = m.values.assist;
  return (
    <>
      <Block title="صف تماس (از «تنظیمات صف تماس»)">
        <Row k="ترتیب گروه‌ها">{q.order.map((g, i) => `${fa(i + 1)}. ${m.labels.queueGroups[g] ?? g}`).join('، ')}</Row>
        <Row k="قرمز شدن «جدید» بعد از">{fa(q.newRedHours)} ساعت</Row>
        <Row k="روز بی‌تماس اولویت ۱">{fa(q.p1StaleDays)} روز</Row>
        <div className={c('mrow col')}><span className={c('lbl')}>متن آماده‌ی بله «جواب نداد»</span><q className={c('tmpl')}>{fa(q.naTemplate)}</q></div>
      </Block>
      <Block title="وزن دستیار فروش (از «تنظیمات دستیار فروش»)">
        <div className={c('wgrid')}>
          {Object.entries(m.labels.signals).map(([k, l]) => <Row key={k} k={l}>{fa(a.settings.levels?.[k] ?? 0)} از ۱۰</Row>)}
        </div>
        <Row k="سهمیه‌ی اولویت ۱ در روز">{fa(a.p1.quota)}</Row>
        <Row k="روز بی‌تماس تا قرمز">{fa(a.p1.redDays)} روز</Row>
      </Block>
    </>
  );
}
export function MergeDist({ m }: { m: MergeState }) {
  const o = m.values.defaultOwner; const owner = o.ownerSalespersonId != null ? m.labels.sellers[String(o.ownerSalespersonId)] ?? `کارشناس ${fa(o.ownerSalespersonId)}` : '—';
  const src = (s: 'new_customers' | 'site_leads') => m.values.intake.filter((x) => x.source === s).map((x) => `${teamName(m, x.teamId)} ${fa(x.percent)}٪`).join('، ');
  return (
    <>
      <Block title="درصد پیش‌فرض بین تیم‌ها (از «تیم‌های فروش»)">
        <Row k="مشتری جدید">{src('new_customers') || '—'}</Row>
        <Row k="لید فرم سایت">{src('site_leads') || '—'}</Row>
        <p className={c('hint')}>این همان «بقیه»ی قانون‌های تقسیم بین تیم‌هاست.</p>
      </Block>
      <Block title="قانون ثبت مشتری (از «قانون ثبت مشتری»)">
        <Row k="وضعیت">{o.enabled ? <Chip k="b">روشن</Chip> : <Chip k="g">خاموش</Chip>}</Row>
        <Row k="کارشناس مقصد">{owner}</Row>
        <Row k="ثبت‌کننده‌ها">{o.registrarMode === 'all' ? 'همه' : o.registrarNames.join('، ') || '—'}</Row>
        <Row k="منبع ورود">{o.sourceMode === 'all' ? 'همه' : o.sources.map((s) => m.labels.regSources[s] ?? s).join('، ') || '—'}</Row>
        {m.conversion.applicable ? (
          <div className={c('conv')} data-testid="sam-conversion">
            <b>طبق تصمیم محمد (t355s1298) این قانون جدا حذف و به قانون تقسیم تبدیل می‌شود:</b>
            <p>«اگر ثبت‌کننده {o.registrarMode === 'all' ? 'هر کسی' : o.registrarNames.join(' یا ')} و منبع {o.sourceMode === 'all' ? 'هر منبعی' : o.sources.map((s) => m.labels.regSources[s] ?? s).join(' یا ')} باشد → مستقیم به {owner}»، قانون ۱ بین تیم‌ها و قانون ۱ داخل تیمش.</p>
            <p className={c('hint')}>هنوز اعمال نشده. پیش از اعمال: {m.conversion.blockers[0]}</p>
          </div>
        ) : null}
      </Block>
      <Block title="منبع پیش‌فرض فرم ثبت (از «قانون ثبت مشتری»)">
        {Object.keys(m.values.defaultSourceBySeller).length
          ? Object.entries(m.values.defaultSourceBySeller).map(([sp, s]) => <Row key={sp} k={m.labels.sellers[sp] ?? `کارشناس ${fa(sp)}`}>{m.labels.leadSources[s] ?? s}</Row>)
          : <p className={c('hint')}>برای هیچ کارشناسی تعیین نشده.</p>}
      </Block>
    </>
  );
}
export function MergeDiscipline({ m }: { m: MergeState }) {
  const d = m.values.discipline;
  return (
    <Block title="آستانه‌ها و بررسی تحویل (از «نظم پیگیری تیم»)">
      <Row k="پنجره‌ی به‌موقع">{fa(d.onTimeMin)} تا {fa(d.onTimeCapMin)} دقیقه</Row>
      <Row k="حد گزارش مشتری جدید">{fa(d.newPct)}٪، حداکثر {fa(d.newMaxOverdue)} عقب‌افتاده</Row>
      <Row k="حد عقب‌افتاده برای محدودیت">{fa(d.restrictOverdue)}</Row>
      <Row k="هشدار بعد از">{fa(d.alertDays)} روز</Row>
      <Row k="وزن‌ها">گزارش {fa(d.wReport)}، عقب‌افتاده {fa(d.wOverdue)}، بی‌تماس {fa(d.wNocall)}</Row>
      <Row k="افت تماس">{fa(d.dropPct)}٪</Row>
      <Row k="بررسی تحویل مشتری">{d.transferMode === 'block' ? 'جلوگیری' : 'فقط هشدار'}</Row>
      <Row k="مشتری نمی‌گیرند">{d.excludedReceivers.map((id) => m.labels.receivers[String(id)] ?? `کارشناس ${fa(id)}`).join('، ') || '—'}</Row>
      <p className={c('hint')}>جدول امتیاز امروز نمایشی است و روی حقوق و پورسانت اثری ندارد. «گزارش مدیر · صف تماس» در «گزارش‌ها» می‌ماند.</p>
    </Block>
  );
}
export function MergeBanner({ m }: { m: MergeState }) {
  return (
    <div className={c('mbanner', m.parity.ok ? 'ok' : 'warn')} role="status" data-testid="sam-parity">
      <I n={m.parity.ok ? 'rf' : 'lock'} />
      <span>{m.parity.ok
        ? `مقدارهای صفحه‌های قدیم ${m.importedAtFa ? `${m.importedAtFa} ` : ''}به این صفحه منتقل شد و با مقدار زنده یکی است.`
        : `${fa(m.parity.diffs.length)} مقدار با زمان انتقال فرق دارد؛ صفحه مقدار زنده را نشان می‌دهد.`}</span>
    </div>
  );
}
