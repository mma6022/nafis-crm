import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

export type TimelineStep = { key: string; title: string; summary: string; status: 'done' | 'active' | 'future'; content?: ReactNode };

/** Horizontal prerequisites with status and content for the current step only. */
export function RegistrationTimeline({ steps }: { steps: TimelineStep[] }) {
  const current = steps.find(step => step.status === 'active');
  return <div className="cp-timeline">
    <ol className="cp-tl" aria-label="پیش‌نیازهای ثبت درخواست" tabIndex={0}>
      {steps.map((s, i) => <li key={s.key} className={`cp-tl-item ${s.status}`} aria-current={s.status === 'active' ? 'step' : undefined} data-testid={`step-${s.key}`}>
        <span className="cp-tl-mark" aria-hidden="true">{s.status === 'done' ? <Check size={13} /> : (i + 1).toLocaleString('fa-IR')}</span>
        <strong>{s.title}</strong>
      </li>)}
    </ol>
    {current && <section className="cp-tl-current" aria-label={`مرحله جاری: ${current.title}`}>
      <div className="cp-tl-current-head" role="status"><strong>{current.title}</strong><small>مرحله جاری</small></div>
      {current.summary && <p className="cp-tl-sum">{current.summary}</p>}
      {current.content && <div className="cp-tl-content">{current.content}</div>}
    </section>}
  </div>;
}
