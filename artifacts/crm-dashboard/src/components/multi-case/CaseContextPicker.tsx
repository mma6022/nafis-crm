import { useEffect } from "react";
import type { MultiCaseRow } from "./types";

export type CaseChoice = number | "general";

export type McCustomer = { n: string; id: number; phone?: string; owner?: string };

/** Designer shell (public/multi-case/index.html). Default scenes match her sample DOM. */
export function mcDesignSrc(scene: string, extra?: Record<string, string | undefined>) {
  const q = new URLSearchParams({ sc: scene });
  for (const [key, value] of Object.entries(extra ?? {})) if (value) q.set(key, value);
  return `/multi-case/index.html?${q.toString()}`;
}

export function mcLiveQuery(customer: McCustomer, cases: Array<{ id: number; p: string; a: string; m: string; s: string; stage: string; date: string }>) {
  return { live: "1", payload: encodeURIComponent(JSON.stringify({ customer, cases })) };
}

export function McFrame({
  src, title, embed, onNav,
}: {
  src: string;
  title: string;
  embed?: boolean;
  onNav?: (href: string, assoc: string | null) => void;
}) {
  useEffect(() => {
    if (!onNav) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "mc-nav" || data.type === "mc-choice") onNav(String(data.href || ""), data.assoc == null ? null : String(data.assoc));
      if (data.type === "mc-reminder") onNav(`reminder`, data.assoc == null ? "general" : String(data.assoc));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onNav]);
  return <iframe className={embed ? "mc-frame-embed" : "mc-frame-full"} src={src} title={title} data-testid={embed ? "mc-embed" : "mc-frame"} />;
}

/** Full-screen designer picker. General is the default, matching her scene. */
export function CaseContextPicker({
  mode, customer, cases, onConfirm, onClose,
}: {
  mode: "call" | "reminder";
  customer: McCustomer;
  cases: MultiCaseRow[];
  onConfirm: (choice: CaseChoice) => void;
  onClose: () => void;
}) {
  const rows = cases.filter((row) => row.open).map((row) => ({
    id: row.id,
    p: row.planName || "طرح",
    a: "—",
    m: "—",
    s: "باز",
    stage: row.stage || "پرونده",
    date: "",
  }));
  const src = mcDesignSrc(mode === "reminder" ? "reminder_case_picker" : "call_case_picker", mcLiveQuery(customer, rows.length ? rows : cases.map((row) => ({
    id: row.id, p: row.planName || "طرح", a: "—", m: "—", s: row.open ? "باز" : "بسته", stage: row.stage || "", date: "",
  }))));
  return (
    <div className="mc-frame-host" data-testid="case-context-picker">
      <button type="button" className="mc-frame-close" onClick={onClose}>بستن</button>
      <McFrame title={mode === "reminder" ? "انتخاب پرونده برای یادآور" : "انتخاب پرونده برای تماس"} src={src} onNav={(_href, assoc) => {
        onConfirm(assoc && assoc !== "general" && Number(assoc) > 0 ? Number(assoc) : "general");
      }} />
    </div>
  );
}

export function SamePlanBlock({ planName, caseId }: { planName: string; caseId: number }) {
  return (
    <p className="mc-warning" role="alert" data-testid="same-plan-block">
      {planName} در پرونده #{caseId.toLocaleString("fa-IR")} باز است. تا لغو یا تکمیل آن، پروندهٔ تازه با همین طرح ساخته نمی‌شود. طرح دیگر آزاد است و هزینهٔ هر پرونده جدا حساب می‌شود.
    </p>
  );
}
