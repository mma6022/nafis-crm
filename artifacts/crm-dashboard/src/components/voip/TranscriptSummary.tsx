import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { getGetVoipRecordingTranscriptQueryKey, useCreateVoipRecordingSummary, type VoipRecordingTranscript } from '@workspace/api-client-react';
import { CallSummaryEdit } from './CallSummaryEdit';

export function TranscriptSummary({ transcript, recordingId, from, to }: {
  transcript: VoipRecordingTranscript; recordingId: string; from: string; to: string;
}) {
  const qc = useQueryClient();
  const mutation = useCreateVoipRecordingSummary();
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const pending = mutation.isPending || transcript.summaryState === 'queued' || transcript.summaryState === 'processing';
  const retry = async () => {
    setError(null);
    const key = getGetVoipRecordingTranscriptQueryKey(recordingId, { from, to });
    try {
      await qc.cancelQueries({ queryKey: key });
      const result = await mutation.mutateAsync({ id: recordingId, data: { from, to } });
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData(key, result);
    } catch (e) {
      const data = e as { status?: number; data?: { error?: string } };
      setError(data.status === 403 ? 'اجازهٔ تهیهٔ خلاصهٔ تماس را ندارید.'
        : data.data?.error || 'شروع تهیهٔ خلاصه ناموفق بود؛ دوباره تلاش کنید.');
    }
  };
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (transcript.summaryState === 'not_started' && transcript.canGenerate && !autoStarted.current) {
      autoStarted.current = true;
      void retryRef.current();
    }
  }, [transcript.summaryState, transcript.canGenerate]);
  return <section data-testid="transcript-summary" aria-label="موضوع و درخواست مشتری"
    style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'grid', gap: 10 }}>
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>موضوع تماس</h3>
      <p data-testid="call-subject" style={{ margin: 0, lineHeight: 1.9 }}>
        {transcript.callSubject || (pending ? 'در حال تهیهٔ موضوع تماس…' : transcript.summaryState === 'completed' ? 'ثبت نشده است.' : 'هنوز آماده نشده است.')}
      </p>
    </div>
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>خلاصه درخواست مشتری</h3>
      <p data-testid="customer-request-summary" style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.9 }}>
        {transcript.customerRequestSummary || (pending ? 'در حال استخراج درخواست مشتری از متن کامل…' : transcript.summaryState === 'completed' ? 'ثبت نشده است.' : 'هنوز آماده نشده است.')}
      </p>
    </div>
    {pending ? <p className="subtle-note" role="status">خلاصه از متن کامل تهیه می‌شود؛ فایل صوتی دوباره تبدیل نمی‌شود.</p> : null}
    {error || transcript.summaryError ? <p className="form-error" role="alert">{error || transcript.summaryError}</p> : null}
    {!pending && transcript.summaryState !== 'completed' && transcript.canGenerate
      ? <button className="btn btn-ghost" style={{ justifySelf: 'start' }} onClick={() => void retry()} data-testid="button-summary-retry">
        <RefreshCw size={14} /> {transcript.summaryState === 'failed' ? 'تلاش دوباره برای تهیهٔ خلاصه' : 'تهیهٔ خلاصه'}
      </button> : null}
    {transcript.summaryState === 'completed'
      ? <p className="subtle-note">{transcript.summaryEdited ? 'موضوع و خلاصه توسط کارشناس ویرایش شده‌اند.' : 'موضوع و خلاصه از متن ماشینی مکالمه استخراج شده‌اند؛ برای تصمیم‌گیری، متن و صدای اصلی را بررسی کنید.'}</p>
      : null}
    {transcript.summaryEditStale ? <p className="subtle-note">متن مکالمه تغییر کرده است؛ ویرایش نسخهٔ قبلی محفوظ است ولی برای این متن تازه باید دوباره بررسی شود.</p> : null}
    <CallSummaryEdit transcript={transcript} recordingId={recordingId} from={from} to={to} />
  </section>;
}