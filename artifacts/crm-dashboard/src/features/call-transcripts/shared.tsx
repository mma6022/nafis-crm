import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock3, Copy, EyeOff, X } from 'lucide-react';
import { fa, statusOf, TXS, txSub, type CtRow } from './api';

export function StatusChip({ status }: { status: string }) {
  const [t, c] = statusOf(status);
  return <span className={`chip ${c} cst`}>{c === 's' ? <Check className="i" /> : <X className="i" />}{t}</span>;
}
export function TextChip({ row, sub }: { row: Pick<CtRow, 'textState' | 'textPhase'>; sub?: string }) {
  const [t, c] = TXS[row.textState]; const s = sub ?? txSub(row);
  const Icon = row.textState === 'completed' ? CheckCircle2 : row.textState === 'failed' ? AlertTriangle : row.textState === 'no_recording' ? EyeOff : Clock3;
  return <span className={`chip ${c} txs t-${row.textState}`} data-testid="ct-text-state"><Icon className="i" />{t}{s ? <small>({s})</small> : null}</span>;
}
export function Phone({ phone }: { phone: string | null }) {
  const [done, setDone] = useState(false);
  if (!phone) return <span className="muted">بدون شماره</span>;
  return <span className="ci-d"><bdi dir="ltr">{fa(phone)}</bdi>
    <button type="button" className="btn lk" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(phone).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
      aria-label="کپی شماره"><Copy className="i" />{done ? 'کپی شد' : 'کپی'}</button></span>;
}
