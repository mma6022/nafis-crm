import { Link, useLocation } from 'wouter';
import { Stepper, WizardActions, MoreFields, useWizard } from '@/components/wizard/Wizard';
import { useEffect, useMemo, useState } from 'react';
import {
  useAttendanceBoard, useAttendanceMe, useAttendanceMutations, useAttendanceReport, useAttendanceSettings,
  type AttStaff, type AttTest,
} from './api';
import './attendance.css';

const WEEKDAYS: { n: number; label: string }[] = [
  { n: 6, label: 'شنبه' }, { n: 0, label: 'یکشنبه' }, { n: 1, label: 'دوشنبه' }, { n: 2, label: 'سه‌شنبه' },
  { n: 3, label: 'چهارشنبه' }, { n: 4, label: 'پنجشنبه' }, { n: 5, label: 'جمعه' },
];

function Tabs({ current }: { current: 'board' | 'report' | 'settings' }) {
  const me = useAttendanceMe(true).data;
  return (
    <nav className="att-tabs" aria-label="بخش‌های حضور و غیاب">
      <Link href="/attendance" className={current === 'board' ? 'is-on' : ''} data-testid="att-tab-board">تابلوی امروز</Link>
      <Link href="/attendance/report" className={current === 'report' ? 'is-on' : ''} data-testid="att-tab-report">گزارش ماهانه</Link>
      {me?.canManage ? <Link href="/attendance/settings" className={current === 'settings' ? 'is-on' : ''} data-testid="att-tab-settings">تنظیم اتصال</Link> : null}
    </nav>
  );
}

function Gate({ children, need }: { children: React.ReactNode; need: 'view' | 'manage' }) {
  const me = useAttendanceMe(true);
  if (me.isLoading) return <section className="att-page" dir="rtl"><p>در حال بارگذاری…</p></section>;
  if (!me.data?.enabled) return <section className="att-page" dir="rtl" data-testid="att-disabled"><h1>حضور و غیاب</h1><p className="att-lead">این بخش فعلاً فعال نیست.</p></section>;
  if (need === 'manage' && !me.data.canManage) {
    return (
      <section className="att-page" dir="rtl" data-testid="att-settings-forbidden">
        <h1>اتصال دستگاه</h1>
        <p className="att-lead">فقط مدیر سامانه می‌تواند اتصال دستگاه را تنظیم کند.</p>
        <p><Link href="/attendance">بازگشت به تابلوی امروز</Link></p>
      </section>
    );
  }
  if (need === 'view' && !me.data.canView) {
    return <section className="att-page" dir="rtl" data-testid="att-forbidden"><h1>حضور و غیاب</h1><p className="att-lead">فقط مدیر سامانه و مدیر فروش می‌توانند این صفحه را ببینند.</p></section>;
  }
  return <>{children}</>;
}

export function AttendanceBoardPage() {
  return <Gate need="view"><BoardInner /></Gate>;
}
export function AttendanceReportPage() {
  return <Gate need="view"><ReportInner /></Gate>;
}
export function AttendanceSettingsPage() {
  return <Gate need="manage"><WizardInner /></Gate>;
}

