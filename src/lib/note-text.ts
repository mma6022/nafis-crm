/** NOTES-NOMAX: free-text notes/messages have no maximum length (only per-field minimums stay).
 *  noteText keeps line breaks (multi-line call-form notes): CRLF -> LF, runs of spaces/tabs -> one space,
 *  spaces around line breaks trimmed, 3+ blank lines -> one blank line, outer whitespace trimmed. */
export const noteText = (v: unknown): string =>
  String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
