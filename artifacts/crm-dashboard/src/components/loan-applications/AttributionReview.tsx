import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDate } from "@/components/CrmShell";
import { getListLoanApplicationsQueryKey } from "@workspace/api-client-react";

type Revision = {
  id: number; previousSalespersonId: number | null; previousSalespersonName: string | null;
  salespersonId: number; salespersonName: string; reason: string; createdAt: string;
  actorId: number; actorName: string | null; actorUsername: string | null;
};
type Case = {
  id: number; customerId: number; customerName: string; consultationId: number;
  planName: string | null; createdAt: string; stage: string; status: string;
  requestedAmount: string; approvedAmount: string | null;
  salespersonId: number | null; salespersonName: string | null;
  currentSalespersonId: number | null; currentSalespersonName: string | null;
  requester: { id: number; name: string | null; username: string | null; currentSalespersonId: number | null };
  calls: { id: number; createdAt: string; salespersonId: number | null; salespersonName: string | null }[];
  history: { createdAt: string; action: string; actorId: number; actorName: string | null }[];
  revisions: Revision[];
};
type ReviewResponse = {
  items: Case[]; total: number; page: number; pageSize: number;
  salespersons: { id: number; name: string; active: number }[];
};
type Estimate = { baseAmountToman: string; baseType: string; ratePercent: number; estimatedAmountToman: string; provisional: boolean };

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    credentials: "same-origin",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.code === "unchanged" ? "این کارشناس قبلاً تأیید شده است." : `ثبت ناموفق بود (${response.status}). دوباره تلاش کنید.`);
  }
  return response.json();
}

