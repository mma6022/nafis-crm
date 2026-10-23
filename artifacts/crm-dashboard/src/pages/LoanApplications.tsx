import { useState, useMemo, useEffect } from "react";
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  useListLoanApplications,
  useListLoanPlans,
  useDeleteLoanApplication,
  getListLoanApplicationsQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  useGetLoanApplicationDashboardStats,
  getGetLoanApplicationDashboardStatsQueryKey,
  type LoanApplication,
  type ListLoanApplicationsParams,
} from "@workspace/api-client-react";
import { AlertCircle, ChevronLeft, ChevronRight, Clock, Eye, FileClock, Inbox, Info, Kanban, LayoutList, Lock, Plus, RotateCcw, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { CreateWizard } from "@/components/loan-applications/CreateWizard";
import { AttributionReview } from "@/components/loan-applications/AttributionReview";
import { PersianDatePicker } from "@/components/PersianDatePicker";
import { ConfirmDialog, Sheet, jalaliDate, relativeTime, useMinWidth } from "./customers-ui";
import { BUSINESS_STATUS_LABELS, ACTION_ROLE_NAMES, WIZARD_DISPLAY_STEPS, WIZARD_TOTAL_STEPS, loanBusinessStatus, loanStageLabel } from "@/lib/loan-labels";
import { clearLoanDraft, listLoanDrafts, loanWizardHref, type LoanDraft } from "@/lib/loan-draft";
import "./customers.css";
import "./loan-requests.css";

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

const BOARD_COLUMNS = Object.keys(BUSINESS_STATUS_LABELS);
const fa = (n: number) => n.toLocaleString("fa-IR");
const toman = (value?: string | null) => { try { return BigInt(value || "0").toLocaleString("fa-IR"); } catch { return value || "—"; } };
type LoanRow = LoanApplication & { customerSalespersonName?: string | null; customerSubmitted?: boolean };

function turnLabel(app: LoanRow, bs: string) {
  if (bs === "completed" || bs === "canceled") return "—";
  if (app.actionRequired) return "شما";
  if (bs === "waiting_customer_signature") return "مشتری";
  return app.actionRole ? ACTION_ROLE_NAMES[app.actionRole] ?? app.actionRole : "—";
}

function StatusCell({ app }: { app: LoanRow }) {
  const bs = loanBusinessStatus(app);
  const stage = bs !== "canceled" && bs !== "completed" ? loanStageLabel(app.stage) : "";
  return <div className="lrx-st">
    {bs && BUSINESS_STATUS_LABELS[bs] ? <span className="csx-st" data-bs={bs}>{BUSINESS_STATUS_LABELS[bs]}</span> : <span className="csx-st" data-bs="waiting_registration">{STATUS_LABELS[app.status] || app.status}</span>}
    {stage ? <small>مرحله: {stage}</small> : null}
  </div>;
}

export default function LoanApplications() {
  const queryClient = useQueryClient();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const isDesktop = useMinWidth(1024);

  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const canView = user?.role === "admin" || Boolean(user?.permissions?.includes("loan_applications.view"));
  const canCreate =
    user?.role === "admin" ||
    user?.permissions?.includes("loan_applications.create");
  const canDelete =
    user?.role === "admin" ||
    user?.permissions?.includes("loan_applications.delete");
  const isFunder = user?.role === "funder";
  const isSalesperson = user?.role === "salesperson";

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
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  // Local wizard drafts (this device only) for the banner above the list.
  const [drafts, setDrafts] = useState<LoanDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftToDelete, setDraftToDelete] = useState<LoanDraft | null>(null);
  useEffect(() => {
    const refresh = () => setDrafts(canCreate ? listLoanDrafts(user?.id) : []);
    refresh();
    window.addEventListener("nafis-loan-draft", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("nafis-loan-draft", refresh); window.removeEventListener("storage", refresh); };
  }, [user?.id, canCreate, entryOpen, wizardOpen]);

  // Parse status and stage from a combined filter
  const isStageFilter = STAGE_LABELS[statusFilter] !== undefined;
  const statusParam = isStageFilter ? undefined : statusFilter || undefined;
  const stageParam = isStageFilter ? statusFilter : undefined;
  const boardView = view === "board" && isDesktop;

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
    mode: boardView ? "board" : "list",
  };

  const {
    data: appsPage,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useListLoanApplications(queryParams, {
    query: { queryKey: getListLoanApplicationsQueryKey(queryParams), refetchInterval: 15000, placeholderData: (prev) => prev, enabled: canView },
  });
  const { data: stats } = useGetLoanApplicationDashboardStats({
    query: { queryKey: getGetLoanApplicationDashboardStatsQueryKey(), enabled: canView, staleTime: 30_000 },
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

  const apps = (appsPage?.items || []) as LoanRow[];
  const total = (appsPage as { total?: number } | undefined)?.total;
  const pageCount = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (appsPage?.page === page && pageCount !== undefined && page > pageCount) setPage(pageCount); }, [appsPage, pageCount, page]);
  const resetTo = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const filterCount = [statusFilter, planFilter, dateFrom || dateTo].filter(Boolean).length;
  const hasQuery = Boolean(search || filterCount);
  const clearFilters = () => { setStatusFilter(""); setPlanFilter(""); setDateFrom(""); setDateTo(""); setPage(1); };

  const boardGroups = useMemo(() => {
    if (!boardView) return {};
    const groups: Record<string, LoanRow[]> = {};
    BOARD_COLUMNS.forEach(col => groups[col] = []);
    apps.forEach(app => {
       const key = loanBusinessStatus(app) || "other";
       if (!groups[key]) groups[key] = [];
       groups[key].push(app);
    });
    return groups;
  }, [apps, boardView]);

  if (session && !canView) {
    return <section className="csx lrx" dir="rtl">
      <div className="csx-empty lock" data-testid="loan-applications-denied">
        <div className="big"><Lock size={34} aria-hidden="true" /></div>
        <h2>به درخواست‌های تسهیلات دسترسی ندارید</h2>
        <p>این بخش برای نقش شما فعال نیست. اگر فکر می‌کنید باید دسترسی داشته باشید، با مدیر سامانه هماهنگ کنید.</p>
        <div className="acts"><Link href="/" className="csx-primary">بازگشت به داشبورد</Link></div>
      </div>
    </section>;
  }

  const tabs: Array<{ key: "mine" | "progress" | "all"; label: string; count?: number; testId: string }> = [
    { key: "mine", label: "کارتابل من", count: stats?.awaitingAction, testId: "btn-view-actionable" },
    { key: "progress", label: "در جریان", count: stats?.inProgress, testId: "btn-view-in-progress" },
    { key: "all", label: "همه پرونده‌ها", count: tab === "all" && !hasQuery ? total : undefined, testId: "btn-view-all" },
  ];

  const openDraft = (draft: LoanDraft) => setLocation(loanWizardHref(draft.customerId, true, "list"));
  const draftStep = (draft: LoanDraft) => `مرحله ${fa(draft.step)} از ${fa(WIZARD_TOTAL_STEPS)}`;
  const draftBanner = !reviewOpen && drafts.length ? <div className="lrx-draft" role="region" aria-label="پیش‌نویس ناتمام" data-testid="loan-draft-banner">
    <FileClock size={22} aria-hidden="true" />
    {drafts.length === 1
      ? <p><b>پیش‌نویس ناتمام:</b> {drafts[0].customerName} · {draftStep(drafts[0])} ({WIZARD_DISPLAY_STEPS[drafts[0].step - 1]?.label}) · ذخیره‌شده {relativeTime(drafts[0].updatedAt)}</p>
      : <p><b>{fa(drafts.length)} پیش‌نویس ناتمام</b> روی همین دستگاه · آخرین: {drafts[0].customerName}، {relativeTime(drafts[0].updatedAt)}</p>}
    <div className="acts">
      {drafts.length === 1
        ? <><button type="button" className="csx-ghost sm" onClick={() => openDraft(drafts[0])} data-testid="button-resume-loan-draft">ادامه پیش‌نویس</button>
          <button type="button" className="csx-link" onClick={() => setDraftToDelete(drafts[0])} data-testid="button-delete-loan-draft">حذف پیش‌نویس</button></>
        : <button type="button" className="csx-ghost sm" onClick={() => setDraftsOpen(true)} data-testid="button-choose-loan-draft">انتخاب پیش‌نویس</button>}
    </div>
  </div> : null;

  const roleNote = !reviewOpen && isFunder ? <div className="csx-note" role="note" data-testid="loan-role-note-funder"><Eye size={18} aria-hidden="true" /><p><b>فقط مشاهده.</b> نمای تأمین‌کننده مالی: پرونده‌ها را می‌بینید؛ ثبت تصمیم شما در سامانه توسط ثبت‌نام‌کننده انجام می‌شود.</p></div>
    : !reviewOpen && isSalesperson ? <div className="csx-note" role="note" data-testid="loan-role-note-salesperson"><Info size={18} aria-hidden="true" /><p>فقط پرونده‌های مشتریانی که به شما تخصیص داده شده‌اند نمایش داده می‌شوند.</p></div> : null;

  const actionLink = (app: LoanRow, compact = false) => <Link
    href={`/loan-applications/${app.id}`}
    className={app.actionRequired && !compact ? "csx-primary" : "csx-ghost sm"}
    data-testid={`link-loan-action-${app.id}`}
  >{app.actionRequired ? "اقدام" : compact ? "مشاهده" : "مشاهده پرونده"}</Link>;

  const deleteButton = (app: LoanRow) => canDelete ? <button type="button" className="csx-ib" aria-label={`حذف پرونده ${fa(app.id)}`} onClick={() => setDeleteConfirm(app)} data-testid={`button-delete-loan-${app.id}`}><Trash2 size={18} /></button> : null;

  const body = isLoading ? <div aria-busy="true" aria-label="در حال دریافت پرونده‌ها" data-testid="loan-list-loading">
      <div className="csx-list csx-skcards">{[0, 1, 2].map((i) => <div key={i} className="csx-skcard"><span className="csx-sk" style={{ height: 22, width: "45%" }} /><span className="csx-sk" style={{ height: 18, width: "70%" }} /><span className="csx-sk" style={{ height: 18, width: "55%" }} /><span className="csx-sk" style={{ height: 48 }} /></div>)}</div>
      <div className="csx-sktable">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="row">{[0, 1, 2, 3, 4, 5].map((j) => <span key={j} className="csx-sk" style={{ height: 18 }} />)}</div>)}</div>
    </div>
    : isError ? <div className="csx-empty err" role="alert" data-testid="loan-list-error">
      <div className="big"><AlertCircle size={32} aria-hidden="true" /></div>
      <h2>پرونده‌ها دریافت نشد</h2>
      <p>ارتباط با سرور برقرار نشد. اتصال را بررسی کنید و دوباره تلاش کنید.</p>
      <div className="acts"><button type="button" className="csx-primary" onClick={() => refetch()} data-testid="button-retry-loans"><RotateCcw size={18} /> تلاش دوباره</button></div>
    </div>
    : !apps.length ? <div className="csx-empty" data-testid="loan-list-empty">
      <div className="big">{hasQuery ? <Search size={30} aria-hidden="true" /> : <Inbox size={30} aria-hidden="true" />}</div>
      {hasQuery ? <><h2>درخواستی یافت نشد</h2><p>با جستجو و فیلترهای فعلی هیچ درخواست تسهیلاتی پیدا نشد.</p><div className="acts"><button type="button" className="csx-ghost" onClick={() => { setSearch(""); clearFilters(); }}>پاک کردن جستجو و فیلترها</button></div></>
        : tab === "mine" ? <><h2>کارتابل شما خالی است</h2><p>الان پرونده‌ای منتظر اقدام شما نیست. پرونده‌های دیگر در «در جریان» و «همه پرونده‌ها» هستند.</p><div className="acts"><button type="button" className="csx-ghost" onClick={() => { setTab("progress"); setPage(1); }}>مشاهده پرونده‌های در جریان</button></div></>
        : <><h2>درخواستی یافت نشد</h2><p>هنوز پرونده‌ای در این بخش نیست.</p></>}
    </div>
    : boardView ? <div className="lrx-board" role="region" aria-label="بُرد پرونده‌ها" tabIndex={0} data-testid="loan-board">
      {Object.entries(boardGroups).map(([columnName, columnApps]) => (
        <div key={columnName} className="lrx-col">
          <div className="lrx-colh"><span className="csx-st" data-bs={columnName}>{BUSINESS_STATUS_LABELS[columnName] || "سایر"}</span><span className="n" aria-label={`${fa(columnApps.length)} پرونده در این صفحه`}>{fa(columnApps.length)}</span></div>
          <div className="lrx-colb">
            {columnApps.map(app => (
              <Link key={app.id} href={`/loan-applications/${app.id}`} className={`lrx-bcard${app.actionRequired ? " hl" : ""}`} data-testid={`board-card-${app.id}`}>
                <b>{app.customerName || "مشتری ناشناس"}</b>
                <span className="muted">#{fa(app.id)} · {app.planName || "بدون طرح"}</span>
                <span className="amt">{toman(app.requestedAmount)} <small>تومان</small></span>
                {app.stage && columnName !== "completed" && columnName !== "canceled" ? <span className="muted">مرحله: {loanStageLabel(app.stage)}</span> : null}
                {app.actionRequired ? <span className="csx-tag warn">نیازمند اقدام شما</span> : null}
              </Link>
            ))}
            {columnApps.length === 0 && <div className="lrx-colempty">پرونده‌ای در این مرحله نیست.</div>}
          </div>
        </div>
      ))}
    </div>
    : <>
      <div className="csx-list cards" data-testid="loan-cards">
        {apps.map((app) => {
          const bs = loanBusinessStatus(app);
          const duration = app.durationMonths ?? app.requestedDurationMonths;
          const stage = bs !== "canceled" && bs !== "completed" ? loanStageLabel(app.stage) : "";
          return <article key={app.id} className={`csx-card lrx-card${app.actionRequired ? " hl" : ""}`} data-testid={`loan-card-${app.id}`}>
            <div className="r1">{bs && BUSINESS_STATUS_LABELS[bs] ? <span className="csx-st" data-bs={bs}>{BUSINESS_STATUS_LABELS[bs]}</span> : <span className="csx-st" data-bs="waiting_registration">{STATUS_LABELS[app.status] || app.status}</span>}<span className="age"><Clock size={15} aria-hidden="true" /> {relativeTime(app.createdAt)}</span></div>
            {app.actionRequired ? <span className="csx-tag bad lrx-need"><AlertCircle size={15} aria-hidden="true" /> نیازمند اقدام شما</span> : null}
            <h3 className="nm"><Link href={`/loan-applications/${app.id}`}>{app.customerName || "مشتری ناشناس"}</Link></h3>
            <div className="muted">پرونده <b className="lrx-id">#{fa(app.id)}</b> · {app.planName || "بدون طرح"}{app.customerSubmitted ? <> <span className="csx-tag info" data-testid={`tag-customer-submitted-${app.id}`}>درخواست مشتری ثبت</span></> : null}</div>
            <div className="lrx-money"><b>{toman(app.requestedAmount)}</b> <span className="muted">تومان{duration ? ` · ${fa(Number(duration))} ماهه` : ""}</span></div>
            {stage ? <div className="lrx-stage">مرحله: <b>{stage}</b></div> : null}
            {!app.actionRequired && turnLabel(app, bs) !== "—" ? <div className="muted">نوبت اقدام: {turnLabel(app, bs)}</div> : null}
            <div className="muted">{app.customerSalespersonName || "بدون کارشناس فروش"} · ثبت {jalaliDate(app.createdAt)}</div>
            <div className="lrx-cact">{actionLink(app)}{deleteButton(app)}</div>
          </article>;
        })}
      </div>
      <div className="csx-tablewrap">
        <table className="csx-table lrx-table" data-testid="loan-table">
          <thead><tr><th scope="col">مشتری / پرونده · طرح</th><th scope="col">مبلغ (تومان)</th><th scope="col">وضعیت و مرحله</th><th scope="col">نوبت اقدام</th><th scope="col">کارشناس فروش / ثبت</th><th scope="col"><span className="csx-sr">عملیات</span></th></tr></thead>
          <tbody>
            {apps.map((app) => {
              const bs = loanBusinessStatus(app);
              const duration = app.durationMonths ?? app.requestedDurationMonths;
              return <tr key={app.id} className={app.actionRequired ? "hl" : undefined} data-testid={`loan-row-${app.id}`}>
                <td><p className="nm"><Link href={`/loan-applications/${app.id}`}>{app.customerName || "مشتری ناشناس"}</Link></p><span className="muted">#{fa(app.id)} · {app.planName || "بدون طرح"}</span>{app.customerSubmitted ? <div><span className="csx-tag info" data-testid={`tag-customer-submitted-${app.id}`}>درخواست مشتری ثبت</span></div> : null}</td>
                <td><b className="lrx-amt">{toman(app.requestedAmount)}</b>{duration ? <div className="muted">{fa(Number(duration))} ماهه</div> : null}{app.approvedAmount ? <div className="lrx-ok">مصوب: {toman(app.approvedAmount)}</div> : null}</td>
                <td><StatusCell app={app} /></td>
                <td>{app.actionRequired ? <span className="csx-tag bad" title="نیازمند اقدام شما"><AlertCircle size={15} aria-hidden="true" /> شما</span> : <span>{turnLabel(app, bs)}</span>}</td>
                <td><div>{app.customerSalespersonName || "بدون تخصیص"}</div><div className="muted">ثبت {jalaliDate(app.createdAt)}{app.salespersonNameSnapshot && app.salespersonNameSnapshot !== app.customerSalespersonName ? ` · ثبت‌کننده: ${app.salespersonNameSnapshot}` : ""}</div></td>
                <td><div className="csx-tact">{actionLink(app, true)}{deleteButton(app)}</div></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </>;

  const pager = !isLoading && !isError && apps.length ? <nav className="csx-pager loan-pager" aria-label="صفحه‌بندی" data-testid="loan-pager">
    <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
      تعداد در صفحه
      <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} data-testid="select-page-size">
        {[20, 50, 100].map((n) => <option key={n} value={n}>{fa(n)}</option>)}
      </select>
    </label>
    <span className="muted" data-testid="text-page-info" aria-live="polite">
      صفحه {fa(page)}{pageCount !== undefined ? ` از ${fa(pageCount)}` : ""}{total !== undefined ? ` · ${fa(total)} پرونده` : ""}{isFetching ? " · در حال به‌روزرسانی…" : ""}
    </span>
    <div className="pages">
      <button type="button" className="csx-pg" aria-label="صفحه قبلی" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))} data-testid="button-page-prev"><ChevronRight size={18} /></button>
      <span className="csx-pg active" aria-current="page">{fa(page)}</span>
      <button type="button" className="csx-pg" aria-label="صفحه بعدی" disabled={isFetching || (pageCount !== undefined ? page >= pageCount : apps.length < pageSize)} onClick={() => setPage((p) => p + 1)} data-testid="button-page-next"><ChevronLeft size={18} /></button>
    </div>
  </nav> : null;

  const statusChoices = Object.entries(STATUS_LABELS);
  const filterBody = <>
    <div className="csx-fgrp" role="radiogroup" aria-label="وضعیت">
      <span className="lbl">وضعیت</span>
      <div className="csx-chips">
        <button type="button" role="radio" className="csx-chip" aria-checked={!statusFilter || isStageFilter} onClick={() => { setStatusFilter(""); setPage(1); }}>همه</button>
        {statusChoices.map(([k, v]) => <button key={k} type="button" role="radio" className="csx-chip" aria-checked={statusFilter === k} onClick={() => { setStatusFilter(k); setPage(1); }} data-testid={`chip-status-${k}`}>{v}</button>)}
      </div>
    </div>
    <div className="csx-fgrp">
      <label className="lbl" htmlFor="loan-filter-stage">مرحله</label>
      <select id="loan-filter-stage" className="csx-inp" value={isStageFilter ? statusFilter : ""} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} data-testid="select-filter-stage">
        <option value="">همه مراحل</option>
        {Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <p className="hint">وضعیت و مرحله یک فیلتر مشترک‌اند؛ انتخاب یکی، دیگری را برمی‌دارد.</p>
    </div>
    <div className="csx-fgrp">
      <label className="lbl" htmlFor="loan-filter-plan">طرح تسهیلات</label>
      <select id="loan-filter-plan" className="csx-inp" value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); setPage(1); }} data-testid="select-filter-plan">
        <option value="">همه طرح‌ها</option>
        {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
    <div className="csx-fgrp">
      <span className="lbl">تاریخ ثبت</span>
      <div className="csx-two">
        <label className="csx-fld"><span className="muted">از تاریخ</span><PersianDatePicker value={dateFrom} onChange={resetTo(setDateFrom)} /></label>
        <label className="csx-fld"><span className="muted">تا تاریخ</span><PersianDatePicker value={dateTo} onChange={resetTo(setDateTo)} /></label>
      </div>
    </div>
  </>;

  const searchBox = <label className="csx-search">
    <Search size={20} aria-hidden="true" />
    <span className="csx-sr">جستجو</span>
    <input type="search" placeholder="نام مشتری یا شماره پرونده" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} data-testid="input-loan-search" />
    {search ? <button type="button" className="csx-ib" style={{ width: 36, height: 36 }} aria-label="پاک کردن جستجو" onClick={() => { setSearch(""); setPage(1); }}><X size={18} /></button> : null}
  </label>;
  const adminToggle = user?.role === "admin" ? <button type="button" className="csx-link" aria-pressed={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)} data-testid="button-toggle-attribution-review">
    {reviewOpen ? "بازگشت به پرونده‌ها" : "بازبینی کارشناس پرونده‌های قدیمی"}
  </button> : null;

  return (
    <section className="csx lrx" dir="rtl" data-testid="loan-applications-page">
      <header className="lrx-head">
        <h1>درخواست‌های تسهیلات</h1>
        {isDesktop && !reviewOpen ? searchBox : null}
        {canCreate && isDesktop ? <button type="button" className="csx-primary" onClick={() => setWizardOpen(true)} data-testid="button-new-loan-application"><Plus size={20} /> ثبت درخواست جدید</button> : null}
      </header>

      {reviewOpen && user?.role === "admin" ? <>{adminToggle}<AttributionReview /></> : <>
      <div className="csx-tabs lrx-tabs" role="tablist" aria-label="کارتابل">
        {tabs.map((t) => <button key={t.key} type="button" role="tab" className="csx-tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setPage(1); }} data-testid={t.testId}>
          {t.label}{t.count !== undefined ? <span className="n" data-k={t.key}>{fa(t.count)}</span> : null}
        </button>)}
      </div>
      {roleNote}
      {draftBanner}
      <div className="csx-tools lrx-tools">
        {!isDesktop ? searchBox : null}
        <button type="button" className="csx-fbtn" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog" data-testid="button-loan-filters"><SlidersHorizontal size={20} /> فیلتر{filterCount ? <span className="n">{fa(filterCount)}</span> : null}</button>
        <div className="csx-viewseg" role="group" aria-label="نوع نمایش">
          <button type="button" className={view !== "board" ? "active" : ""} aria-current={view !== "board" ? "true" : undefined} onClick={() => { setView("table"); setPage(1); }} data-testid="btn-view-table"><LayoutList size={18} /> فهرست</button>
          <button type="button" className={view === "board" ? "active" : ""} aria-current={view === "board" ? "true" : undefined} onClick={() => { setView("board"); setPage(1); }} data-testid="btn-view-board"><Kanban size={18} /> بُرد</button>
        </div>
        <span className="grow" />
        {adminToggle}
        <span className="muted d-only">به‌روزرسانی خودکار هر ۱۵ ثانیه</span>
      </div>
      {filterCount ? <div className="csx-activef" aria-label="فیلترهای فعال">
        {statusFilter ? <button type="button" className="csx-chip rm" onClick={() => { setStatusFilter(""); setPage(1); }}>{STATUS_LABELS[statusFilter] || STAGE_LABELS[statusFilter] || statusFilter} <X size={14} aria-label="حذف فیلتر" /></button> : null}
        {planFilter ? <button type="button" className="csx-chip rm" onClick={() => { setPlanFilter(""); setPage(1); }}>{plans.find((p) => String(p.id) === planFilter)?.name || "طرح"} <X size={14} aria-label="حذف فیلتر" /></button> : null}
        {dateFrom || dateTo ? <button type="button" className="csx-chip rm" onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}>بازه تاریخ <X size={14} aria-label="حذف فیلتر" /></button> : null}
        <button type="button" className="csx-link" onClick={clearFilters}>پاک کردن همه</button>
      </div> : null}

      {body}
      {pager}

      {canCreate ? <button type="button" className="csx-primary csx-fab" onClick={() => setWizardOpen(true)} data-testid="fab-new-loan-application"><Plus size={22} /> درخواست جدید</button> : null}

      {filtersOpen ? <Sheet title="فیلتر پرونده‌ها" side={isDesktop} onClose={() => setFiltersOpen(false)} testId="loan-filters-sheet"
        footer={<><button type="button" className="csx-ghost" onClick={clearFilters}>پاک کردن</button><button type="button" className="csx-primary" onClick={() => setFiltersOpen(false)} data-testid="button-apply-loan-filters">{isFetching && !appsPage ? "در حال شمارش…" : total !== undefined ? `نمایش ${fa(total)} پرونده` : "نمایش پرونده‌ها"}</button></>}>
        {filterBody}
      </Sheet> : null}

      {draftsOpen ? <Sheet title={`${fa(drafts.length)} پیش‌نویس ناتمام`} onClose={() => setDraftsOpen(false)} testId="loan-drafts-sheet">
        <p className="hint">پیش‌نویس‌ها فقط روی همین دستگاه ذخیره شده‌اند و پس از ۷ روز پاک می‌شوند.</p>
        <div className="lrx-drafts">{drafts.map((d) => <div key={d.customerId} className="lrx-draftrow">
          <div><b>{d.customerName}</b><div className="muted">{draftStep(d)} · {WIZARD_DISPLAY_STEPS[d.step - 1]?.label}{d.planName ? ` · ${d.planName}` : ""} · {relativeTime(d.updatedAt)}</div></div>
          <div className="acts"><button type="button" className="csx-ghost sm" onClick={() => openDraft(d)}>ادامه</button><button type="button" className="csx-ib" aria-label={`حذف پیش‌نویس ${d.customerName}`} onClick={() => setDraftToDelete(d)}><Trash2 size={18} /></button></div>
        </div>)}</div>
      </Sheet> : null}
      </>}

      {wizardOpen && <CreateWizard onClose={() => setWizardOpen(false)} />}
      {!wizardOpen && entryOpen && entryCustomerId && session && canCreate ? <CreateWizard initialCustomerId={entryCustomerId} resumeDraft={initialParams.get("draft") === "1"} fromCustomer={initialParams.get("from") === "customer"} onClose={closeEntryWizard} /> : null}

      {draftToDelete ? <ConfirmDialog title="حذف پیش‌نویس؟" confirmLabel="حذف پیش‌نویس" testId="delete-loan-draft-dialog"
        onClose={() => setDraftToDelete(null)}
        onConfirm={() => { clearLoanDraft(user?.id, draftToDelete.customerId); setDraftToDelete(null); }}>
        <p>پیش‌نویس درخواست {draftToDelete.customerName} از این دستگاه پاک می‌شود. هزینه پرداخت‌شده، مدارک و استعلام‌های ثبت‌شده روی سرور باقی می‌مانند.</p>
      </ConfirmDialog> : null}

      {deleteConfirm && (
        <ConfirmDialog title="حذف درخواست تسهیلات" confirmLabel="حذف پرونده" pendingLabel="در حال حذف..." pending={deleteMutation.isPending}
          error={deleteMutation.isError ? "حذف پرونده انجام نشد. دوباره تلاش کنید." : undefined}
          onClose={() => setDeleteConfirm(null)} onConfirm={() => deleteMutation.mutate({ id: deleteConfirm.id })} testId="delete-confirm-modal">
          <p>آیا از حذف پرونده شماره {deleteConfirm.id} متعلق به {deleteConfirm.customerName} اطمینان دارید؟ پرونده پنهان شده اما سوابق حقوقی و مالی آن به صورت امن در سیستم حفظ می‌شود.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
