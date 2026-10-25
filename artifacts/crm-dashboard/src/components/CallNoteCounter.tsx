import { CALL_NOTE_MIN, callNoteCounterText, callNoteMinMessage, callNoteOk, faNum } from '@/lib/call-note';
import './CallNoteCounter.css';

/* crm-call-note-min: live «۷ / ۱۰» counter under a call-note textarea. It reads the same value the
   textarea shows, so typed, pasted and voice-to-text text all update it. */
export function CallNoteCounter({ value, min = CALL_NOTE_MIN, showError, id, testId = 'call-note-counter' }: {
  value: string; min?: number; showError?: boolean; id?: string; testId?: string;
}) {
  const ok = callNoteOk(value, min);
  return <div className="call-note-meta" id={id} data-testid={`${testId}-meta`}>
    <span className={showError && !ok ? 'bad' : ''} role={showError && !ok ? 'alert' : undefined} data-testid={`${testId}-msg`}>
      {showError && !ok ? callNoteMinMessage(min) : `حداقل ${faNum(min)} نویسه`}
    </span>
    <span className={ok ? 'okc' : showError ? 'bad' : ''} dir="rtl" aria-live="polite" data-testid={testId}>{callNoteCounterText(value, min)}</span>
  </div>;
}
