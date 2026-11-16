export type SpeechWindow = { start: number; end: number };

// Cuts never remove a pause or any speech. Quiet speakers may also be detected
// as silence, so these points are used only to choose boundaries, not as VAD.
export function speechWindows(duration: number, pauses: number[]): SpeechWindow[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid audio duration");
  const valid = pauses.filter(x => Number.isFinite(x) && x > 0 && x < duration);
  const windows: SpeechWindow[] = [];
  let start = 0;
  while (start < duration) {
    const candidates = valid.filter(x => x >= start + 25 && x <= start + 50)
      .sort((a, b) => Math.abs(a - start - 45) - Math.abs(b - start - 45));
    const end = duration - start <= 55 ? duration : candidates[0] ?? Math.min(start + 45, duration);
    windows.push({ start, end });
    start = end;
  }
  return windows;
}

// Match only substantial exact overlaps; never correct words or numbers from
// neighbouring text, and retain short repetitions such as conversational "بله".
export function joinSpeechWindows(parts: string[]): string {
  const normalized = (x: string) => x.replace(/[ي]/g, "ی").replace(/[ك]/g, "ک")
    .replace(/[.,،؛:!?؟]/g, "").toLowerCase();
  let previous: string[] = [];
  const result: string[] = [];
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let overlap = 0;
    for (let count = Math.min(12, previous.length, words.length); count >= 3; count--) {
      if (previous.slice(-count).map(normalized).join(" ") === words.slice(0, count).map(normalized).join(" ")) {
        overlap = count; break;
      }
    }
    if (words.length > overlap) result.push(words.slice(overlap).join(" "));
    previous = words;
  }
  return result.join("\n");
}
