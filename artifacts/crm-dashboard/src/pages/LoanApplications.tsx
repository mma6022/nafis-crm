import { useState, useMemo, useEffect } from "react";
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  useListLoanApplications,
  useListLoanPlans,
  useDeleteLoanApplication,
  getListLoanApplicationsQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  type LoanApplication,
  type ListLoanApplicationsParams,
} from "@workspace/api-client-react";
import {
  Plus,
  Search,
  Trash2,
  Clock,
  LayoutList,
  Kanban,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { SkeletonPanel, ErrorState, formatDate } from "@/components/CrmShell";
import { Modal, EmptyState } from "@/components/DataTools";
import { CreateWizard } from "@/components/loan-applications/CreateWizard";
import { AttributionReview } from "@/components/loan-applications/AttributionReview";
import { PersianDatePicker } from "@/components/PersianDatePicker";

const STAGE_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  primary_contract_pending_signature: "در انتظار امضای قرارداد توسط مشتری",
  approved_contract_pending_signature: "امضای قرارداد جایگزین توسط مشتری",
  customer_documents_upload: "بارگذاری مدارک مشتری",
  customer_documents_review: "بررسی مدارک مشتری",
  guarantor_registration: "ثبت ضامن",
  guarantor_documents_upload: "بارگذاری مدارک ضامن",
  guarantor_documents_review: "بررسی مدارک ضامن",
  collateral_upload: "بارگذاری وثیقه",
  collateral_review: "بررسی وثیقه",
  physical_documents_correction: "رفع نقص مدارک فیزیکی",
  physical_documents_submission: "ارسال مدارک فیزیکی",
  physical_documents_review: "بررسی مدارک فیزیکی",
  expert_approval: "ثبت تصمیم تأمین‌کننده مالی",
  funder_documents_correction: "اصلاح مدارک مردود تأمین‌کننده",
  funder_result_review: "بررسی نتیجه تامین‌کننده",
  admin_approval: "تأیید نهایی مدیر و شارژ اعتبار",
  wallet_charge_pending: "در انتظار تأیید شارژ توسط کارشناس ثبت",
  final_invoice_pending_signature: "امضای صورت‌حساب نهایی",
  completed: "تکمیل شده",
};

const STATUS_LABELS: Record<string, string> = {
  requested: "درخواست شده",
  reviewing: "در حال بررسی",
  approved: "تأیید شده",
  rejected: "رد شده",
};

const STATUS_STYLES: Record<string, string> = {
  requested: "status-new",
  reviewing: "status-active",
  approved: "status-active",
  rejected: "status-failed",
};

const BUSINESS_STATUS_LABELS: Record<string, string> = {
  waiting_sales: "در انتظار اقدام کارشناس فروش",
  waiting_customer_signature: "در انتظار امضای قرارداد توسط مشتری",
  waiting_registration: "در انتظار اقدام کارشناس ثبت",
  waiting_funder_approval: "در انتظار تایید تامین‌کننده مالی",
  waiting_wallet_charge: "در انتظار تأیید شارژ توسط کارشناس ثبت",
  wallet_charged: "در انتظار تأیید نهایی مدیر",
  canceled: "لغو شده",
  completed: "تکمیل شده",
};

const BOARD_COLUMNS = Object.keys(BUSINESS_STATUS_LABELS);
const ACTION_ROLE_LABELS: Record<string, string> = {
  salesperson: "کارشناس فروش",
  registrar: "کارشناس ثبت",
  admin: "مدیر",
};

