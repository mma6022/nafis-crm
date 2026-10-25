import { useEffect, useState } from 'react';
import { AlertCircle, BellRing, Check, Clock, Info, Send, Undo2, X } from 'lucide-react';
import { fa, when, type SfJob, type SfPermission } from './api';

const hm = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }) : '—';

/** «اجازه‌ی استعلام» card on the job page — HANDOFF shots 33 (manager mode, not sent), 33b (sent), 33c (expert mode) and the
 *  rejected state «مدیر اجازه نداد». Every button maps to POST /api/smart-filing/jobs/:id/permission/<action>; the server is the gate. */
export function PermissionCard({ p, job, busy, act }: { p: NonNullable<SfPermission>; job: SfJob; busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const [line, setLine] = useState(false);
  const [left, setLeft] = useState(p.secondsToRemind ?? 0);
  useEffect(() => {
    if (p.secondsToRemind == null) { setLeft(0); return; }
    const deadline = Date.now() + p.secondsToRemind * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick(); const t = window.setInterval(tick, 1000); return () => window.clearInterval(t);
  }, [p.id, p.secondsToRemind, p.remindAt]);
  const step = p.stepLabel || 'استعلام اعتباری (بانک مرکزی)';
  const manager = p.approver === 'manager';
  const stateLabel = p.status === 'pending' ? 'در انتظار اجازه‌ی مدیر' : p.status === 'approved' ? 'اجازه داده شد' : p.status === 'rejected' ? (manager ? 'مدیر اجازه نداد' : 'اجازه داده نشد')
    : p.status === 'cancelled' ? 'لغو شد' : manager ? 'در انتظار اجازه‌ی مدیر' : 'منتظر اجازه‌ی شما';
  const tone = p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'bad' : p.status === 'cancelled' ? 'muted' : 'warn';
  if (p.status === 'cancelled') return null;
  const LineBox = () => (
    <label className="sf-perm-line"><input type="checkbox" checked={line} onChange={e => setLine(e.target.checked)} data-testid="sf-perm-line" /> خط موبایل به نام خود مشتری است</label>
  );
  return (
    <div className={`panel sf-perm ${tone}`} data-testid="sf-permission" data-status={p.status} data-approver={p.approver}>
      <div className="sf-perm-head">
        <span className="sf-sub">{step} — {stateLabel}</span>
        <span className={`sf-pill ${tone}`} data-testid="sf-perm-pill">{stateLabel}</span>
      </div>
      {p.status === 'pending' ? (
        <>
          <h3>درخواست برای مدیر فرستاده شد</h3>
          <div className="sf-perm-box warn"><b><Clock size={15} /> درخواست فرستاده شد — {hm(p.sentAt)}</b>
            <span>مدیر یک اعلان با «اجازه می‌دهم / رد» گرفت. جوابش همین‌جا و در زنگ اعلان می‌آید.{p.remindedAt ? ` آخرین یادآوری: ${hm(p.remindedAt)}` : ''}</span></div>
          <div className="sf-perm-box info"><Info size={15} /> الان کاری از شما لازم نیست. می‌توانید سراغ مشتری بعدی بروید.</div>
          <div className="sf-perm-actions">
            {p.canDecide ? <ManagerButtons busy={busy} act={act} /> : null}
            {p.canCancel ? <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('cancel')} data-testid="sf-perm-cancel">لغو درخواست</button> : null}
            {p.canCancel || p.canRemind ? <button className="nf-btn nf-btn-ghost" disabled={busy || !p.canRemind || left > 0} onClick={() => void act('remind')} data-testid="sf-perm-remind">
              <BellRing size={15} /> یادآوری به مدیر{left > 0 ? ` (از ${hm(p.remindAt)})` : ''}</button> : null}
          </div>
        </>
      ) : p.status === 'approved' ? (
        <div className="sf-perm-box ok" data-testid="sf-perm-approved"><Check size={15} /> اجازه‌ی استعلام را {p.decidedByName || '—'} داد ({when(p.decidedAt)}). سارینا ادامه می‌دهد.</div>
      ) : p.status === 'rejected' ? (
        <>
          <h3>{manager ? 'مدیر اجازه نداد' : 'اجازه‌ی استعلام داده نشد'}</h3>
          <div className="sf-perm-box bad" data-testid="sf-perm-rejected"><X size={15} /> {p.decidedByName || 'مدیر'} در {when(p.decidedAt)} اجازه‌ی استعلام نداد. سارینا استعلام نمی‌گیرد و منتظر می‌ماند.</div>
          {p.canReturn ? <div className="sf-perm-actions"><button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('return')} data-testid="sf-perm-return"><Undo2 size={15} /> برگرداندن به کارشناس</button></div> : null}
        </>
      ) : manager ? (
        <>
          <h3>{step}</h3>
          <p className="sf-perm-lead">برای این مرحله اجازه‌ی مدیر لازم است. درخواست را بفرستید؛ تا جواب مدیر، سارینا صبر می‌کند.</p>
          <div className="sf-perm-box warn"><AlertCircle size={15} /> این مرحله {p.costText || 'حدود ۱۵ هزار تومان'} هزینه دارد و ممکن است برای مشتری پیامک کد برود.</div>
          {p.status === 'later' ? <div className="sf-perm-box info"><Info size={15} /> «فعلاً نه» زده شد؛ هر وقت آماده بودید درخواست را بفرستید.</div> : null}
          {p.canSend ? <LineBox /> : null}
          <div className="sf-perm-actions col">
            {p.canSend ? <button className="nf-btn nf-btn-primary" disabled={busy || !line} onClick={() => void act('send', { lineConfirmed: true })} data-testid="sf-perm-send"><Send size={15} /> فرستادن درخواست به مدیر</button> : null}
            {p.canDecide ? <ManagerButtons busy={busy} act={act} /> : null}
            {p.canLater ? <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('later')} data-testid="sf-perm-later">فعلاً نه</button> : null}
          </div>
        </>
      ) : (
        <>
          <h3>{step}</h3>
          <p className="sf-perm-lead">برای این مرحله اجازه‌ی شما لازم است (تنظیم «اجازه‌ی استعلام» روی کارشناس است).</p>
          <div className="sf-perm-box warn"><AlertCircle size={15} /> این مرحله {p.costText || 'حدود ۱۵ هزار تومان'} هزینه دارد و ممکن است برای مشتری پیامک کد برود.</div>
          {p.status === 'later' ? <div className="sf-perm-box info"><Info size={15} /> «فعلاً نه» زده شد؛ سارینا منتظر می‌ماند.</div> : null}
          {p.canDecide ? <LineBox /> : null}
          <div className="sf-perm-actions col">
            {p.canDecide ? <button className="nf-btn nf-btn-primary" disabled={busy || !line} onClick={() => void act('decide', { approve: true, lineConfirmed: true })} data-testid="sf-perm-expert-approve"><Check size={15} /> اجازه می‌دهم، ادامه بده</button> : null}
            {p.canLater ? <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => void act('later')} data-testid="sf-perm-later">فعلاً نه</button> : null}
          </div>
        </>
      )}
      {job.jobType === 'training' ? <span className="sf-sub">کار آموزشی · مرحله‌ی {fa(job.progress)}٪</span> : null}
    </div>
  );
}

function ManagerButtons({ busy, act }: { busy: boolean; act: (path: string, body?: unknown) => Promise<boolean> }) {
  return (
    <span className="sf-perm-mgr" data-testid="sf-perm-manager">
      <button className="nf-btn nf-btn-primary" disabled={busy} onClick={() => void act('decide', { approve: true })} data-testid="sf-perm-approve"><Check size={15} /> اجازه می‌دهم</button>
      <button className="nf-btn nf-btn-ghost" disabled={busy} onClick={() => { if (window.confirm('اجازه‌ی استعلام رد شود؟')) void act('decide', { approve: false }); }} data-testid="sf-perm-reject"><X size={15} /> رد</button>
    </span>
  );
}
