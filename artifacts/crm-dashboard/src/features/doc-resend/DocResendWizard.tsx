import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Send } from 'lucide-react';
import { Wizard } from '@/components/goods/GpKit';
import { docStatusLabel, errText, stageLabel, poStageLabel } from '@/lib/goods-api';
import { formatDateTime } from '@/components/CrmShell';
import {
  useAdminControls, postGoodsStage, postPaymentStage, postGoodsResend, BLOCK_REASON,
  type AdminControls,
} from './api';
import './doc-resend.css';

const STEPS = ['انتخاب کار', 'انتخاب مرحله یا سند', 'دلیل', 'تأیید'];
type Action = 'stage_back' | 'resend_invoice' | 'resend_acknowledgement';

function labelFor(kind: 'goods' | 'payment', stage: string) {
  return kind === 'goods' ? stageLabel(stage) : poStageLabel(stage);
}

export function DocResendButton({ kind, id, onDone }: { kind: 'goods' | 'payment'; id: number; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn btn-ghost dr-open" onClick={() => setOpen(true)} data-testid={`button-doc-resend-${kind}`}>
      <RotateCcw size={15} />بازگشت مرحله یا ارسال دوباره سند
    </button>
    {open ? <DocResendWizard kind={kind} id={id} onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); onDone(m); }} /> : null}
  </>;
}

