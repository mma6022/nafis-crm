import { mcDesignSrc } from "@/components/multi-case/CaseContextPicker";

const SCENES = [
  ["01", "customer_multiple", "مشتری و پرونده‌ها"],
  ["02", "files_multiple", "فهرست پرونده‌ها"],
  ["03", "second_case_start", "شروع درخواست دوم"],
  ["04", "wizard_plan", "طرح و شرط"],
  ["05", "wizard_review", "بازبینی"],
  ["06", "second_case_created", "پرونده‌ی دوم ساخته شد"],
  ["07", "call_case_picker", "انتخاب پرونده برای تماس"],
  ["08", "file_call_active", "تماس داخل پرونده"],
  ["09", "reminder_case_picker", "انتخاب پرونده برای یادآور"],
  ["10", "general_customer_call", "تماس عمومی"],
  ["11", "support_restricted", "نمای پشتیبانی"],
] as const;

/** Dev route: the designer shell, unchanged sample scenes. */
export default function MultiCasePreview() {
  const params = new URLSearchParams(window.location.search);
  const scene = params.get("sc") || "customer_multiple";
  return (
    <iframe
      title={scene}
      src={mcDesignSrc(scene, { shot: "1" })}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0 }}
      data-testid="multi-case-preview"
    />
  );
}

export const MULTI_CASE_SCENES = SCENES;
