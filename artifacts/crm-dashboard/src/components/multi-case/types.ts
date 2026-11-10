export type MultiCaseRow = {
  id: number; planId: number | null; planName: string | null; bankName?: string | null;
  stage: string | null; status: string; open: boolean;
};
export const faCase = (id: number) => id.toLocaleString("fa-IR");
