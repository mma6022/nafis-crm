/* Queue-card lines: «فوری · flagger · reason» and the intake line (جدید / source / rank / registrar / note first line). */
import type { Badge } from './api';
import './lead-intake.css';
export function QueueLine({ b }: { b?: Badge }) {
  if (!b) return null;
  return <>
    {b.urgent ? <p className="li-qline urg" data-testid="li-q-urgent">فوری{b.urgent.by ? ` · ${b.urgent.by}` : ''}{b.urgent.reason ? ` · ${b.urgent.reason}` : ''}</p> : null}
    {b.intake ? <p className="li-qline" data-testid="li-q-intake">
      {b.intake.isNew ? <span className="li-tag new">جدید</span> : null}
      <span className="li-tag">{b.intake.leadSourceLabel}</span>
      {b.intake.rank !== 'unknown' ? <span className="li-tag rank">رتبه {b.intake.rankLabel}</span> : null}
      {b.intake.registrarName ? <span>ثبت: {b.intake.registrarName}</span> : null}
      {b.intake.noteFirstLine ? <span>«{b.intake.noteFirstLine}»</span> : null}
    </p> : null}
  </>;
}