export function DocResendWizard({ kind, id, onClose, onDone }: { kind: 'goods' | 'payment'; id: number; onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const q = useAdminControls(kind, id, true);
  const [step, setStep] = useState(0);
  const [action, setAction] = useState<Action | ''>('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const controls = q.data;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!controls || !action) throw new Error('انتخاب ناقص است.');
      const expected = controls.stage;
      if (action === 'stage_back') {
        if (kind === 'goods') return postGoodsStage(id, target, reason.trim(), expected);
        return postPaymentStage(id, target, reason.trim(), expected);
      }
      const docKind = action === 'resend_invoice' ? 'invoice' : 'acknowledgement';
      return postGoodsResend(id, docKind, reason.trim(), expected);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goods-purchase', id] });
      qc.invalidateQueries({ queryKey: ['goods-purchases'] });
      qc.invalidateQueries({ queryKey: ['payment-order', id] });
      qc.invalidateQueries({ queryKey: ['payment-orders'] });
      qc.invalidateQueries({ queryKey: ['doc-resend'] });
      const msg = action === 'stage_back'
        ? `مرحله به «${labelFor(kind, target)}» برگشت.`
        : action === 'resend_invoice'
          ? 'نسخهٔ تازهٔ فاکتور تولید شد. سندهای قبلی سر جایشان ماندند. حالا می‌توانید آن را به امضامی بفرستید.'
          : 'نسخهٔ تازهٔ اقرارنامه تولید شد. سندهای قبلی سر جایشان ماندند. حالا می‌توانید آن را به امضامی بفرستید.';
      onDone(msg);
    },
  });

  const actions = useMemo(() => {
    const list: { key: Action; title: string; hint: string; disabled?: boolean }[] = [
      { key: 'stage_back', title: 'بازگشت به مرحلهٔ قبلی', hint: 'مرحله را به عقب ببرید و از آنجا ویرایش کنید. سندهای قبلی پاک نمی‌شوند.', disabled: !controls || controls.allowedTargetStages.length === 0 },
    ];
    if (kind === 'goods' && controls && controls.kind === 'goods') {
      list.push({
        key: 'resend_invoice', title: 'تولید فاکتور تازه', hint: 'یک نسخهٔ جدید ساخته می‌شود. فاکتورهای امضاشدهٔ قبلی معتبر می‌مانند.',
        disabled: !controls.allowedResendKinds.includes('invoice'),
      });
      list.push({
        key: 'resend_acknowledgement', title: 'تولید اقرارنامهٔ تازه', hint: 'یک نسخهٔ جدید ساخته می‌شود. نسخه‌های قبلی در سابقه می‌مانند.',
        disabled: !controls.allowedResendKinds.includes('acknowledgement'),
      });
    }
    return list;
  }, [kind, controls]);

  if (q.isLoading) return <Wizard title="بازگشت مرحله یا ارسال دوباره" testId="doc-resend-wizard" steps={STEPS} step={0} onClose={onClose} next={{ label: 'ادامه', disabled: true, onClick: () => undefined }}><p>در حال بارگذاری…</p></Wizard>;
  if (q.isError || !controls) {
    return <Wizard title="بازگشت مرحله یا ارسال دوباره" testId="doc-resend-wizard" steps={STEPS} step={0} onClose={onClose} next={{ label: 'بستن', onClick: onClose }}>
      <div className="gp-alert" role="alert">{q.error ? errText(q.error) : 'این قابلیت در دسترس نیست.'}</div>
    </Wizard>;
  }

  const canNext = step === 0 ? Boolean(action)
    : step === 1 ? (action === 'stage_back' ? Boolean(target) : true)
      : step === 2 ? reason.trim().length >= 5
        : !mutation.isPending;

  const goNext = () => {
    if (step < 3) { if (step === 0) setTarget(''); setStep(step + 1); return; }
    mutation.mutate();
  };

  const history = controls.kind === 'goods'
    ? (action === 'resend_acknowledgement' ? controls.documents.acknowledgement : controls.documents.invoice)
    : [];

  return <Wizard
    title="بازگشت مرحله یا ارسال دوباره"
    testId="doc-resend-wizard"
    steps={STEPS}
    step={step}
    onClose={onClose}
    onBack={step > 0 ? () => { mutation.reset(); setStep(step - 1); } : undefined}
    next={{
      label: step === 3 ? (mutation.isPending ? 'در حال ثبت…' : 'تأیید و اجرا') : 'ادامه',
      onClick: goNext,
      disabled: !canNext,
      tone: step === 3 ? 'danger' : 'primary',
      icon: step === 3 ? <Send size={15} /> : undefined,
      testId: 'button-doc-resend-next',
    }}
    summary={<span>مرحلهٔ فعلی: <b>{controls.stageLabel}</b></span>}
  >
    {step === 0 ? <div className="dr-choices" data-testid="doc-resend-step-action">
      {actions.map((a) => (
        <button type="button" key={a.key} className={`dr-choice${action === a.key ? ' on' : ''}`} aria-pressed={action === a.key} disabled={a.disabled} onClick={() => setAction(a.key)} data-testid={`choice-action-${a.key}`}>
          <span><strong>{a.title}</strong><small>{a.hint}</small></span>
        </button>
      ))}
      {controls.blockedTargetStages.length ? <p className="dr-locked">{BLOCK_REASON[controls.blockedTargetStages[0].reason] ?? 'برخی مراحل به خاطر ثبت مالی قابل انتخاب نیستند.'}</p> : null}
    </div> : null}

    {step === 1 && action === 'stage_back' ? <div className="dr-choices" data-testid="doc-resend-step-target">
      {controls.allowedTargetStages.map((s) => (
        <button type="button" key={s} className={`dr-choice${target === s ? ' on' : ''}`} aria-pressed={target === s} onClick={() => setTarget(s)} data-testid={`choice-stage-${s}`}>
          <span><strong>{labelFor(kind, s)}</strong><small>بازگشت از «{controls.stageLabel}» به این مرحله</small></span>
        </button>
      ))}
      {!controls.allowedTargetStages.length ? <p className="dr-locked">{BLOCK_REASON[controls.blockedTargetStages[0]?.reason] ?? 'مرحلهٔ قبلی برای بازگشت نیست.'}</p> : null}
    </div> : null}

    {step === 1 && action !== 'stage_back' ? <div data-testid="doc-resend-step-doc">
      <p>نسخهٔ تازه ساخته می‌شود و نسخه‌های قبلی، از جمله امضاشده‌ها، پاک یا جایگزین نمی‌شوند. بعد از تولید، ارسال به امضامی از همان صفحهٔ خرید انجام می‌شود.</p>
      {history.length ? <ul className="dr-history">{history.map((d) => (
        <li key={d.id}><span>نسخه {d.version.toLocaleString('fa-IR')}{d.invoiceNumber ? ` · شماره ${d.invoiceNumber}` : ''} · {docStatusLabel(d.status)}</span><span>{formatDateTime(d.createdAt)}</span></li>
      ))}</ul> : <p className="secondary-cell">هنوز سندی در سابقه نیست.</p>}
    </div> : null}

    {step === 2 ? <div className="field" data-testid="doc-resend-step-reason">
      <label htmlFor="doc-resend-reason">دلیل <b className="gp-req">*</b></label>
      <textarea id="doc-resend-reason" rows={4} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً اصلاح اقلام فاکتور یا ارسال نسخهٔ تازه برای امضا" data-testid="input-doc-resend-reason" />
      <small className="secondary-cell">حداقل ۵ حرف. این دلیل در سابقه ثبت می‌شود.</small>
    </div> : null}

    {step === 3 ? <div data-testid="doc-resend-step-confirm">
      <p>کار: <b>{actions.find((a) => a.key === action)?.title}</b></p>
      {action === 'stage_back' ? <p>مرحلهٔ جدید: <b>{labelFor(kind, target)}</b></p> : null}
      <p>دلیل: <b>{reason.trim()}</b></p>
      <p className="secondary-cell">سندهای قبلی حذف نمی‌شوند. اگر این کار را تأیید کنید، در سابقه با نام شما ثبت می‌شود.</p>
      {mutation.isError ? <div className="gp-alert" role="alert">{errText(mutation.error)}</div> : null}
    </div> : null}
  </Wizard>;
}

/** History of invoice / acknowledgement versions, shown to admin/SM when the flag is on. */
export function DocumentHistoryPanel({ controls }: { controls: GoodsAdminControls }) {
  const blocks: Array<{ title: string; rows: GoodsAdminControls['documents']['invoice'] }> = [
    { title: 'سابقهٔ فاکتور', rows: controls.documents.invoice },
    { title: 'سابقهٔ اقرارنامه', rows: controls.documents.acknowledgement },
  ];
  return <div className="panel gp-stage-panel" data-testid="doc-resend-history">
    <h3>سابقهٔ سندها</h3>
    {blocks.map((b) => (
      <div key={b.title}>
        <strong>{b.title}</strong>
        {b.rows.length ? <ul className="dr-history">{b.rows.map((d) => (
          <li key={d.id}><span>نسخه {d.version.toLocaleString('fa-IR')}{d.invoiceNumber ? ` · شماره ${d.invoiceNumber}` : ''} · {docStatusLabel(d.status)}</span><span>{formatDateTime(d.createdAt)}</span></li>
        ))}</ul> : <p className="secondary-cell">موردی نیست.</p>}
      </div>
    ))}
  </div>;
}

