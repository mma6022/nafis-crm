import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api, errText, rawCode } from '@/lib/goods-api';

type Notice = { id: number; status: 'update_available' | 'needs_attention'; detail: string | null };

/** Shown when the contract template changed after the contract was already sent but not yet signed. */
export function UpdatedContractBanner({ kind, subjectId, onDone }: { kind: 'loan' | 'goods'; subjectId: number; onDone?: () => void }) {
  const qc = useQueryClient();
  const key = ['contract-update-notices', kind, subjectId];
  const notices = useQuery({ queryKey: key, queryFn: () => api.get<{ notices: Notice[] }>(`/contract-updates/${kind}/${subjectId}`), refetchInterval: 30_000 });
  const [fields, setFields] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => kind === 'loan'
      ? api.post(`/contract-updates/loan/${subjectId}/send-updated`)
      : api.post(`/goods-purchases/${subjectId}/documents/acknowledgement/send-updated`, { values: Object.fromEntries(fields.map((f) => [f, (values[f] ?? '').trim()])) }),
    onSuccess: (r) => {
      const failed = (r as { sent?: boolean; error?: string | null })?.sent === false;
      setMessage(failed ? 'قرارداد به‌روز شد اما ارسال کامل نشد؛ از بخش قراردادها دوباره ارسال کنید.' : 'قرارداد به‌روزشده برای امضا ارسال شد.');
      qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries(); onDone?.();
    },
    onError: (e) => {
      const c = rawCode(e);
      if (c.startsWith('template_value_required:')) { const v = c.split(':')[1]; setFields((x) => (x.includes(v) ? x : [...x, v])); }
      setMessage(errText(e));
    },
  });
  const open = notices.data?.notices ?? [];
  if (!open.length && !message) return null;
  const available = open.find((n) => n.status === 'update_available');
  const attention = open.find((n) => n.status === 'needs_attention');
  return <div className="gp-alert warn" data-testid={`banner-updated-contract-${kind}`} role="status">
    {attention && <p>قالب قرارداد تغییر کرد اما تولید خودکار نسخهٔ جدید انجام نشد ({attention.detail}). قرارداد را دستی دوباره تولید کنید.</p>}
    {available && <>
      <p>قالب این قرارداد ویرایش شده است. قرارداد قبلی ارسال شده اما هنوز امضا نشده؛ می‌توانید نسخهٔ به‌روز را جایگزین و ارسال کنید.</p>
      {fields.map((f) => <div className="field" key={f}><label>{f}</label><input value={values[f] ?? ''} maxLength={5000} onChange={(e) => setValues({ ...values, [f]: e.target.value })} /></div>)}
      <button type="button" className="btn btn-primary" disabled={send.isPending} data-testid={`button-send-updated-contract-${kind}`}
        onClick={() => confirm('نسخهٔ به‌روز قرارداد جایگزین نسخهٔ ارسال‌شده شود و دوباره برای امضا ارسال گردد؟') && send.mutate()}>
        <Send size={14} /> {send.isPending ? 'در حال ارسال…' : 'ارسال قرارداد به‌روزشده'}
      </button>
    </>}
    {message && <p>{message}</p>}
  </div>;
}