function BoardInner() {
  const q = useAttendanceBoard(true);
  const mut = useAttendanceMutations();
  const canManage = Boolean(useAttendanceMe(true).data?.canManage);
  const b = q.data;
  return (
    <section className="att-page" dir="rtl" data-testid="page-attendance-board">
      <h1>حضور و غیاب</h1>
      <p className="att-lead">{b?.jalaliLabel ?? 'تابلوی امروز'} · وقت تهران</p>
      <Tabs current="board" />
      {b?.placeholderNote ? <div className="att-note muted">{b.placeholderNote}</div> : null}
      {b?.lastError ? <div className="att-note bad" role="alert">آخرین همگام‌سازی ناموفق بود ({b.lastError}).</div> : null}
      {canManage ? (
        <div style={{ marginBottom: 14 }}>
          <button type="button" className="nf-btn nf-btn-primary" data-testid="att-pull" disabled={mut.pull.isPending} onClick={() => mut.pull.mutate()}>
            {mut.pull.isPending ? 'در حال خواندن از دستگاه…' : 'به‌روزرسانی از دستگاه'}
          </button>
        </div>
      ) : null}
      {q.isLoading ? <p>در حال بارگذاری…</p> : null}
      {q.error ? <div className="att-note bad" role="alert">{(q.error as Error).message}</div> : null}
      <div className="att-board">
        {(b?.people ?? []).map((p) => (
          <article key={p.crmUserId} className="att-card" data-testid={`att-person-${p.crmUserId}`} data-status={p.status}>
            <div>
              <b>{p.name}</b>
              <div className="meta">
                {p.firstInClock ? `ورود ${p.firstInClock}` : 'بدون ورود'}
                {p.lastOutClock ? ` · خروج ${p.lastOutClock}` : ''}
              </div>
            </div>
            <div>
              {p.late ? <span className="att-pill late">تأخیر</span> : null}
              <span className={`att-pill ${p.status}`}>{p.statusLabel}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ReportInner() {
  const r = useAttendanceReport(true);
  const data = r.data;
  return (
    <section className="att-page" dir="rtl" data-testid="page-attendance-report">
      <h1>گزارش ماهانه حضور</h1>
      <p className="att-lead">{data?.jalaliMonthLabel ?? ''} · وقت تهران · مبلغ حقوق محاسبه نمی‌شود</p>
      <Tabs current="report" />
      {data?.placeholderNote ? <div className="att-note muted">{data.placeholderNote}</div> : null}
      {r.isLoading ? <p>در حال بارگذاری…</p> : null}
      {r.error ? <div className="att-note bad" role="alert">{(r.error as Error).message}</div> : null}
      <div className="att-table-wrap">
        <table className="att-table" data-testid="att-report-table">
          <thead>
            <tr><th>پرسنل</th><th>ساعت کار</th><th>روز تأخیر</th><th>روز غیبت</th></tr>
          </thead>
          <tbody>
            {(data?.people ?? []).map((p) => (
              <tr key={p.crmUserId} data-testid={`att-report-${p.crmUserId}`}>
                <td>{p.name}</td>
                <td>{p.workHoursLabel}</td>
                <td>{p.lateDays}</td>
                <td>{p.absentDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const STEPS = [
  { key: 'device', title: 'نشانی دستگاه' },
  { key: 'test', title: 'آزمایش اتصال' },
  { key: 'map', title: 'تناظر پرسنل' },
  { key: 'save', title: 'ذخیره' },
] as const;

type WizardData = { host: string; port: string; shiftStart: string; shiftEnd: string; graceMinutes: string; weeklyOff: number[] };

function WizardInner() {
  const settings = useAttendanceSettings(true);
  const mut = useAttendanceMutations();
  const [, setLoc] = useLocation();
  const [commKey, setCommKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [test, setTest] = useState<AttTest | null>(null);
  const [staff, setStaff] = useState<AttStaff[]>([]);
  const [mapByPin, setMapByPin] = useState<Record<string, number | ''>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const wz = useWizard<typeof STEPS[number]['key'], WizardData>({
    id: 'attendance-v1',
    steps: STEPS,
    storage: 'session',
    initial: {
      host: settings.data?.host ?? '',
      port: String(settings.data?.port ?? 4370),
      shiftStart: settings.data?.shiftStart ?? '09:00',
      shiftEnd: settings.data?.shiftEnd ?? '18:00',
      graceMinutes: String(settings.data?.graceMinutes ?? 15),
      weeklyOff: settings.data?.weeklyOff ?? [5],
    },
  });

  useEffect(() => {
    if (!settings.data || wz.data.host) return;
    wz.update({
      host: settings.data.host, port: String(settings.data.port),
      shiftStart: settings.data.shiftStart, shiftEnd: settings.data.shiftEnd,
      graceMinutes: String(settings.data.graceMinutes), weeklyOff: settings.data.weeklyOff,
    });
  }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const warning = useMemo(() => {
    const h = wz.data.host.trim();
    if (!h) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1)/i.test(h)) {
      return 'این نشانی یک آی‌پی داخلی یا محلی است و از سرور CRM دیده نمی‌شود، مگر اینکه در دفتر آی‌پی عمومی ثابت داشته باشید و پورت ۴۳۷۰ را به دستگاه فوروارد کرده باشید.';
    }
    return null;
  }, [wz.data.host]);

  const runTest = async () => {
    setErr(null); setMsg(null);
    try {
      const r = await mut.test.mutateAsync({
        host: wz.data.host.trim(),
        port: Number(wz.data.port),
        commKey: commKey.trim() ? commKey.trim() : undefined,
      });
      setTest(r);
      if (!r.ok) { setErr(r.error === 'auth_failed' ? 'رمز ارتباط پذیرفته نشد.' : r.error === 'timeout' ? 'زمان اتصال تمام شد.' : r.error === 'refused' ? 'دستگاه پاسخ نداد.' : 'اتصال برقرار نشد.'); return; }
      const preview = await mut.staffPreview.mutateAsync(r.users);
      setStaff(preview.staff);
      const next: Record<string, number | ''> = {};
      for (const u of r.users) {
        const saved = preview.map.find((m) => m.deviceUserId === u.userId);
        const sug = preview.staff.find((s) => s.suggestedDeviceUserId === u.userId);
        next[u.userId] = saved?.crmUserId ?? sug?.id ?? '';
      }
      setMapByPin(next);
      setMsg('اتصال برقرار شد.');
    } catch (e) { setErr((e as Error).message); }
  };

  const saveAll = async () => {
    setErr(null);
    try {
      await mut.saveSettings.mutateAsync({
        host: wz.data.host.trim(),
        port: Number(wz.data.port),
        commKey: commKey.trim() ? commKey.trim() : undefined,
        clearCommKey: clearKey,
        shiftStart: wz.data.shiftStart,
        shiftEnd: wz.data.shiftEnd,
        graceMinutes: Number(wz.data.graceMinutes),
        weeklyOff: wz.data.weeklyOff,
      });
      await mut.saveMap.mutateAsync(Object.entries(mapByPin).map(([deviceUserId, crmUserId]) => ({
        deviceUserId,
        deviceUserName: test?.users.find((u) => u.userId === deviceUserId)?.name ?? null,
        crmUserId: crmUserId === '' ? null : Number(crmUserId),
      })));
      wz.reset();
      setCommKey('');
      setLoc('/attendance');
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <section className="att-page" dir="rtl" data-testid="page-attendance-wizard">
      <h1>اتصال دستگاه حضور و غیاب</h1>
      <p className="att-lead">نشانی را شما وارد می‌کنید؛ فهرست کارکنان از کاربران همین سیستم خوانده می‌شود.</p>
      <Tabs current="settings" />
      <Stepper steps={STEPS} current={wz.step} onGo={wz.goTo} testPrefix="att-step-" />
      {err ? <div className="att-note bad" role="alert">{err}</div> : null}
      {msg && wz.step === 'test' ? <div className="att-note ok" role="status">{msg}</div> : null}

      {wz.step === 'device' && (
        <form onSubmit={(e) => { e.preventDefault(); if (wz.data.host.trim()) wz.next(); }}>
          <label className="att-field"><span>نشانی دستگاه (آی‌پی یا دامنه)</span>
            <input dir="ltr" value={wz.data.host} onChange={(e) => wz.update({ host: e.target.value })} required placeholder="مثلاً 203.0.113.10" data-testid="att-host" autoComplete="off" />
          </label>
          {warning ? <div className="att-note warn">{warning}</div> : null}
          <div className="att-row">
            <label className="att-field"><span>پورت</span>
              <input dir="ltr" inputMode="numeric" value={wz.data.port} onChange={(e) => wz.update({ port: e.target.value })} data-testid="att-port" />
            </label>
            <label className="att-field"><span>رمز ارتباط (اختیاری)</span>
              <input dir="ltr" type="password" value={commKey} onChange={(e) => { setCommKey(e.target.value); setClearKey(false); }} placeholder={settings.data?.hasCommKey ? 'ذخیره‌شده — برای تغییر بنویسید' : ''} data-testid="att-comm-key" autoComplete="new-password" />
            </label>
          </div>
          {settings.data?.hasCommKey ? <label className="att-hint"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setCommKey(''); }} /> حذف رمز ذخیره‌شده</label> : null}
          <p className="att-hint">رمز ارتباط در نشست مرورگر ذخیره نمی‌شود و بعد از ذخیره هیچ‌وقت نشان داده نمی‌شود.</p>
          <WizardActions nextLabel="ادامه" nextDisabled={!wz.data.host.trim()} testPrefix="att" />
        </form>
      )}

      {wz.step === 'test' && (
        <div>
          <p className="att-lead">سرور به نشانی {wz.data.host}:{wz.data.port} وصل می‌شود و فقط اطلاعات دستگاه، کاربران و تردد را می‌خواند. چیزی روی دستگاه پاک یا عوض نمی‌شود.</p>
          <button type="button" className="nf-btn nf-btn-primary" data-testid="att-test" disabled={mut.test.isPending} onClick={() => void runTest()}>
            {mut.test.isPending ? 'در حال آزمایش…' : 'آزمایش اتصال'}
          </button>
          {test?.ok ? (
            <div className="att-note ok" data-testid="att-test-ok">
              اتصال برقرار شد. {test.info?.deviceName ? `${test.info.deviceName} · ` : ''}سریال {test.info?.serial ?? 'نامشخص'} · {test.users.length} کاربر روی دستگاه · {test.punchCount} تردد
            </div>
          ) : null}
          {test?.reachabilityWarning ? <div className="att-note warn">{test.reachabilityWarning}</div> : null}
          <WizardActions onBack={wz.back} nextLabel="ادامه" nextType="button" onNext={wz.next} nextDisabled={!test?.ok} testPrefix="att" />
        </div>
      )}

      {wz.step === 'map' && (
        <div>
          <p className="att-lead">هر شناسه روی دستگاه را به یکی از کارکنان سیستم وصل کنید. پیشنهادها از روی هم‌نامی آمده است.</p>
          <div className="att-map" data-testid="att-map">
            {(test?.users ?? []).map((u) => (
              <div className="att-map-row" key={u.userId}>
                <div><b>{u.name || 'بدون نام'}</b><div className="att-hint">شناسه دستگاه: {u.userId}</div></div>
                <select value={mapByPin[u.userId] ?? ''} onChange={(e) => setMapByPin((m) => ({ ...m, [u.userId]: e.target.value ? Number(e.target.value) : '' }))} data-testid={`att-map-${u.userId}`}>
                  <option value="">انتخاب نشده</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <WizardActions onBack={wz.back} nextLabel="ادامه" nextType="button" onNext={wz.next} testPrefix="att" />
        </div>
      )}

      {wz.step === 'save' && (
        <div>
          <p className="att-lead">با ذخیره، سرور هر چند دقیقه یک‌بار تردد را از دستگاه می‌خواند.</p>
          <div className="att-note muted">نشانی: {wz.data.host}:{wz.data.port}{test?.info?.serial ? ` · سریال ${test.info.serial}` : ''}</div>
          <MoreFields label="قواعد شیفت (پیش‌فرض؛ هنوز تأیید نشده)" defaultOpen>
            <p className="att-hint">این اعداد فقط جای‌نگهدار هستند تا قواعد حقوق مشخص شود. مبلغ حقوق محاسبه نمی‌شود.</p>
            <div className="att-row">
              <label className="att-field"><span>شروع شیفت (پیش‌فرض)</span><input dir="ltr" value={wz.data.shiftStart} onChange={(e) => wz.update({ shiftStart: e.target.value })} data-testid="att-shift-start" /></label>
              <label className="att-field"><span>پایان شیفت (پیش‌فرض)</span><input dir="ltr" value={wz.data.shiftEnd} onChange={(e) => wz.update({ shiftEnd: e.target.value })} data-testid="att-shift-end" /></label>
            </div>
            <label className="att-field"><span>دقیقهٔ ارفاق تأخیر (پیش‌فرض)</span><input dir="ltr" inputMode="numeric" value={wz.data.graceMinutes} onChange={(e) => wz.update({ graceMinutes: e.target.value })} data-testid="att-grace" /></label>
            <fieldset className="att-field"><span>روز تعطیل هفته (پیش‌فرض: جمعه)</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {WEEKDAYS.map((d) => (
                  <label key={d.n}><input type="checkbox" checked={wz.data.weeklyOff.includes(d.n)} onChange={() => wz.update({ weeklyOff: wz.data.weeklyOff.includes(d.n) ? wz.data.weeklyOff.filter((x) => x !== d.n) : [...wz.data.weeklyOff, d.n] })} /> {d.label}</label>
                ))}
              </div>
            </fieldset>
          </MoreFields>
          <WizardActions onBack={wz.back} nextLabel="ذخیره و رفتن به تابلو" nextType="button" onNext={() => void saveAll()} pending={mut.saveSettings.isPending || mut.saveMap.isPending} testPrefix="att" />
        </div>
      )}
    </section>
  );
}
