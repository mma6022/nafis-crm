/** customers-priority-kanban v1 — compact priority columns for «مشتریان من». Only rendered while flag.customers_priority_kanban_v1 is ON. */
import { MoreHorizontal, PhoneCall } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { Link } from "wouter";
import { keepPreviousData, useInfiniteQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { listCustomers, type Customer, type ListCustomersParams } from "@workspace/api-client-react";
import { CallNumber } from "@/features/call-number/CallNumber";
import { RowActionsMenu, type RowMenuItem } from "@/components/row-menu/RowActionsMenu";
import { Sheet, StatusPill, relativeTime } from "@/pages/customers-ui";
import {
  CPK_COLUMNS, CPK_PAGE, CPK_UNDO_MS,
  cpkColumnLabel, cpkColumnsForFilter, cpkMoreLabel, cpkUndoMessage, faNum, formatFollowUp,
} from "./helpers";
import "./kanban.css";

export type CpkCustomer = Customer & { nextReminderAt?: string | null };

type InfPages = { pages: Array<{ items: CpkCustomer[]; total: number } & Record<string, unknown>>; pageParams: unknown[] };

function colKeyOf(p: number | null) { return p == null ? "none" : String(p); }

function moveCardInCache(qc: QueryClient, customer: CpkCustomer, from: number | null, to: number | null) {
  const fromK = colKeyOf(from);
  const toK = colKeyOf(to);
  qc.setQueriesData({ queryKey: ["cpk-customers", fromK] }, (old: InfPages | undefined) => {
    if (!old?.pages) return old;
    return {
      ...old,
      pages: old.pages.map((page, i) => ({
        ...page,
        items: page.items.filter((c) => c.id !== customer.id),
        total: i === 0 ? Math.max(0, (page.total ?? 0) - 1) : page.total,
      })),
    };
  });
  qc.setQueriesData({ queryKey: ["cpk-customers", toK] }, (old: InfPages | undefined) => {
    if (!old?.pages?.length) return old;
    if (old.pages.some((page) => page.items.some((c) => c.id === customer.id))) return old;
    return {
      ...old,
      pages: old.pages.map((page, i) => i === 0
        ? { ...page, items: [{ ...customer, priority: to }, ...page.items], total: (page.total ?? 0) + 1 }
        : page),
    };
  });
}


type Filters = Omit<ListCustomersParams, "priority" | "hasPriority" | "limit" | "offset">;

export function CustomersKanban({
  filters, priorityFilter, isDesktop, canDrag, canCall,
  onCall, menuItems, onChangePriority, onClearFilters, hasQuery,
}: {
  filters: Filters;
  priorityFilter: string;
  isDesktop: boolean;
  canDrag: boolean;
  canCall: boolean;
  onCall: (customer: CpkCustomer) => void;
  menuItems: (customer: CpkCustomer) => RowMenuItem[];
  onChangePriority: (customer: CpkCustomer, next: number | null) => Promise<"saved" | "deferred" | "error">;
  onClearFilters: () => void;
  hasQuery: boolean;
}) {
  const columns = cpkColumnsForFilter(priorityFilter);
  const qc = useQueryClient();
  const [tab, setTab] = useState(columns[0]?.key ?? "1");
  const [undo, setUndo] = useState<{ customer: CpkCustomer; from: number | null; to: number | null } | null>(null);
  const [error, setError] = useState("");
  const [priFor, setPriFor] = useState<CpkCustomer | null>(null);
  const totalsRef = useRef<Record<string, number>>({});
  const [totalsTick, setTotalsTick] = useState(0);
  const reportTotal = (key: string, total: number) => {
    if (totalsRef.current[key] === total) return;
    totalsRef.current[key] = total;
    setTotalsTick((n) => n + 1);
  };

  useEffect(() => {
    if (!columns.some((c) => c.key === tab)) setTab(columns[0]?.key ?? "1");
  }, [priorityFilter, columns, tab]);

  const allEmpty = useMemo(() => {
    void totalsTick;
    if (columns.some((c) => totalsRef.current[c.key] == null)) return false;
    return columns.every((c) => (totalsRef.current[c.key] ?? 0) === 0);
  }, [columns, totalsTick]);

  const applyPriority = async (customer: CpkCustomer, next: number | null) => {
    const from = customer.priority ?? null;
    if (from === next) return;
    setError("");
    moveCardInCache(qc, customer, from, next);
    const result = await onChangePriority(customer, next);
    if (result === "saved") setUndo({ customer: { ...customer, priority: next }, from, to: next });
    else {
      moveCardInCache(qc, { ...customer, priority: next }, next, from);
      if (result === "error") setError("تغییر اولویت ذخیره نشد. کارت به جای قبل برگشت.");
    }
  };

  const undoNow = async () => {
    if (!undo) return;
    const { customer, from } = undo;
    const to = customer.priority ?? null;
    setUndo(null);
    moveCardInCache(qc, customer, to, from);
    const result = await onChangePriority({ ...customer, priority: to }, from);
    if (result === "error") {
      moveCardInCache(qc, { ...customer, priority: from }, from, to);
      setError("برگرداندن اولویت انجام نشد. دوباره تلاش کنید.");
    }
  };

  useEffect(() => {
    if (!undo) return;
    const dismiss = () => { setUndo(null); void qc.invalidateQueries({ queryKey: ["cpk-customers"] }); };
    const t = window.setTimeout(dismiss, CPK_UNDO_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); dismiss(); } };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [undo, qc]);

  const onSwipe = (dir: -1 | 1) => {
    const i = columns.findIndex((c) => c.key === tab);
    const next = columns[i + dir];
    if (next) setTab(next.key);
  };

  return (
    <div className="cpk" dir="rtl" data-testid="cpk-board">
      {error ? <div className="csx-note bad" role="alert" data-testid="cpk-error"><p>{error}</p></div> : null}
      <div className="cpk-seg" role="tablist" aria-label="ستون اولویت" data-testid="cpk-seg">
        {columns.map((col) => (
          <button key={col.key} type="button" role="tab" aria-selected={tab === col.key} data-col={col.key}
            onClick={() => setTab(col.key)} data-testid={`cpk-seg-${col.key}`}>
            <span className="lab"><span className="cpk-dot" data-p={col.key} aria-hidden="true" />{col.label}</span>
            <span>{faNum(totalsRef.current[col.key] ?? 0)}</span>
          </button>
        ))}
      </div>
      {allEmpty ? (
        <div className="cpk-all-empty" data-testid="cpk-all-empty">
          <h2>مشتری‌ای با این فیلتر پیدا نشد</h2>
          <p>{hasQuery ? "جستجو یا فیلتر را عوض کنید یا پاک کنید." : "در این وضعیت هنوز مشتری‌ای نیست."}</p>
          {hasQuery ? <button type="button" onClick={onClearFilters}>پاک کردن فیلتر و جستجو</button> : null}
        </div>
      ) : null}
      <div className={`cpk-board${allEmpty ? " cpk-hidden" : ""}`} data-cols={columns.length} style={allEmpty ? { display: "none" } : undefined}
        onTouchStart={isDesktop ? undefined : swipeHandlers(onSwipe).onStart}
        onTouchEnd={isDesktop ? undefined : swipeHandlers(onSwipe).onEnd}>
        {columns.map((col) => (
          <KanbanColumn key={col.key} column={col} filters={filters} isDesktop={isDesktop} active={!isDesktop ? tab === col.key : true}
            canDrag={canDrag && isDesktop} canCall={canCall} onCall={onCall} menuItems={menuItems}
            onChangePriority={canDrag ? (c) => setPriFor(c) : undefined}
            onDrop={canDrag && isDesktop ? (c) => { void applyPriority(c, col.value); } : undefined}
            onTotal={(n) => reportTotal(col.key, n)} movedId={undo?.customer.id} />
        ))}
      </div>
      {undo ? (
        <div className="cpk-snack" role="status" data-testid="cpk-undo">
          <span>{cpkUndoMessage(undo.customer.name, undo.to)}</span>
          <button type="button" onClick={() => { void undoNow(); }} data-testid="cpk-undo-btn">برگردان</button>
        </div>
      ) : null}
      {priFor ? (
        <Sheet title="تغییر اولویت" onClose={() => setPriFor(null)} testId="cpk-pri-sheet">
          <div role="listbox" aria-label="اولویت جدید">
            {CPK_COLUMNS.map((col) => (
              <button key={col.key} type="button" role="option" className="cpk-pri-opt"
                aria-checked={(priFor.priority ?? null) === col.value}
                data-testid={`cpk-pri-opt-${col.key}`}
                onClick={() => { const c = priFor; setPriFor(null); void applyPriority(c, col.value); }}>
                <span className="cpk-dot" data-p={col.key} aria-hidden="true" />
                {col.label}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

function KanbanColumn({ column, filters, isDesktop, active, canDrag, canCall, onCall, menuItems, onChangePriority, onDrop, onTotal, movedId }: {
  column: typeof CPK_COLUMNS[number];
  filters: Filters;
  isDesktop: boolean;
  active: boolean;
  canDrag: boolean;
  canCall: boolean;
  onCall: (customer: CpkCustomer) => void;
  menuItems: (customer: CpkCustomer) => RowMenuItem[];
  onChangePriority?: (customer: CpkCustomer) => void;
  onDrop?: (customer: CpkCustomer) => void;
  onTotal: (total: number) => void;
  movedId?: number;
}) {
  const query = useInfiniteQuery({
    queryKey: ["cpk-customers", column.key, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listCustomers({
      ...filters,
      sortBy: "boardTags",
      priority: column.value ?? undefined,
      hasPriority: column.value === null ? false : undefined,
      offset: pageParam,
      limit: CPK_PAGE,
    }),
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
  const customers = (query.data?.pages.flatMap((page) => page.items) ?? []) as CpkCustomer[];
  const total = query.data?.pages[0]?.total ?? 0;
  useEffect(() => { if (!query.isLoading && !query.isError) onTotal(total); }, [total, query.isLoading, query.isError]); // onTotal writes a ref+tick in the parent

  const remaining = Math.max(0, total - customers.length);

  return (
    <section
      className={`cpk-col${active ? " on" : ""}`}
      data-p={column.key}
      data-testid={`cpk-col-${column.key}`}
      onDragOver={onDrop ? (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); } : undefined}
      onDragLeave={onDrop ? (e) => e.currentTarget.classList.remove("over") : undefined}
      onDrop={onDrop ? (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("over");
        const raw = e.dataTransfer.getData("application/x-cpk-customer") || e.dataTransfer.getData("text/plain");
        if (!raw) return;
        try {
          const c = JSON.parse(raw) as CpkCustomer;
          if (c?.id && (c.priority ?? null) !== column.value) onDrop(c);
        } catch { /* ignore */ }
      } : undefined}
    >
      <div className="cpk-col-hd">
        <span className="cpk-dot" data-p={column.key} aria-hidden="true" />
        <h2>{column.label}</h2>
        <span className="cpk-count" data-testid={`cpk-count-${column.key}`}>{query.isLoading && !query.data ? "…" : faNum(total)}</span>
      </div>
      <div className="cpk-cards" data-testid={`cpk-cards-${column.key}`}>
        {query.isLoading && !query.data ? (
          <>
            <div className="cpk-sk" aria-hidden="true" />
            <div className="cpk-sk" aria-hidden="true" />
            <div className="cpk-sk" aria-hidden="true" />
          </>
        ) : query.isError ? (
          <div className="cpk-err" data-testid={`cpk-err-${column.key}`}>
            <span>بارگذاری نشد</span>
            <button type="button" className="cpk-retry" onClick={() => query.refetch()}>تلاش دوباره</button>
          </div>
        ) : customers.length ? customers.map((customer) => {
          const items: RowMenuItem[] = [];
          if (onChangePriority) items.push({ key: "pri", onSelect: () => onChangePriority(customer), label: "تغییر اولویت", testId: `cpk-menu-pri-${customer.id}` });
          if (canCall) items.push({ key: "call", onSelect: () => onCall(customer), icon: <PhoneCall size={17} aria-hidden="true" />, label: "تماس", testId: `cpk-menu-call-${customer.id}` });
          items.push({ key: "file", href: `/customers/${customer.id}`, label: "باز کردن پرونده", testId: `cpk-menu-file-${customer.id}` });
          for (const it of menuItems(customer)) {
            if (it.key === "file") continue;
            items.push(it);
          }
          const follow = formatFollowUp(customer.nextReminderAt);
          return (
            <article key={customer.id} className={`cpk-card${movedId === customer.id ? " moved" : ""}`} data-p={column.key}
              data-testid={`cpk-card-${customer.id}`}
              draggable={canDrag || undefined}
              onDragStart={canDrag ? (e) => {
                e.dataTransfer.setData("application/x-cpk-customer", JSON.stringify({ id: customer.id, name: customer.name, priority: customer.priority ?? null, nextReminderAt: customer.nextReminderAt ?? null }));
                e.dataTransfer.setData("text/plain", String(customer.id));
                e.dataTransfer.effectAllowed = "move";
                e.currentTarget.classList.add("dragging");
              } : undefined}
              onDragEnd={canDrag ? (e) => e.currentTarget.classList.remove("dragging") : undefined}
            >
              {canDrag ? <span className="cpk-grab" aria-hidden="true" /> : null}
              <Link href={`/customers/${customer.id}`} className="cpk-card-main">
                <div className="cpk-card-hd">
                  <h3>{customer.name}<span className="cpk-cid">#{faNum(customer.id)}</span></h3>
                </div>
                <div className="cpk-phn">
                  <CallNumber phone={customer.phone} customerId={customer.id} via="customers" size="sm" testId={`cpk-ph-${customer.id}`} />
                </div>
                <div className="cpk-meta">
                  <StatusPill status={customer.status} />
                  <span data-testid={`cpk-last-${customer.id}`}>
                    {customer.lastCallAt ? `آخرین تماس: ${relativeTime(customer.lastCallAt)}` : "هنوز تماسی ثبت نشده"}
                  </span>
                  {follow ? <span className="cpk-fu" data-testid={`cpk-fu-${customer.id}`}>پیگیری بعدی: {follow}</span> : null}
                </div>
              </Link>
              <RowActionsMenu items={items} label={`کارهای بیشتر برای ${customer.name}`}
                triggerTestId={`cpk-menu-${customer.id}`} triggerClassName="cpk-menu"
                contentTestId={`cpk-menu-list-${customer.id}`} icon={<MoreHorizontal size={20} aria-hidden="true" />} />
            </article>
          );
        }) : <div className="cpk-empty" data-testid={`cpk-empty-${column.key}`}>در این ستون کسی نیست.</div>}
        {query.isFetchingNextPage ? <div className="cpk-sk" aria-hidden="true" /> : null}
        {query.hasNextPage && !query.isFetchingNextPage ? (
          <button type="button" className="cpk-more" data-testid={`cpk-more-${column.key}`}
            onClick={() => { void query.fetchNextPage(); }}>
            {cpkMoreLabel(remaining)}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function swipeHandlers(onSwipe: (dir: -1 | 1) => void) {
  let x = 0;
  return {
    onStart: (e: TouchEvent) => { x = e.changedTouches[0]?.clientX ?? 0; },
    onEnd: (e: TouchEvent) => {
      const dx = (e.changedTouches[0]?.clientX ?? 0) - x;
      if (Math.abs(dx) < 48) return;
      // RTL: swipe toward the left (negative dx in LTR coords? clientX grows to the right.
      // Swiping finger to the right (positive dx) reveals the next leftward column in LTR, but in RTL
      // the next column to the left visually is a higher index (P1 → P2). Positive dx → next (1).
      onSwipe(dx > 0 ? 1 : -1);
    },
  };
}

