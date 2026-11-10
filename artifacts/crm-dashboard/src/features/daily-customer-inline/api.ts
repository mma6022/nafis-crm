/** daily-customer-inline v1.1 client. Flag OFF → status.enabled=false; data routes 404 dci_off and are not called. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export class DciError extends Error {
  status: number; code: string; body: any;
  constructor(message: string, status: number, code: string, body: any) {
    super(message); this.status = status; this.code = code; this.body = body;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && typeof data.message === "string" && data.message) || "انجام نشد. دوباره تلاش کن.";
    throw new DciError(msg, res.status, data && typeof data.error === "string" ? data.error : "", data);
  }
  return data as T;
}

export type DciTask = { id: string; kind: "plan" | "inbound"; itemId: number | null; customerId: number; name: string; typ: string; ic: string; tm: string; at: string | null; status?: string | null };
export type DciToday = { enabled: true; date: string; dateLabel: string; hasExtension: boolean; tasks: DciTask[] };
export type DciInbound = { id: number; callLogId: number | null; t: string; at: string; r: string; rc: string; text: string | null; missed: boolean; note: string };
export type DciHist = { id: number; t: string; at: string; k: string; r: string; rc: string; note: string };
export type DciNote = { id: string; t: string; body: string; source: string };
export type DciCase = { id: number; plan: string; amount: string | null; months: number | null; stage: string; status: string; act: string; href: string; open: boolean; life?: "in_progress" | "completed" | "cancelled"; canCancel?: boolean };
export type DciBoard = {
  enabled: true;
  access: "own" | "manager";
  hasExtension: boolean;
  canPromote: boolean;
  canEditPriorityStatus?: boolean;
  /** UI-only: show inert chips + grey reason (no permission). Not set by the server. */
  priorityStatusLocked?: boolean;
  priorityDemoteTransfer?: { expertName: string } | null;
  customer: { id: number; name: string; phone: string | null; nationalCode: string | null; priority: number | null; status?: string | null; tags: string[] };
  call: string;
  prio: boolean;
  hist: DciHist[];
  notes: DciNote[];
  inbounds: DciInbound[];
  credit: { state: "ok" | "start" | "err" | "none"; grade: string | null; at: string | null };
  guar: { v: "yes" | "no" | "unknown"; cond: string | null };
  wallet: { balance: string | null; tx: { t: string; ti: string; a: string; in: boolean }[] } | null;
  cases: DciCase[];
  first: boolean;
  newCaseHref: string;
};
export type DciDenied = { error: "not_owner"; message: string; customerId: number; name: string; expertName: string | null };

export const dciApi = {
  status: () => req<{ enabled: boolean }>("GET", "/daily-customer-inline/status"),
  today: () => req<DciToday>("GET", "/daily-customer-inline/today"),
  board: (id: number, task?: string | null) => req<DciBoard>("GET", `/daily-customer-inline/customers/${id}${task ? `?task=${encodeURIComponent(task)}` : ""}`),
  addNote: (id: number, body: string) => req<{ ok: true; notes: DciNote[] }>("POST", `/daily-customer-inline/customers/${id}/notes`, { body }),
  inboundNote: (eventId: number, body: string) => req<{ ok: true; customerId: number }>("POST", `/daily-customer-inline/inbounds/${eventId}/note`, { body }),
};

export function useDciStatus(enabled = true) {
  return useQuery({
    queryKey: ["dci-status"],
    queryFn: () => dciApi.status().catch(() => ({ enabled: false })),
    enabled, staleTime: 30_000, retry: false,
  });
}
export function useDciToday(enabled = true) {
  return useQuery({ queryKey: ["dci-today"], queryFn: dciApi.today, enabled, staleTime: 15_000, retry: false });
}
export function useDciBoard(customerId: number | null, enabled = true, task?: string | null) {
  return useQuery({
    queryKey: ["dci-board", customerId, task ?? ""],
    queryFn: () => dciApi.board(Number(customerId), task),
    enabled: enabled && Boolean(customerId), staleTime: 10_000, retry: false,
  });
}
export function useDciAddNote(customerId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => dciApi.addNote(customerId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["dci-board", customerId] }),
  });
}
