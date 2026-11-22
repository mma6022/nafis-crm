import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Send } from 'lucide-react';
import { Wizard } from '@/components/goods/GpKit';
import { docStatusLabel, errText, faId, stageLabel, poStageLabel } from '@/lib/goods-api';
import { formatDateTime } from '@/components/CrmShell';
import {
  useAdminControls, postGoodsStage, postPaymentStage, postGoodsResend, BLOCK_REASON, BLOCK_REASON_SHORT,
  PREVIOUS_UNSIGNED_EMZAMI_CANCELLED, PREVIOUS_EMZAMI_CANCEL_TEXT, BALE_NOTIFY_CONFIRM_TEXT, historyBadges,
  type AdminControls, type GoodsAdminControls, type HistoryDoc,
} from './api';
import './doc-resend.css';

const STEPS = ['انتخاب کار', 'انتخاب مرحله یا سند', 'دلیل', 'تأیید'];
type Action = 'stage_back' | 'resend_invoice' | 'resend_acknowledgement';

function labelFor(kind: 'goods' | 'payment', stage: string) {
  return kind === 'goods' ? stageLabel(stage) : poStageLabel(stage);
}

function nextVersion(docs: HistoryDoc[]) {
  return (docs.reduce((m, d) => Math.max(m, d.version), 0) + 1);
}

function hasOpenSignatureRequest(docs: HistoryDoc[]) {
  return docs.some((d) => ['sending', 'sent', 'delivery_unknown'].includes(d.status));
}

type Effect = { removed?: string; remains?: string; notes: string[] };

