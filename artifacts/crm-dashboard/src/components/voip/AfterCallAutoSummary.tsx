import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetVoipRecordingTranscriptQueryKey, useGetVoipRecordingTranscript, useCreateVoipRecordingTranscript,
  useCreateVoipRecordingSummary, type VoipAfterCallNotice } from '@workspace/api-client-react';

export function AfterCallAutoSummary({ event, canGenerate, onReady }: {
  event: VoipAfterCallNotice; canGenerate: boolean; onReady: (subject: string, request: string) => void;
}) {
  const qc = useQueryClient();
  const params = { from: event.recordingFrom!, to: event.recordingTo! };
  const key = getGetVoipRecordingTranscriptQueryKey(event.externalId, params);
  const query = useGetVoipRecordingTranscript(event.externalId, params, { query: {
    queryKey: key, enabled: event.hasRecording && !!params.from && !!params.to, retry: false, gcTime: 0,
    refetchInterval: q => {
      const t = q.state.data;
      return !q.state.error && t && (['queued','processing'].includes(t.state)
        || (t.state === 'completed' && ['queued','processing'].includes(t.summaryState))) ? 2500 : false;
    },
  } });
  const create = useCreateVoipRecordingTranscript(), summary = useCreateVoipRecordingSummary();
  const attempted = useRef({ transcript: false, summary: false });
  const [error, setError] = useState('');
  const t = query.data, readyRef = useRef(onReady); readyRef.current = onReady;
  const generate = async (kind: 'transcript' | 'summary') => {
    setError('');
    attempted.current[kind] = true;
    try {
      const result = kind === 'transcript'
        ? await create.mutateAsync({ id: event.externalId, data: params })
        : await summary.mutateAsync({ id: event.externalId, data: params });
      await qc.cancelQueries({ queryKey: key }); qc.setQueryData(key, result);
    } catch (e) { setError((e as { data?: { error?: string } }).data?.error || 'تهیهٔ خودکار موضوع و خلاصه ناموفق بود؛ می‌توانید دستی وارد کنید.'); }
  };
  const generateRef = useRef(generate); generateRef.current = generate;
  useEffect(() => {
    if (canGenerate && t?.state === 'not_started' && !attempted.current.transcript) void generateRef.current('transcript');
    if (canGenerate && t?.state === 'completed' && t.summaryState === 'not_started' && !attempted.current.summary) void generateRef.current('summary');
    if (t?.state === 'completed' && t.summaryState === 'completed') readyRef.current(t.callSubject ?? '', t.customerRequestSummary ?? '');
  }, [canGenerate,t]);
  if (!event.hasRecording) return <p className="subtle-note">این تماس فایل ضبط ندارد؛ موضوع و درخواست مشتری را دستی وارد کنید.</p>;
  const failure = error || (query.isError ? 'دریافت متن این تماس ممکن نشد؛ می‌توانید اطلاعات را دستی وارد کنید.' : t?.error || t?.summaryError);
  return <div data-testid="after-call-auto-summary">
    {canGenerate && t?.state !== 'completed' ? <p className="subtle-note">صدای ضبط‌شده برای تبدیل به OpenAI ارسال می‌شود و از حساب موجود شرکت هزینه دارد.</p> : null}
    {failure ? <><p className="form-error" role="alert">{failure}</p>{canGenerate
      ? <button className="btn btn-ghost" disabled={create.isPending || summary.isPending}
        onClick={() => void generate(t?.state === 'completed' ? 'summary' : 'transcript')}>تلاش دوباره برای تکمیل خودکار</button> : null}</>
      : t?.summaryState !== 'completed' ? <p className="subtle-note" role="status">
        {canGenerate ? 'در حال تبدیل تماس و تهیهٔ خودکار موضوع و خلاصه… ویرایش دستی شما جایگزین نمی‌شود.' : 'خلاصهٔ آماده‌شده نمایش داده می‌شود؛ دسترسی تولید متن برای شما فعال نیست.'}
      </p> : <p className="subtle-note">موضوع و خلاصه آماده شده‌اند؛ پیش از انتقال به تاریخچه بررسی و اصلاح کنید.</p>}
  </div>;
}