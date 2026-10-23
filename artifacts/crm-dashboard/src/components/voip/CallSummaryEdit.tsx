import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Save } from 'lucide-react';
import { getGetVoipRecordingTranscriptQueryKey, getListPendingVoipAfterCallsQueryKey,
  useUpdateVoipRecordingSummary, type VoipRecordingTranscript } from '@workspace/api-client-react';

export function CallSummaryEdit({ transcript: t, recordingId, from, to }: {
  transcript: VoipRecordingTranscript; recordingId: string; from: string; to: string;
}) {
  const qc = useQueryClient(), mutation = useUpdateVoipRecordingSummary();
  const [editing, setEditing] = useState(false), [subject, setSubject] = useState(''), [request, setRequest] = useState('');
  const [base, setBase] = useState<{ hash: string; revision: number } | null>(null);
  const [error, setError] = useState('');
  if (!t.canGenerate || !t.summarySourceHash) return null;
  const start = () => {
    setSubject(t.callSubject ?? ''); setRequest(t.customerRequestSummary ?? '');
    setBase({ hash: t.summarySourceHash!, revision: t.summaryRevision ?? 0 }); setError(''); setEditing(true);
  };
  const save = async () => {
    if (!base) return;
    setError('');
    const key = getGetVoipRecordingTranscriptQueryKey(recordingId, { from, to });
    try {
      const result = await mutation.mutateAsync({ id: recordingId, data: {
        from, to, sourceHash: base.hash, expectedRevision: base.revision, callSubject: subject, customerRequestSummary: request,
      } });
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData(key, result);
      setEditing(false);
      void qc.invalidateQueries({ queryKey: getListPendingVoipAfterCallsQueryKey() });
    } catch (e) {
      setError((e as { data?: { error?: string } }).data?.error || 'ویرایش ذخیره نشد؛ متن ویرایش شما حفظ شده است.');
    }
  };
  return editing ? <div className="form-grid" data-testid="summary-edit-form">
    <div className="field full"><label htmlFor="call-subject-edit">موضوع تماس</label>
      <input id="call-subject-edit" data-testid="input-summary-subject" value={subject} maxLength={160}
        disabled={mutation.isPending} onChange={e => setSubject(e.target.value)} /></div>
    <div className="field full"><label htmlFor="call-request-edit">خلاصه درخواست مشتری</label>
      <textarea id="call-request-edit" data-testid="input-summary-request" value={request} rows={4} maxLength={1200}
        disabled={mutation.isPending} onChange={e => setRequest(e.target.value)} /></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="form-footer">
      <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => void save()} data-testid="button-save-summary-edit">
        <Save size={14} /> {mutation.isPending ? 'در حال ذخیره…' : 'ذخیره ویرایش'}</button>
      <button className="btn btn-ghost" disabled={mutation.isPending} onClick={() => setEditing(false)}>انصراف</button>
    </div>
  </div> : <button className="btn btn-ghost" style={{ justifySelf: 'start' }} onClick={start} data-testid="button-edit-summary">
    <Pencil size={14} /> ویرایش موضوع و خلاصه
  </button>;
}