function confirmEffect(kind: 'goods' | 'payment', action: Action, controls: AdminControls, target: string): Effect {
  const notes: string[] = [];
  if (action === 'resend_invoice' && controls.kind === 'goods') {
    const docs = controls.documents.invoice;
    const next = nextVersion(docs);
    const prev = next - 1;
    notes.push(prev > 0
      ? `نسخهٔ ${faId(next)} ساخته می‌شود؛ نسخهٔ ${faId(prev)} سر جایش می‌ماند`
      : `نسخهٔ ${faId(next)} ساخته می‌شود`);
    if (PREVIOUS_UNSIGNED_EMZAMI_CANCELLED && hasOpenSignatureRequest(docs)) notes.push(PREVIOUS_EMZAMI_CANCEL_TEXT);
    if (controls.baleNotify) notes.push(BALE_NOTIFY_CONFIRM_TEXT);
    return { remains: 'فاکتورهای قبلی در سابقه می‌مانند و حذف نمی‌شوند.', notes };
  }
  if (action === 'resend_acknowledgement' && controls.kind === 'goods') {
    const docs = controls.documents.acknowledgement;
    const next = nextVersion(docs);
    const prev = next - 1;
    notes.push(prev > 0
      ? `نسخهٔ ${faId(next)} ساخته می‌شود؛ نسخهٔ ${faId(prev)} سر جایش می‌ماند`
      : `نسخهٔ ${faId(next)} ساخته می‌شود`);
    if (PREVIOUS_UNSIGNED_EMZAMI_CANCELLED && hasOpenSignatureRequest(docs)) notes.push(PREVIOUS_EMZAMI_CANCEL_TEXT);
    if (controls.baleNotify) notes.push(BALE_NOTIFY_CONFIRM_TEXT);
    return { remains: 'اقرارنامه‌های قبلی در سابقه می‌مانند و حذف نمی‌شوند.', notes };
  }

  // stage_back
  if (kind === 'payment') {
    if (controls.stage === 'paid') {
      notes.push('پرداخت برگشت می‌خورد و سند حسابداری جبرانی ثبت می‌شود');
      return {
        removed: 'وضعیت «پرداخت‌شده» و ثبت‌های حسابداری همان پرداخت',
        remains: 'سابقه، رسید و حساب مقصد در بایگانی می‌مانند.',
        notes,
      };
    }
    const stamps: string[] = [];
    if (controls.stage === 'awaiting_payment' || controls.stage === 'admin_approval') {
      if (target === 'sales_approval') stamps.push('تأیید فروش');
      if (controls.stage === 'awaiting_payment' && (target === 'sales_approval' || target === 'admin_approval')) stamps.push('تأیید مدیریت');
    }
    return {
      removed: stamps.length ? stamps.join(' و ') : undefined,
      remains: 'سابقهٔ دستور و اطلاعات حساب مقصد می‌ماند.',
      notes,
    };
  }

  // goods stage-back
  if (controls.kind !== 'goods') return { notes };
  const invoices = controls.documents.invoice;
  const acks = controls.documents.acknowledgement;
  const signedInv = invoices.filter((d) => d.status === 'signed');
  const from = controls.stage;
  const preSettlement = ['invoice_draft', 'invoice_signature'].includes(target);
  if (preSettlement && ['invoice_signature', 'settlement_pending'].includes(from)) {
    return {
      removed: 'امضای ثبت‌شدهٔ فاکتور روی پرونده (برای ادامه، امضای تازه لازم است)',
      remains: signedInv.length
        ? `فاکتور ${signedInv.map((d) => `نسخهٔ ${faId(d.version)}`).join(' و ')} در سابقه می‌ماند`
        : 'سندهای قبلی در سابقه می‌مانند و حذف نمی‌شوند.',
      notes,
    };
  }
  if (from === 'registrar_confirmation' && (target === 'acknowledgement_signature' || target === 'settlement_pending')) {
    return {
      removed: 'ثبت «اقرارنامه امضا شد» روی پرونده',
      remains: 'اقرارنامهٔ قبلی در سابقه می‌ماند و حذف نمی‌شود.',
      notes,
    };
  }
  return { remains: 'سندهای قبلی در سابقه می‌مانند و حذف نمی‌شوند.', notes };
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
    const blockedReason = controls?.blockedTargetStages[0]?.reason;
    const stageDisabled = !controls || controls.allowedTargetStages.length === 0;
    const list: { key: Action; title: string; hint: string; disabled?: boolean }[] = [
      {
        key: 'stage_back',
        title: 'بازگشت به مرحلهٔ قبلی',
        hint: stageDisabled ? (BLOCK_REASON_SHORT[blockedReason ?? ''] ?? 'مرحلهٔ قبلی برای بازگشت نیست.') : 'مرحله را به عقب ببرید. سندهای قبلی پاک نمی‌شوند.',
        disabled: stageDisabled,
      },
    ];
    if (kind === 'goods' && controls && controls.kind === 'goods') {
      list.push({
        key: 'resend_invoice', title: 'تولید فاکتور تازه', hint: 'فاکتورهای امضاشدهٔ قبلی سر جایشان می‌مانند.',
        disabled: !controls.allowedResendKinds.includes('invoice'),
      });
      list.push({
        key: 'resend_acknowledgement', title: 'تولید اقرارنامهٔ تازه', hint: 'نسخه‌های قبلی در سابقه می‌مانند.',
        disabled: !controls.allowedResendKinds.includes('acknowledgement'),
      });
    }
    return list;
  }, [kind, controls]);

  if (q.isLoading) return <Wizard title="بازگشت مرحله یا ارسال دوباره" testId="doc-resend-wizard" steps={STEPS} step={0} onClose={onClose} next={{ label: 'ادامه', disabled: true, onClick: () => undefined }}><p>در حال بارگذاری…</p></Wizard>;
  if (q.isError || !controls) {
    return <Wizard title="بازگشت مرحله یا ارسال دوباره" testId="doc-resend-wizard" steps={STEPS} step={0} onClose={onClose} next={{ label: 'دوباره تلاش کنید', onClick: () => { void q.refetch(); }, testId: 'button-doc-resend-retry' }}>
      <div className="gp-alert" role="alert" data-testid="doc-resend-network-error">{q.error ? errText(q.error) : 'این قابلیت در دسترس نیست.'}</div>
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
  const historyKind: 'invoice' | 'acknowledgement' = action === 'resend_acknowledgement' ? 'acknowledgement' : 'invoice';
  const reasonLen = reason.trim().length;
  const effect = action ? confirmEffect(kind, action, controls, target) : { notes: [] as string[] };
  const pathLabel = action === 'stage_back' && target ? `از ${controls.stageLabel} ← به ${labelFor(kind, target)}` : null;

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
    summary={step === 0 ? <span className="dr-stage-badge">مرحلهٔ فعلی: <b>{controls.stageLabel}</b></span> : undefined}
  >
    {step === 0 ? <div className="dr-choices" data-testid="doc-resend-step-action">
      {actions.map((a) => (
        <button type="button" key={a.key} className={`dr-choice${action === a.key ? ' on' : ''}`} aria-pressed={action === a.key} disabled={a.disabled} onClick={() => setAction(a.key)} data-testid={`choice-action-${a.key}`}>
          <span><strong>{a.title}</strong>{a.hint ? <small>{a.hint}</small> : null}</span>
        </button>
      ))}
      {controls.blockedTargetStages.length ? <p className="dr-locked">{BLOCK_REASON[controls.blockedTargetStages[0].reason] ?? 'برخی مراحل به خاطر ثبت مالی قابل انتخاب نیستند.'}</p> : null}
    </div> : null}

    {step === 1 && action === 'stage_back' ? <div className="dr-choices" data-testid="doc-resend-step-target">
      {controls.allowedTargetStages.map((s) => (
        <button type="button" key={s} className={`dr-choice${target === s ? ' on' : ''}`} aria-pressed={target === s} onClick={() => setTarget(s)} data-testid={`choice-stage-${s}`}>
          <span><strong>{labelFor(kind, s)}</strong></span>
        </button>
      ))}
      {controls.blockedTargetStages.map((b) => (
        <button type="button" key={b.stage} className="dr-choice" disabled data-testid={`choice-stage-blocked-${b.stage}`}>
          <span><strong>{labelFor(kind, b.stage)}</strong><small>{BLOCK_REASON_SHORT[b.reason] ?? BLOCK_REASON[b.reason] ?? 'قابل انتخاب نیست.'}</small></span>
        </button>
      ))}
      {!controls.allowedTargetStages.length ? <p className="dr-locked">{BLOCK_REASON[controls.blockedTargetStages[0]?.reason] ?? 'مرحلهٔ قبلی برای بازگشت نیست.'}</p> : null}
    </div> : null}

    {step === 1 && action !== 'stage_back' ? <div data-testid="doc-resend-step-doc">
      <p className="dr-doc-note">نسخهٔ {faId(nextVersion(history))} ساخته می‌شود.</p>
      {history.length ? <ul className="dr-history">{history.map((d) => (
        <li key={d.id}>
          <span>نسخه {faId(d.version)}{d.invoiceNumber ? ` · شماره ${d.invoiceNumber}` : ''} · {historyBadges(historyKind, history, d, docStatusLabel).join(' · ')}</span>
          <span>{formatDateTime(d.createdAt)}</span>
        </li>
      ))}</ul> : <p className="secondary-cell" data-testid="doc-resend-empty-docs">هنوز سندی در سابقه نیست.</p>}
    </div> : null}

    {step === 2 ? <div className="field" data-testid="doc-resend-step-reason">
      <label htmlFor="doc-resend-reason">دلیل <b className="gp-req">*</b></label>
      <textarea id="doc-resend-reason" className="dr-reason" rows={4} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً اصلاح اقلام فاکتور یا ارسال نسخهٔ تازه برای امضا" data-testid="input-doc-resend-reason" />
      <div className="dr-reason-meta">
        {reasonLen < 5 ? <small className="dr-reason-hint" data-testid="doc-resend-reason-hint">دلیل را دست‌کم ۵ حرف بنویسید</small> : <small className="secondary-cell">این دلیل در سابقه ثبت می‌شود.</small>}
        <small className="dr-reason-count" data-testid="doc-resend-reason-count">{reasonLen < 5 ? `${faId(reasonLen)} از ۵` : `${faId(reasonLen)} حرف`}</small>
      </div>
    </div> : null}

    {step === 3 ? <div data-testid="doc-resend-step-confirm" className="dr-confirm">
      <div className="dr-kv"><span>کار</span><b>{actions.find((a) => a.key === action)?.title}</b></div>
      {pathLabel ? <div className="dr-kv"><span>مسیر</span><b>{pathLabel}</b></div> : null}
      <div className="dr-kv"><span>دلیل</span><b>{reason.trim()}</b></div>
      <div className="dr-effect" role="status">
        {effect.removed ? <p><strong>برداشته می‌شود: </strong>{effect.removed}</p> : null}
        {effect.remains ? <p><strong>می‌ماند: </strong>{effect.remains}</p> : null}
        {effect.notes.map((n) => <p key={n}>{n}</p>)}
      </div>
      {mutation.isError ? <div className="gp-alert" role="alert">{errText(mutation.error)}</div> : null}
    </div> : null}
  </Wizard>;
}

