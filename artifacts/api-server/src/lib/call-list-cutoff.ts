// 12 Mehr 1405, inclusive, midnight in Iran. Display restriction, not deletion.
export const CALL_LIST_FROM = "2026-10-04";
export const CALL_LIST_START = "2026-10-04T00:00:00+03:30";
export const callIsInDisplayPeriod = (startedAt: string) => Date.parse(startedAt) >= Date.parse(CALL_LIST_START);