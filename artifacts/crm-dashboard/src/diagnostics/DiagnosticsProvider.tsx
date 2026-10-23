import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bug, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  useCreateDiagnosticReport, useGetActiveDiagnosticReport, useGetDiagnosticAvailability, useGetDiagnosticReport,
  getGetActiveDiagnosticReportQueryKey, getGetDiagnosticAvailabilityQueryKey, getGetDiagnosticReportQueryKey,
  type DiagnosticReport,
} from '@workspace/api-client-react';
import { createTelemetry, stripPage } from './telemetry';
import type { DiagnosticReportInput } from '@workspace/api-client-react';

const ACTIVE = ['queued', 'investigating', 'fixing', 'testing', 'deploying', 'verifying'];
const TERMINAL = ['resolved', 'failed'];
const MAX_POLLS = 600;

type Ctx = { open: () => void; hasReport: boolean };
const DiagnosticsContext = createContext<Ctx | null>(null);
export const useDiagnostics = () => useContext(DiagnosticsContext);

const newClientId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/** Mount inside authenticated shell only. Re-keys itself per actor. */
export function DiagnosticsProvider({ actorId, isAdmin = false, children }: { actorId: number | string; isAdmin?: boolean; children: ReactNode }) {
  return <DiagnosticsInner key={String(actorId)} actorId={String(actorId)} isAdmin={isAdmin}>{children}</DiagnosticsInner>;
}

