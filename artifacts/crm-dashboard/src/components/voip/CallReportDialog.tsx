import { CustomerName } from '@/components/customer/CustomerName';
import { CallNoteCounter } from '@/components/CallNoteCounter';
import { callNoteOk } from '@/lib/call-note';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import {
  useGetCallReport, useUpdateCallReport, getGetCallReportQueryKey,
  useGetVoipAfterCallReport, useUpdateVoipAfterCallReport, getGetVoipAfterCallReportQueryKey,
  getListCallsQueryKey, getListCustomersQueryKey, getListRemindersQueryKey,
  type CallReport,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { formatDateTime } from '@/components/CrmShell';
import './CallReportDialog.css';
import { VoiceNoteButton } from '@/features/voice-notes/VoiceNoteButton';

export type ReportSource = { kind: 'call'; id: number } | { kind: 'event'; id: number };
const busy = ['queued', 'processing'];

function errMsg(err: unknown): { text: string; conflict: boolean } {
  const e = err as { status?: number; data?: { error?: string; message?: string } | null };
  if (e?.status === 409) return { conflict: true, text: 'این گزارش همزمان توسط فرد یا سیستم دیگری تغییر کرده است. متن شما حفظ شده؛ آن را کپی کنید، گزارش را دوباره باز کنید و تغییرات را دستی اعمال کنید.' };
  return { conflict: false, text: e?.data?.error || e?.data?.message || 'ذخیره انجام نشد. متن شما حفظ شده است؛ دوباره تلاش کنید.' };
}

export function CallReportEditor({ source, onDirtyChange, onSaved, footer }: {
  source: ReportSource;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (report: CallReport, sent: { subject: string | null; expertNotes: string }) => void | Promise<void>;
  footer?: (api: { dirty: boolean; saving: boolean; report: CallReport }) => ReactNode;
}) {
  const qc = useQueryClient();
  const isCall = source.kind === 'call';
  const id = source.id;
  const polls = useRef(0);
  const interval = (q: { state: { data: CallReport | undefined; error: unknown } }) => {
    const r = q.state.data;
    if (!r || q.state.error) return false;
    const t = r.transcript;
    if (r.isLive || (t && (busy.includes(t.state) || (t.state === 'completed' && busy.includes(t.summaryState))))) return 3000;
    if (!t && r.externalId && r.recordingFrom && polls.current++ < 20) return 4000;
    return false;
  };
  const callKey = getGetCallReportQueryKey(id), evKey = getGetVoipAfterCallReportQueryKey(id);
  const q1 = useGetCallReport(id, { query: { queryKey: callKey, enabled: isCall, refetchInterval: interval, staleTime: 0, gcTime: 0 } });
  const q2 = useGetVoipAfterCallReport(id, { query: { queryKey: evKey, enabled: !isCall, refetchInterval: interval, staleTime: 0, gcTime: 0 } });
  const query = isCall ? q1 : q2;
  const report = query.data;
  const m1 = useUpdateCallReport(), m2 = useUpdateVoipAfterCallReport();
  const mutateRef = useRef<(vars: { id: number; data: { subject: string | null; expectedRevision: number; expertNotes: string } }) => Promise<CallReport>>(m1.mutateAsync);
  mutateRef.current = isCall ? m1.mutateAsync : m2.mutateAsync;

  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [noteErr, setNoteErr] = useState(false);
  const init = useRef(false);
  const rev = useRef(0);
  const draft = useRef({ subject: '', notes: '' });
  const inflight = useRef(false);
  const conflictRef = useRef(false);
  const saved = useRef({ subject: '', notes: '' });
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const dirtyCb = useRef(onDirtyChange); dirtyCb.current = onDirtyChange;

  useEffect(() => {
    if (report && !init.current) {
      init.current = true;
      rev.current = report.revision;
      setSubject(report.subject ?? ''); setNotes(report.expertNotes);
      draft.current = { subject: report.subject ?? '', notes: report.expertNotes };
      saved.current = { ...draft.current };
    }
  }, [report]);
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: getListCallsQueryKey() });
    qc.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    qc.invalidateQueries({ queryKey: getListRemindersQueryKey() });
    qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('/api/customers') || String(x.queryKey[0]).startsWith('/api/voip/after-call') });
  }, [qc]);

  const save = useCallback(async (): Promise<boolean> => {
    if (inflight.current || conflictRef.current) return false;
    inflight.current = true; setSaving(true); setError('');
    const sent = { subject: draft.current.subject, notes: draft.current.notes };
    const body = { subject: sent.subject.trim() || null, expertNotes: sent.notes, expectedRevision: rev.current };
    try {
      const res = await mutateRef.current({ id, data: body });
      rev.current = res.revision;
      saved.current = sent;
      const same = draft.current.subject === sent.subject && draft.current.notes === sent.notes;
      for (const k of [callKey, evKey]) qc.setQueryData(k, (old: CallReport | undefined) => old ? { ...old, revision: res.revision, subject: res.subject, expertNotes: res.expertNotes, canEdit: res.canEdit } : old);
      if (same) setDirty(false);
      invalidate();
      await onSavedRef.current?.(res, { subject: body.subject, expertNotes: body.expertNotes });
      inflight.current = false; setSaving(false);
      if (!same) void save();
      return true;
    } catch (e) {
      const m = errMsg(e);
      if (m.conflict) { conflictRef.current = true; setConflict(true); }
      setError(m.text);
      inflight.current = false; setSaving(false);
      return false;
    }
  }, [id, qc, callKey, evKey, invalidate]);
  const saveRef = useRef(save); saveRef.current = save;

  const live = Boolean(report?.isLive);
  useEffect(() => {
    if (!live || !dirty || !report?.canEdit || conflictRef.current) return;
    const t = setTimeout(() => { void saveRef.current(); }, 1500);
    return () => clearTimeout(t);
  }, [live, dirty, subject, notes, report?.canEdit]);

  const edit = (s: string, n: string) => {
    draft.current = { subject: s, notes: n };
    setSubject(s); setNotes(n);
    setDirty(s !== saved.current.subject || n !== saved.current.notes);
  };

  if (query.isLoading || (report && !init.current)) return <div className="cr-ai" data-testid="report-loading">در حال دریافت گزارش تماس...</div>;
  if (query.isError || !report) return <div className="profile-form-error" role="alert">دریافت گزارش تماس انجام نشد. <button className="btn btn-ghost" onClick={() => query.refetch()}>تلاش دوباره</button></div>;

  const c = report.call, t = report.transcript;
  const canEdit = report.canEdit;
  const audioOk = !report.isLive && report.externalId && report.recordingFrom && report.recordingTo;
  const audioSrc = audioOk ? `${import.meta.env.BASE_URL}api/voip/recordings/${encodeURIComponent(report.externalId!)}/audio?from=${encodeURIComponent(report.recordingFrom!)}&to=${encodeURIComponent(report.recordingTo!)}` : '';
  const aiBusy = t && (busy.includes(t.state) || (t.state === 'completed' && busy.includes(t.summaryState)));
  const summary = report.systemSummary ?? c.systemSummary ?? null;

  return <div className="cr-wrap" data-testid="call-report-editor">
    <div className="cr-meta">
      <div>مشتری: <strong>{c.customerId == null ? 'داخلی شما (بدون پروفایل مشتری)' : <CustomerName id={c.customerId} name={c.customerName} />}</strong> <span dir="ltr" className="mono">{c.customerPhone}</span></div>
      <div>کارشناس: <strong>{c.salespersonName || 'شناسایی نشد'}</strong>{c.extension ? ` · داخلی ${c.extension}` : ''}</div>
      <div>زمان: {formatDateTime(c.createdAt)}</div>
    </div>
    {report.mobile ? <div className="subtle-note" data-testid="text-mobile-call-metadata">
      <div>تماس {report.mobile.direction === 'incoming' ? 'ورودی' : 'خروجی'} · مخاطب دفترچه تلفن: {report.mobile.contactName || 'بدون نام'}</div>
      <div>شماره تماس‌گیرنده: <span dir="ltr">{report.mobile.callerNumber === 'unknown' ? 'ناشناس' : report.mobile.callerNumber}</span> · شماره مقصد: <span dir="ltr">{report.mobile.calleeNumber === 'unknown' ? 'ناشناس' : report.mobile.calleeNumber}</span></div>
      <div>شروع: {formatDateTime(report.mobile.startedAt)} · پایان: {report.mobile.endedAt ? formatDateTime(report.mobile.endedAt) : 'هنوز اعلام نشده'} · مدت مکالمه: {report.mobile.durationSeconds == null ? 'هنوز اعلام نشده' : `${report.mobile.durationSeconds.toLocaleString('fa-IR')} ثانیه`}</div>
    </div> : null}
    {report.isLive ? <div className="cr-live" role="status" data-testid="status-report-live">تماس در جریان است ({report.status.toUpperCase() === 'RINGING' ? 'در حال زنگ خوردن' : 'فعال'}). می‌توانید موضوع و یادداشت را همین حالا بنویسید؛ اعلام پایان تماس از ذخیرهٔ یادداشت مستقل است.</div> : null}
    {report.automaticError ? <p className="form-error" role="alert">{report.automaticError}</p> : null}
    <div className="form-grid">
      <div className="field full"><label htmlFor="cr-subject">موضوع تماس (کارشناس)</label>
        <input id="cr-subject" value={subject} maxLength={160} disabled={!canEdit} readOnly={conflict} onChange={(e) => edit(e.target.value, draft.current.notes)} data-testid="input-report-subject" /></div>
      <div className="field full"><label htmlFor="cr-notes">یادداشت کارشناس</label>
        <VoiceNoteButton value={notes} onChange={(v) => edit(draft.current.subject, v)} field="call_note" maxLength={10000} testId="report-notes-voice" off={!canEdit || conflict}><textarea id="cr-notes" rows={5} value={notes} maxLength={10000} disabled={!canEdit} readOnly={conflict} onChange={(e) => edit(draft.current.subject, e.target.value)} placeholder="نتیجه مکالمه را بنویسید" aria-invalid={noteErr && !callNoteOk(notes)} aria-describedby="cr-notes-meta" data-testid="input-report-notes" /></VoiceNoteButton>
        {canEdit ? <CallNoteCounter value={notes} showError={noteErr} id="cr-notes-meta" testId="report-notes-counter" /> : null}</div>
    </div>
    {!canEdit ? <p className="subtle-note">امکان ویرایش این گزارش برای شما فعال نیست.</p> : null}
    {error ? <p role="alert" className="form-error" data-testid="error-report">{error}</p> : null}
    {dirty && live && !error ? <p className="subtle-note">{saving ? 'در حال ذخیره خودکار...' : 'تغییرات به‌زودی ذخیره می‌شود.'}</p> : null}
    <div className="cr-ai" data-testid="text-report-summary"><b>خلاصه سیستم (هوش مصنوعی، جدا از متن کارشناس)</b>
      {summary || (aiBusy ? 'در حال تهیه خلاصه...' : 'خلاصه‌ای ثبت نشده است.')}</div>
    {audioOk ? <audio className="cr-audio" controls preload="none" src={audioSrc} data-testid="audio-report" /> : null}
    {t?.state === 'completed' && (t.segments.length || t.text) ? <details className="cr-transcript" data-testid="details-report-transcript"><summary>متن کامل تماس</summary>
      {t.segments.length ? t.segments.map((s, i) => <p key={i}><b>{t.speakers.find((x) => x.id === s.speakerId)?.label ?? s.speakerId}:</b> {s.text}</p>) : <p style={{ whiteSpace: 'pre-wrap' }}>{t.text}</p>}</details>
      : aiBusy ? <p className="subtle-note">در حال تبدیل صدا به متن...</p> : t?.state === 'failed' ? <p className="form-error">{t.error || 'تبدیل صدا به متن ناموفق بود.'}</p> : null}
    {c.customerRequest ? <details className="cr-transcript"><summary>خلاصهٔ قبلیِ ثبت‌شده</summary><p style={{whiteSpace:'pre-wrap'}}>{c.customerRequest}</p></details> : null}
    <div className="form-footer">
      {canEdit && !live ? <button className="btn btn-primary" type="button" onClick={() => { if (!callNoteOk(notes)) { setNoteErr(true); return; } setNoteErr(false); void save(); }} disabled={saving || !dirty || conflict} data-testid="button-report-save"><Save size={15} /> {saving ? 'در حال ذخیره...' : 'ذخیره'}</button> : null}
      {footer?.({ dirty, saving, report })}
    </div>
  </div>;
}

export function CallReportDialog({ callId, eventId, title = 'گزارش تماس', onClose }: { callId?: number; eventId?: number; title?: string; onClose: () => void }) {
  const [dirty, setDirty] = useState(false);
  const source: ReportSource | null = callId != null ? { kind: 'call', id: callId } : eventId != null ? { kind: 'event', id: eventId } : null;
  const close = () => { if (dirty && !window.confirm('تغییرات ذخیره‌نشده از بین می‌رود. بستن؟')) return; onClose(); };
  if (!source) return null;
  return <Modal title={title} eyebrow="ویرایش گزارش" onClose={close} testId="call-report" wide>
    <CallReportEditor source={source} onDirtyChange={setDirty} />
  </Modal>;
}