/** History of invoice / acknowledgement versions, shown to admin/SM when the flag is on. */
export function DocumentHistoryPanel({ controls }: { controls: GoodsAdminControls }) {
  const blocks: Array<{ title: string; kind: 'invoice' | 'acknowledgement'; rows: HistoryDoc[] }> = [
    { title: 'سابقهٔ فاکتور', kind: 'invoice', rows: controls.documents.invoice },
    { title: 'سابقهٔ اقرارنامه', kind: 'acknowledgement', rows: controls.documents.acknowledgement },
  ];
  return <div className="panel gp-stage-panel" data-testid="doc-resend-history">
    <h3>سابقهٔ سندها</h3>
    {blocks.map((b) => (
      <div key={b.title}>
        <strong>{b.title}</strong>
        {b.rows.length ? <ul className="dr-history">{b.rows.map((d) => (
          <li key={d.id}>
            <span>نسخه {faId(d.version)}{d.invoiceNumber ? ` · شماره ${d.invoiceNumber}` : ''} · {historyBadges(b.kind, b.rows, d, docStatusLabel).join(' · ')}</span>
            <span>{formatDateTime(d.createdAt)}</span>
          </li>
        ))}</ul> : <p className="secondary-cell">موردی نیست.</p>}
      </div>
    ))}
  </div>;
}
