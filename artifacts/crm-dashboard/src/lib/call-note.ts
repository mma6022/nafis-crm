/* crm-call-note-min: the one client rule for every «ثبت تماس» note (mirrors api-server lib/call-note-rule.ts).
   Trim first, count code points; whitespace-only is 0. */
export const CALL_NOTE_MIN = 10;
const FA = '۰۱۲۳۴۵۶۷۸۹';
export const faNum = (n: number) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
export const callNoteLength = (note: string | null | undefined) => [...(note ?? '').trim()].length;
export const callNoteMinMessage = (min = CALL_NOTE_MIN) => `یادداشت تماس حداقل ${faNum(min)} نویسه باشد.`;
export const callNoteOk = (note: string | null | undefined, min = CALL_NOTE_MIN) => callNoteLength(note) >= min;
/** «۷ / ۱۰» */
export const callNoteCounterText = (note: string | null | undefined, min = CALL_NOTE_MIN) => `${faNum(callNoteLength(note))} / ${faNum(min)}`;