function DiagnosticsInner({ actorId, isAdmin, children }: { actorId: string; isAdmin: boolean; children: ReactNode }) {
  const qc = useQueryClient();
  const telemetry = useMemo(() => createTelemetry(), []);
  useEffect(() => {
    const off = telemetry.install();
    return () => { off(); telemetry.clear(); };
  }, [telemetry]);

  const [layerOpen, setLayerOpen] = useState(false);
  const [mode, setMode] = useState<'form' | 'report'>('form');
  const [reportId, setReportId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [submitError, setSubmitError] = useState('');
  const clientId = useRef(newClientId());
  const draftContext = useRef<Pick<DiagnosticReportInput, 'page' | 'browserEvents'> | null>(null);
  const autoOpened = useRef(false);

  const availKey = [...getGetDiagnosticAvailabilityQueryKey(), actorId] as const;
  const activeKey = [...getGetActiveDiagnosticReportQueryKey(), actorId] as const;
  const availability = useGetDiagnosticAvailability({ query: { queryKey: availKey, enabled: layerOpen && mode === 'form', retry: false } });
  const active = useGetActiveDiagnosticReport({ query: { queryKey: activeKey, retry: false, staleTime: 60_000 } });

  const rid = reportId ?? 0;
  const reportKey = [...getGetDiagnosticReportQueryKey(rid), actorId] as const;
  const polled = useGetDiagnosticReport(rid, {
    query: {
      queryKey: reportKey,
      enabled: reportId !== null,
      retry: false,
      refetchInterval: (q) => {
        const d = q.state.data as DiagnosticReport | undefined;
        if (d && TERMINAL.includes(d.status)) return false;
        if (q.state.dataUpdateCount + q.state.errorUpdateCount > MAX_POLLS) return false;
        return d?.status === 'awaiting_connection' ? 15_000 : 3_000;
      },
    },
  });

  const activeReport = active.data?.report ?? null;
  const report: DiagnosticReport | null = (reportId !== null && polled.data) || (activeReport && (reportId === null || activeReport.id === reportId) ? activeReport : null);

  useEffect(() => {
    if (!activeReport || autoOpened.current) return;
    autoOpened.current = true;
    setReportId(activeReport.id);
    if (!TERMINAL.includes(activeReport.status)) { setMode('report'); setLayerOpen(true); }
  }, [activeReport]);

  const create = useCreateDiagnosticReport({
    mutation: {
      retry: false,
      onSuccess: (r) => {
        qc.setQueryData([...getGetDiagnosticReportQueryKey(r.id), actorId], r);
        qc.setQueryData(activeKey, { report: r });
        setReportId(r.id); setText(''); setSubmitError(''); clientId.current = newClientId(); setMode('report');
      },
      onError: (error) => {
        const code = (error as { data?: { error?: string } }).data?.error;
        setSubmitError(code === 'diagnostic_report_pending'
          ? 'یک گزارش باز دارید. وضعیت گزارش قبلی را بررسی کنید؛ متن جدید شما حفظ شده است.'
          : code === 'diagnostic_report_rate_limited'
            ? 'به سقف گزارش‌های امروز رسیده‌اید. متن شما حفظ شده است.'
            : 'ارسال گزارش انجام نشد. متن شما حفظ شده است؛ دوباره تلاش کنید.');
      },
    },
  });

  const open = useCallback(() => {
    setSubmitError('');
    if (!report || TERMINAL.includes(report.status)) {
      draftContext.current = { page: stripPage(window.location.href), browserEvents: telemetry.snapshot() };
    }
    setMode(report && !TERMINAL.includes(report.status) ? 'report' : report && reportId !== null && mode === 'report' ? 'report' : 'form');
    setLayerOpen(true);
  }, [report, reportId, mode, telemetry]);
  const close = useCallback(() => setLayerOpen(false), []);
  useEffect(() => {
    // Fallback remains reachable over custom popups too. Capture the press before
    // an underlying dismissable layer can treat it as an outside click.
    const launch = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-diagnostics-launcher]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); open();
    };
    window.addEventListener('pointerdown', launch, true);
    return () => window.removeEventListener('pointerdown', launch, true);
  }, [open]);

  const submit = () => {
    const description = text.trim();
    if (create.isPending || description.length < 10 || description.length > 4000) return;
    setSubmitError('');
    create.mutate({ data: { clientId: clientId.current, description,
      ...(draftContext.current ?? { page: stripPage(window.location.href), browserEvents: telemetry.snapshot() }) } });
  };

  const ctx = useMemo(() => ({ open, hasReport: Boolean(report && !TERMINAL.includes(report.status)) }), [open, report]);

  return (
    <DiagnosticsContext.Provider value={ctx}>
      {children}
      {!layerOpen ? createPortal(
        <button type="button" className="diag-floating" style={{ pointerEvents: 'auto' }}
          data-diagnostics-launcher data-testid="button-diagnostics-floating" onClick={open}>
          <Bug size={16} /> گزارش خطا
        </button>, document.body,
      ) : null}
      {layerOpen ? (
        <Layer onClose={close}>
          {mode === 'form' ? (
            <FormView text={text} setText={setText} onCancel={close} onSubmit={submit} pending={create.isPending} error={submitError}
              notice={availability.data && !availability.data.connected ? availability.data.message : availability.isError ? 'وضعیت اتصال سرویس تعمیر بررسی نشد.' : ''} />
          ) : (
            <>
              {polled.isError ? <div role="alert" className="diag-notice">ارتباط برای دریافت وضعیت قطع شد؛ حل‌شدن مشکل هنوز تأیید نشده است.
                <button type="button" className="btn btn-ghost" onClick={() => void polled.refetch()}>بررسی دوباره</button>
              </div> : null}
              <ReportView report={report} loading={!report} onLeave={close} onNew={() => { setReportId(null); setMode('form'); }} />
            </>
          )}
          {import.meta.env.DEV && isAdmin && ((mode === 'form' && !availability.data?.connected) || report?.status === 'awaiting_connection') ? (
            <a className="btn btn-ghost" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/diagnostics/setup/replit`}
              target="_blank" rel="noopener noreferrer" data-testid="link-diagnostics-connection">
              تنظیم و بررسی اتصال Replit روی VPS
            </a>
          ) : null}
        </Layer>
      ) : null}
    </DiagnosticsContext.Provider>
  );
}

function Layer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Use the same managed focus-scope stack as the application's existing Radix
  // dialogs. Competing document-level traps cannot reliably nest.
  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="diag-backdrop" />
        <DialogPrimitive.Content ref={ref} className="diag-panel diag-layer-content" dir="rtl" data-testid="diagnostics-layer"
          onEscapeKeyDown={event => event.stopPropagation()}
          onOpenAutoFocus={event => {
            event.preventDefault();
            (ref.current?.querySelector<HTMLElement>('textarea') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
          }}>
        <div className="diag-head">
          <DialogPrimitive.Title asChild><h3>گزارش خطا</h3></DialogPrimitive.Title>
          <button type="button" className="modal-close" onClick={onClose} aria-label="بستن" data-testid="button-close-diagnostics"><X size={19} /></button>
        </div>
        <DialogPrimitive.Description className="sr-only">ثبت مشکل و پیگیری وضعیت تعمیر، بدون بستن فرم زیرین.</DialogPrimitive.Description>
        {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function FormView({ text, setText, onCancel, onSubmit, pending, error, notice }: { text: string; setText: (v: string) => void; onCancel: () => void; onSubmit: () => void; pending: boolean; error: string; notice: string }) {
  const len = text.trim().length;
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <p className="diag-note">مشکل را کوتاه شرح دهید. فرم‌ها و پنجره‌های باز شما دست‌نخورده می‌مانند. اطلاعات حساس را در متن ننویسید.</p>
      {notice ? <div className="diag-notice" role="status" data-testid="text-diagnostics-availability">{notice}</div> : null}
      <textarea className="diag-text" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="چه اتفاقی افتاد و در کدام بخش؟" aria-label="شرح مشکل" data-testid="input-diagnostics-description" />
      <div className="diag-count">{len.toLocaleString('fa-IR')} / {(4000).toLocaleString('fa-IR')} {len > 0 && len < 10 ? ' (حداقل ۱۰ نویسه)' : ''}</div>
      {error ? <div className="profile-form-error" role="alert" data-testid="error-diagnostics">{error}</div> : null}
      <div className="form-footer">
        <button className="btn btn-primary" type="submit" disabled={pending || len < 10} data-testid="button-submit-diagnostics">{pending ? 'در حال ارسال…' : 'حل فوری خطا'}</button>
        <button className="btn btn-ghost" type="button" onClick={onCancel} data-testid="button-cancel-diagnostics">انصراف</button>
      </div>
    </form>
  );
}

function ReportView({ report, loading, onLeave, onNew }: { report: DiagnosticReport | null; loading: boolean; onLeave: () => void; onNew: () => void }) {
  if (loading || !report) return <div className="skeleton loading-line" aria-label="در حال بارگذاری" />;
  const gif = `${import.meta.env.BASE_URL}images/repair-gears.gif`;
  if (ACTIVE.includes(report.status)) {
    return (
      <div className="diag-working" data-testid="diagnostics-working">
        <img src={gif} alt="" className="diag-gears" />
        <strong>در حال تعمیرات</strong>
        <div className="diag-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.progress}><i style={{ width: `${report.progress}%` }} /></div>
        <span>{report.progress.toLocaleString('fa-IR')}٪</span>
        <p>{report.message}</p>
        <div className="form-footer"><button type="button" className="btn btn-ghost" onClick={onLeave} data-testid="button-leave-diagnostics">ادامه کار (گزارش در پس‌زمینه می‌ماند)</button></div>
      </div>
    );
  }
  if (report.status === 'resolved') {
    return (
      <div className="diag-working" data-testid="diagnostics-resolved">
        <strong>مشکل حل شد</strong>
        <p>برای دریافت نسخهٔ جدید Ctrl+F5 بزنید</p>
        <div className="form-footer"><button type="button" className="btn btn-primary" onClick={onNew}>گزارش تازه</button><button type="button" className="btn btn-ghost" onClick={onLeave}>بستن</button></div>
      </div>
    );
  }
  if (report.status === 'failed') {
    return (
      <div className="diag-working" data-testid="diagnostics-failed">
        <p role="alert">{report.message}</p>
        <div className="form-footer"><button type="button" className="btn btn-primary" onClick={onNew}>گزارش تازه</button><button type="button" className="btn btn-ghost" onClick={onLeave}>بستن</button></div>
      </div>
    );
  }
  return (
    <div className="diag-working" data-testid="diagnostics-awaiting">
      <p>{report.message}</p>
      <div className="form-footer"><button type="button" className="btn btn-primary" onClick={onLeave} data-testid="button-leave-diagnostics">ادامه کار</button></div>
    </div>
  );
}

export function DiagnosticsButton() {
  const d = useDiagnostics();
  if (!d) return null;
  return <button type="button" className="icon-button" onClick={d.open} aria-label="گزارش خطا" title="گزارش خطا" data-testid="button-open-diagnostics"><Bug size={17} /></button>;
}

/** Compact inline variant for popup headers. Renders nothing outside staff shell. */
export function DiagnosticsInlineButton({ className = '' }: { className?: string }) {
  const d = useDiagnostics();
  if (!d) return null;
  return <button type="button" className={`diag-inline ${className}`} onClick={d.open} data-testid="button-diagnostics-inline"><Bug size={14} /> گزارش خطا</button>;
}
