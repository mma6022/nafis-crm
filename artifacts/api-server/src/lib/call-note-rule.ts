/**
 * crm-call-note-min: one rule for every «ثبت تماس» note (team-sales call form,
 * first-call edit, legacy call form, after-call result, call report).
 * The note is trimmed first; length counts code points, so whitespace-only fails.
 */
export const CALL_NOTE_MIN = 10;

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const fa = (n: number) => String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

export function callNoteLength(note: unknown): number {
  return typeof note === "string" ? [...note.trim()].length : 0;
}

export function callNoteMinMessage(min = CALL_NOTE_MIN): string {
  return `یادداشت تماس حداقل ${fa(min)} نویسه باشد.`;
}

/** Returns the Persian error message when the note is too short, else null. */
export function callNoteError(note: unknown, min = CALL_NOTE_MIN): string | null {
  return callNoteLength(note) < min ? callNoteMinMessage(min) : null;
}