export default function LoanApplications() {
  const queryClient = useQueryClient();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);

  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const canCreate =
    user?.role === "admin" ||
    user?.permissions?.includes("loan_applications.create");
  const canDelete =
    user?.role === "admin" ||
    user?.permissions?.includes("loan_applications.delete");

  const [view, setView] = useTableState<'table' | 'board'>('applications.view', 'table');
  const [tab, setTab] = useTableState<"mine" | "progress" | "all">('applications.tab', () => {
    if (initialParams.get("caseScope") === "in-progress") return "progress";
    if (initialParams.get("actionable") === "true") return "mine";
    if (initialParams.has("actionable") || initialParams.has("stage") || initialParams.has("status") || initialParams.has("caseScope")) return "all";
    return "mine";
  });
  const actionableOnly = tab === "mine";
  const caseScope: "in-progress" | undefined = tab === "progress" ? "in-progress" : undefined;
  const [page, setPage] = useTableState('applications.page', 1);
  const [pageSize, setPageSize] = useTableState('applications.pageSize', 20);

  const [search, setSearch] = useTableState('applications.search', "");
  const [statusFilter, setStatusFilter] = useTableState('applications.status', initialParams.get("stage") || initialParams.get("status") || "");
  const [planFilter, setPlanFilter] = useTableState('applications.plan', "");
  const [dateFrom, setDateFrom] = useTableState('applications.dateFrom', "");
  const [dateTo, setDateTo] = useTableState('applications.dateTo', "");

  const [wizardOpen, setWizardOpen] = useState(false);
  // Entry point from the customer page (?new=1&customerId=<id>&from=customer[&draft=1]).
  const [, setLocation] = useLocation();
  const entryCustomerId = useMemo(() => {
    const raw = initialParams.get("customerId");
    return initialParams.get("new") === "1" && raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
  }, [initialParams]);
  const [entryOpen, setEntryOpen] = useState(Boolean(entryCustomerId));
  const closeEntryWizard = () => {
    setEntryOpen(false);
    const url = new URL(window.location.href);
    ["new", "customerId", "from", "draft"].forEach((name) => url.searchParams.delete(name));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (initialParams.get("from") === "customer" && entryCustomerId) setLocation(`/customers/${entryCustomerId}`);
  };
  const [deleteConfirm, setDeleteConfirm] = useState<LoanApplication | null>(null);
  const [reviewOpen, setReviewOpen] = useState(initialParams.get("review") === "historical");

  // Parse status and stage from a combined filter
  const isStageFilter = STAGE_LABELS[statusFilter] !== undefined;
  const statusParam = isStageFilter ? undefined : statusFilter || undefined;
  const stageParam = isStageFilter ? statusFilter : undefined;

  const queryParams: ListLoanApplicationsParams = {
    page,
    limit: pageSize,
    search: search || undefined,
    status: statusParam,
    stage: stageParam,
    planId: planFilter ? Number(planFilter) : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    actionable: actionableOnly || undefined,
    caseScope,
    mode: view === "board" ? "board" : "list",
  };

  const {
    data: appsPage,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useListLoanApplications(queryParams, {
    query: { queryKey: getListLoanApplicationsQueryKey(queryParams), refetchInterval: 15000, placeholderData: (prev) => prev },
  });

  const { data: plansData } = useListLoanPlans({ active: true });
  const plans = plansData || [];

  const deleteMutation = useDeleteLoanApplication({
    mutation: {
      onSuccess: () => {
        setDeleteConfirm(null);
        queryClient.invalidateQueries({
          queryKey: getListLoanApplicationsQueryKey(),
        });
      },
    },
  });

  const apps = appsPage?.items || [];
  const total = (appsPage as { total?: number } | undefined)?.total;
  const pageCount = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (appsPage?.page === page && pageCount !== undefined && page > pageCount) setPage(pageCount); }, [appsPage, pageCount, page]);
  const resetTo = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const fa = (n: number) => n.toLocaleString("fa-IR");

  const boardGroups = useMemo(() => {
    if (view !== 'board') return {};
    const groups: Record<string, LoanApplication[]> = {};
    BOARD_COLUMNS.forEach(col => groups[col] = []);
    apps.forEach(app => {
       const key = app.businessStatus || "other";
       if (!groups[key]) groups[key] = [];
       groups[key].push(app);
    });
    return groups;
  }, [apps, view]);

  return (
    <section className="data-page">
      <div className="page-intro" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="eyebrow">جریان کار</div>
          <h2>درخواست‌های تسهیلات</h2>
          <p>مدیریت جامع پرونده‌های مالی مشتریان از درخواست تا پرداخت.</p>
        </div>
        <div className="la-intro-actions" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
           <div className="la-row" style={{ display: 'flex', gap: 10 }}>
              {user?.role === "admin" && <button className={`btn ${reviewOpen ? "btn-primary" : "btn-ghost"}`} onClick={() => setReviewOpen(!reviewOpen)}>
                {reviewOpen ? "بازگشت به پرونده‌ها" : "بازبینی کارشناس پرونده‌های قدیمی"}
              </button>}
             {canCreate && (
               <button
                 className="btn btn-primary"
                 onClick={() => setWizardOpen(true)}
               >
                 <Plus size={16} /> ثبت درخواست جدید
               </button>
             )}
           </div>
            {!reviewOpen && <div className="la-row" style={{ display: 'flex', gap: 10 }}>
              <div style={{ display: 'flex', background: '#f1f5f9', padding: '4px', borderRadius: '12px', gap: '4px' }}>
                 <button className={`view-toggle-btn ${tab === 'mine' ? 'active' : ''}`} onClick={() => { setTab('mine'); setPage(1); }} data-testid="btn-view-actionable">کارتابل من</button>
                 <button className={`view-toggle-btn ${tab === 'progress' ? 'active' : ''}`} onClick={() => { setTab('progress'); setPage(1); }} data-testid="btn-view-in-progress">در جریان</button>
                 <button className={`view-toggle-btn ${tab === 'all' ? 'active' : ''}`} onClick={() => { setTab('all'); setPage(1); }} data-testid="btn-view-all">همه پرونده‌ها</button>
             </div>
              <div style={{ display: 'flex', background: '#f1f5f9', padding: '4px', borderRadius: '12px', gap: '4px' }}>
                <button className={`view-toggle-btn ${view === 'table' ? 'active' : ''}`} onClick={() => { setView('table'); setPage(1); }} data-testid="btn-view-table"><LayoutList size={15}/> جدول</button>
                <button className={`view-toggle-btn ${view === 'board' ? 'active' : ''}`} onClick={() => { setView('board'); setPage(1); }} data-testid="btn-view-board"><Kanban size={15}/> بورد</button>
              </div>
            </div>}
        </div>
      </div>

      {reviewOpen && user?.role === "admin" ? <AttributionReview /> : <>
      <div
        className="toolbar"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="la-row la-filters" style={{ display: "flex", gap: 10, width: "100%" }}>
          <div className="searchbar" style={{ flex: 1 }}>
            <Search size={16} />
            <input
              type="search"
              placeholder="جستجوی نام مشتری یا شماره پرونده..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="select-control"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          >
            <option value="">همه وضعیت‌ها و مراحل</option>
            <optgroup label="وضعیت">
              <option value="requested">درخواست شده</option>
              <option value="reviewing">در حال بررسی</option>
              <option value="approved">تأیید شده</option>
              <option value="rejected">رد شده</option>
            </optgroup>
            <optgroup label="مرحله">
              {Object.entries(STAGE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </optgroup>
          </select>
          <select
            className="select-control"
            value={planFilter}
            onChange={(e) => { setPlanFilter(e.target.value); setPage(1); }}
          >
            <option value="">همه طرح‌ها</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="la-row la-dates" style={{ display: "flex", gap: 10, width: "100%", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#475569" }}>از تاریخ:</span>
          <PersianDatePicker value={dateFrom} onChange={resetTo(setDateFrom)} />
          <span style={{ fontSize: 12, color: "#475569" }}>تا تاریخ:</span>
          <PersianDatePicker value={dateTo} onChange={resetTo(setDateTo)} />
        </div>
      </div>

      {isLoading ? (
        <SkeletonPanel rows={6} />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : view === 'table' ? (
        <div className="customer-table-wrap">
          <table className="customer-table">
            <thead>
              <tr>
                <th>پرونده / مشتری</th>
                <th>طرح تسهیلاتی</th>
                <th>مبلغ درخواستی (تومان)</th>
                <th>وضعیت / اقدام</th>
                <th>تاریخ‌ها</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {apps.length > 0 ? (
                apps.map((app) => (
                  <tr key={app.id} style={{ opacity: (!app.actionRequired && actionableOnly) ? 0.5 : 1 }}>
                    <td>
                      <Link
                        href={`/loan-applications/${app.id}`}
                        style={{ textDecoration: "none" }}
                      >
                        <strong
                          className="customer-name"
                          style={{
                            color: "var(--nafiss-blue)",
                            display: "block",
                            fontSize: 13,
                          }}
                        >
                          {app.customerName || "مشتری ناشناس"}
                        </strong>
                        {(app as { customerSubmitted?: boolean }).customerSubmitted ? <span data-testid={`tag-customer-submitted-${app.id}`} style={{ display: "inline-block", fontSize: 10, padding: "1px 7px", borderRadius: 9, background: "#f3ecdb", color: "#7a5a1f", fontWeight: 700, marginTop: 3 }}>درخواست مشتری ثبت</span> : null}
                        <span style={{ display: "block", fontSize: 10, color: "#64748b", marginTop: 2 }}>
                          کارشناس فروش فعلی: {(app as LoanApplication & { customerSalespersonName?: string | null }).customerSalespersonName || "بدون تخصیص"}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color: "#64748b",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          پرونده #{app.id}
                        </span>
                        <span style={{ display: "block", fontSize: 10, color: "#64748b", marginTop: 2 }}>
                          کارشناس فروش ثبت‌شده: {app.salespersonNameSnapshot || "ثبت نشده"}
                        </span>
                      </Link>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: "#334155" }}>
                        {app.planName || "بدون طرح"}
                      </span>
                      {app.durationMonths && (
                        <span
                          style={{
                            display: "block",
                            fontSize: 10,
                            color: "#64748b",
                          }}
                        >
                          {app.durationMonths} ماهه
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                        }}
                      >
                        {Number(app.requestedAmount).toLocaleString("fa-IR")}{" "}
                        تومان
                      </span>
                      {app.approvedAmount && (
                        <span
                          style={{
                            display: "block",
                            fontSize: 10,
                            color: "#0f766e",
                          }}
                        >
                            مصوب:{" "}
                          {Number(app.approvedAmount).toLocaleString("fa-IR")}
                            {" "}تومان
                        </span>
                      )}
                    </td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          alignItems: "flex-start",
                        }}
                      >
                        {app.businessStatus ? (
                          <span className={`status-pill ${app.actionRequired ? 'status-active' : 'status-muted'}`}>
                             {BUSINESS_STATUS_LABELS[app.businessStatus] || app.businessStatus}
                          </span>
                        ) : (
                          <span
                            className={`status-pill ${STATUS_STYLES[app.status] || "status-muted"}`}
                          >
                            {STATUS_LABELS[app.status] || app.status}
                          </span>
                        )}
                        {app.actionRequired && (
                           <span style={{ fontSize: 10, color: '#b45309', background: '#fffbeb', padding: '2px 6px', borderRadius: 4, border: '1px solid #fde68a' }}>
                             نیازمند اقدام
                           </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <span style={{ fontSize: 11, color: "#64748b" }}>
                          ثبت: {formatDate(app.createdAt)}
                        </span>
                        {app.updatedAt && app.updatedAt !== app.createdAt && (
                          <span style={{ fontSize: 11, color: "#475569" }}>
                            به‌روزرسانی: {formatDate(app.updatedAt)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Link
                          href={`/loan-applications/${app.id}`}
                          className={app.actionRequired ? "btn btn-primary" : "btn btn-ghost"}
                          style={{ padding: "0 10px", height: 32 }}
                        >
                          {app.actionRequired ? "اقدام" : "مشاهده"}
                        </Link>
                        {canDelete && (
                          <button
                            className="btn btn-ghost"
                            style={{
                              padding: "0 8px",
                              height: 32,
                              color: "#be123c",
                            }}
                            onClick={() => setDeleteConfirm(app)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      title="درخواستی یافت نشد"
                      description="با فیلترهای فعلی هیچ درخواست تسهیلاتی پیدا نشد."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="board-grid" style={{ paddingBottom: 20 }}>
           {Object.entries(boardGroups).map(([columnName, columnApps]) => (
              <div key={columnName} className="board-column">
                 <div className="board-col-header">
                    {BUSINESS_STATUS_LABELS[columnName] || "سایر"}
                   <span className="board-col-count">{(columnApps as LoanApplication[]).length}</span>
                 </div>
                 <div className="board-col-cards" style={{ maxHeight: '70vh' }}>
                   {(columnApps as LoanApplication[]).map(app => (
                      <div key={app.id} className="board-card" style={{ borderLeft: app.actionRequired ? '3px solid #f59e0b' : '3px solid transparent', opacity: (!app.actionRequired && actionableOnly) ? 0.5 : 1 }}>
                         <div className="board-card-name">
                           <Link href={`/loan-applications/${app.id}`} className="board-customer-link">
                              <span className="board-customer-name">{app.customerName}</span>
                           </Link>
                           {app.actionRequired && <span className="customer-tag" style={{ background: '#fef3c7', color: '#b45309' }}>اقدام</span>}
                         </div>
                          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
                            کارشناس فروش فعلی: {(app as LoanApplication & { customerSalespersonName?: string | null }).customerSalespersonName || 'بدون تخصیص'}
                          </div>
                         <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                            پرونده #{app.id} · {app.planName}
                         </div>
                          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
                            کارشناس فروش ثبت‌شده: {app.salespersonNameSnapshot || 'ثبت نشده'}
                          </div>
                         <div style={{ fontSize: 13, fontWeight: 'bold', color: 'var(--ink-deep)', marginTop: 8 }} dir="ltr">
                             {Number(app.requestedAmount).toLocaleString('fa-IR')} <span style={{fontSize: 10, color: '#94a3b8'}}>تومان</span>
                         </div>
                         <div className="board-card-meta" style={{ marginTop: 12 }}>
                            <span>{app.actionRole ? `مسئول اقدام: ${ACTION_ROLE_LABELS[app.actionRole] || app.actionRole}` : ''}</span>
                            <span className="board-col-count">{formatDate(app.updatedAt || app.createdAt)}</span>
                         </div>
                      </div>
                   ))}
                   {(columnApps as LoanApplication[]).length === 0 && (
                      <div className="board-empty">پرونده‌ای در این مرحله نیست.</div>
                   )}
                 </div>
              </div>
           ))}
        </div>
      )}

      {!isLoading && !isError ? (
        <div className="loan-pager" data-testid="loan-pager" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", margin: "12px 0" }}>
          <label style={{ fontSize: 12, color: "#475569", display: "flex", gap: 6, alignItems: "center" }}>
            تعداد در صفحه
            <select className="select-control" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} data-testid="select-page-size">
              {[20, 50, 100].map((n) => <option key={n} value={n}>{fa(n)}</option>)}
            </select>
          </label>
          <span style={{ fontSize: 12, color: "#475569" }} data-testid="text-page-info">
            صفحه {fa(page)}{pageCount !== undefined ? ` از ${fa(pageCount)}` : ""}{total !== undefined ? ` · ${fa(total)} پرونده` : ""}{isFetching ? " · در حال به‌روزرسانی…" : ""}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-ghost" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))} data-testid="button-page-prev">قبلی</button>
            <button className="btn btn-ghost" disabled={isFetching || (pageCount !== undefined ? page >= pageCount : apps.length < pageSize)} onClick={() => setPage((p) => p + 1)} data-testid="button-page-next">بعدی</button>
          </div>
        </div>
      ) : null}

      {wizardOpen && <CreateWizard onClose={() => setWizardOpen(false)} />}
      {!wizardOpen && entryOpen && entryCustomerId && session && canCreate ? <CreateWizard initialCustomerId={entryCustomerId} resumeDraft={initialParams.get("draft") === "1"} onClose={closeEntryWizard} /> : null}

      {deleteConfirm && (
        <Modal
          title="حذف درخواست تسهیلات"
          onClose={() => setDeleteConfirm(null)}
          testId="delete-confirm-modal"
        >
          <div
            style={{
              padding: "10px 0 20px",
              color: "#475569",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            آیا از حذف پرونده شماره {deleteConfirm.id} متعلق به{" "}
            {deleteConfirm.customerName} اطمینان دارید؟ پرونده پنهان شده اما
            سوابق حقوقی و مالی آن به صورت امن در سیستم حفظ می‌شود.
          </div>
          <div className="form-footer" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn btn-ghost"
              onClick={() => setDeleteConfirm(null)}
              disabled={deleteMutation.isPending}
            >
              انصراف
            </button>
            <button
              className="btn"
              style={{ background: "#be123c", color: "#fff" }}
              onClick={() => deleteMutation.mutate({ id: deleteConfirm.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "در حال حذف..." : "حذف پرونده"}
            </button>
          </div>
        </Modal>
      )}
      </>}
    </section>
  );
}