export function AttributionReview() {
  const client = useQueryClient();
  const [status, setStatus] = useState<"pending" | "reviewed">("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [rates, setRates] = useState<Record<number, string>>({});
  const [estimates, setEstimates] = useState<Record<number, Estimate>>({});
  const reviews = useQuery({
    queryKey: ["loan-attribution-review", status, page],
    queryFn: () => request<ReviewResponse>(`/api/loan-applications/attribution-review?status=${status}&page=${page}`),
    staleTime: 15_000,
  });
  const save = useMutation({
    mutationFn: ({ id, salespersonId, reason }: { id: number; salespersonId: number; reason: string }) =>
      request(`/api/loan-applications/${id}/attribution-review`, { salespersonId, reason }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["loan-attribution-review"] });
      void client.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
      setSelected({}); setReasons({}); setEstimates({});
    },
  });
  const estimate = useMutation({
    mutationFn: ({ id, ratePercent }: { id: number; ratePercent: number }) =>
      request<Estimate>(`/api/loan-applications/${id}/commission-estimate`, { ratePercent }),
    onSuccess: (data, variables) => setEstimates((previous) => ({ ...previous, [variables.id]: data })),
  });

  return <section className="panel" style={{ marginTop: 20 }} data-testid="loan-attribution-review">
    <div className="panel-head"><div>
      <h3>بازبینی مالکیت تاریخی پرونده‌ها</h3>
      <p>مالک فعلی مشتری و اتصال فعلی حساب کاربری فقط شواهد کمکی‌اند؛ تعیین کارشناس قدیمی نیازمند بررسی و تأیید مدیر است. این بازبینی پورسانتی ثبت یا پرداخت نمی‌کند.</p>
    </div></div>
    <div style={{ display: "flex", gap: 8, margin: "14px 0" }}>
      <button className={`btn ${status === "pending" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setStatus("pending"); setPage(1); }}>در انتظار بازبینی</button>
      <button className={`btn ${status === "reviewed" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setStatus("reviewed"); setPage(1); }}>تأییدشده / اصلاح‌شده</button>
    </div>
    {reviews.isLoading ? <p>در حال دریافت پرونده‌ها...</p> : reviews.isError ? <p role="alert">دریافت پرونده‌ها ناموفق بود. <button onClick={() => void reviews.refetch()}>تلاش دوباره</button></p> : null}
    {reviews.data && <p className="secondary-cell">{reviews.data.total.toLocaleString("fa-IR")} پرونده · صفحه {page.toLocaleString("fa-IR")}</p>}
    {reviews.data?.items.length === 0 && <p>پرونده‌ای در این بخش نیست.</p>}
    {reviews.data?.items.map((item) => <article key={item.id} style={{ borderTop: "1px solid #e2e8f0", padding: "18px 0" }}>
      <h4><Link href={`/loan-applications/${item.id}`}>پرونده #{item.id} · {item.customerName}</Link></h4>
      <p>مشتری #{item.customerId} · مشاوره #{item.consultationId} · {item.planName || "طرح نامشخص"} · ثبت: {formatDate(item.createdAt)} · مرحله: {item.stage} / {item.status}</p>
      <p>مبلغ درخواستی: {Number(item.requestedAmount).toLocaleString("fa-IR")} تومان
        {item.approvedAmount ? ` · مبلغ مصوب: ${Number(item.approvedAmount).toLocaleString("fa-IR")} تومان` : ""}</p>
      <p>کارشناس ثبت‌شده در پرونده: {item.salespersonName ? `${item.salespersonName} (#${item.salespersonId})` : "نامشخص"}</p>
      <p>مالک فعلی مشتری: {item.currentSalespersonName ? `${item.currentSalespersonName} (#${item.currentSalespersonId})` : "نامشخص"} ·
        درخواست‌دهنده: {item.requester.name || item.requester.username || `#${item.requester.id}`} (اتصال فعلی: {item.requester.currentSalespersonId ?? "نامشخص"})</p>
      <details><summary>شواهد تماس و اقدامات پرونده</summary>
        <p>تماس‌های ثبت‌شده تا زمان ایجاد پرونده (حداکثر ۵ مورد):</p>
        {item.calls.length ? <ul>{item.calls.map((call) => <li key={call.id}>#{call.id} · {formatDate(call.createdAt)} · {call.salespersonName || "نام نامشخص"} (شناسه {call.salespersonId ?? "نامشخص"})</li>)}</ul> : <p>تماس ثبت‌شده‌ای یافت نشد.</p>}
        <p>اولین اقدامات ثبت‌شده:</p>
        {item.history.length ? <ul>{item.history.map((entry, i) => <li key={i}>{formatDate(entry.createdAt)} · {entry.action} · {entry.actorName || `کاربر #${entry.actorId}`}</li>)}</ul> : <p>سابقه‌ای یافت نشد.</p>}
      </details>
      {item.revisions.length > 0 && <details><summary>ردپای اصلاحات ({item.revisions.length})</summary>
        <ul>{item.revisions.map((rev) => <li key={rev.id}>{formatDate(rev.createdAt)} · {rev.actorName || rev.actorUsername || `کاربر #${rev.actorId}`} (# {rev.actorId}):
          {" "}{rev.previousSalespersonName || "نامشخص"} (#{rev.previousSalespersonId ?? "—"}) ← {rev.salespersonName} (#{rev.salespersonId}) · علت: {rev.reason}</li>)}</ul>
      </details>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <label>کارشناس تاریخی{" "}
          <select className="select-control" value={selected[item.id] ?? ""} onChange={(e) => setSelected((v) => ({ ...v, [item.id]: e.target.value }))}>
            <option value="">انتخاب کنید</option>
            {reviews.data.salespersons.map((person) => <option key={person.id} value={person.id}>{person.name} (#{person.id}{person.active ? "" : "، غیرفعال"})</option>)}
          </select>
        </label>
        <label>دلیل و مستند تصمیم{" "}
          <input value={reasons[item.id] ?? ""} onChange={(e) => setReasons((v) => ({ ...v, [item.id]: e.target.value }))} placeholder="حداقل ۱۰ حرف؛ منبع بررسی را بنویسید" style={{ minWidth: 260 }} />
        </label>
        <button className="btn btn-primary" disabled={save.isPending || !selected[item.id] || (reasons[item.id]?.trim().length ?? 0) < 10 ||
          Number(selected[item.id]) === item.salespersonId}
          onClick={() => save.mutate({ id: item.id, salespersonId: Number(selected[item.id]), reason: reasons[item.id].trim() })}>
          {save.isPending ? "در حال ثبت..." : item.revisions.length ? "ثبت اصلاح با ردپا" : "تأیید مالکیت تاریخی"}
        </button>
      </div>
      {item.revisions.length > 0 && <div style={{ marginTop: 12 }}>
        <p>برآورد آزمایشی فقط پس از تأیید مالکیت: نرخ تاریخی به‌صورت خودکار معلوم نیست؛ نرخ فرضی را خودتان وارد کنید. این مبلغ در کیف پول ثبت نمی‌شود.</p>
        <label>نرخ فرضی (%){" "}
          <input type="number" min="0" max="100" step="0.01" value={rates[item.id] ?? ""} onChange={(e) => { setRates((v) => ({ ...v, [item.id]: e.target.value })); setEstimates((v) => { const next = { ...v }; delete next[item.id]; return next; }); }} />
        </label>{" "}
        <button className="btn btn-ghost" disabled={estimate.isPending || rates[item.id] === "" || !Number.isFinite(Number(rates[item.id])) || Number(rates[item.id]) < 0 || Number(rates[item.id]) > 100 ||
          Math.abs(Number(rates[item.id]) * 100 - Math.round(Number(rates[item.id]) * 100)) > 1e-8}
          onClick={() => estimate.mutate({ id: item.id, ratePercent: Number(rates[item.id]) })}>محاسبه برآورد</button>
        {estimates[item.id] && <p>برآورد غیرقطعی: {Number(estimates[item.id].estimatedAmountToman).toLocaleString("fa-IR")} تومان
          {" "}بر اساس مبلغ {estimates[item.id].baseType === "approved" ? "مصوب" : "درخواستی"} و نرخ فرضی {estimates[item.id].ratePercent}٪.</p>}
      </div>}
      {save.isError && <p role="alert" className="profile-form-error">{save.error.message}</p>}
      {estimate.isError && <p role="alert" className="profile-form-error">{estimate.error.message}</p>}
    </article>)}
    {reviews.data && reviews.data.total > reviews.data.pageSize && <div style={{ display: "flex", gap: 12 }}>
      <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>قبلی</button>
      <button className="btn btn-ghost" disabled={page * reviews.data.pageSize >= reviews.data.total} onClick={() => setPage(page + 1)}>بعدی</button>
    </div>}
  </section>;
}