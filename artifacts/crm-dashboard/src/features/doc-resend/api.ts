import { useQuery } from '@tanstack/react-query';
import { api, type GoodsDocument, type Purchase, type PaymentOrder } from '@/lib/goods-api';

export const DOC_RESEND_FLAG = 'flag.doc_resend_v1';

export type DocResendMe = {
  enabled: boolean;
  flag: string;
  canAct: boolean;
  salesManager?: boolean;
  stageLabels?: { goods: Record<string, string>; payment: Record<string, string> };
};

export type DocHistory = GoodsDocument & { invoiceNumber?: string | null };

export type GoodsAdminControls = {
  kind: 'goods';
  id: number;
  stage: string;
  stageLabel: string;
  stages: { key: string; label: string }[];
  allowedTargetStages: string[];
  blockedTargetStages: { stage: string; reason: string }[];
  allowedResendKinds: Array<'invoice' | 'acknowledgement'>;
  canReviseInvoice: boolean;
  documents: { invoice: DocHistory[]; acknowledgement: DocHistory[] };
  invoiceVersion: number;
  invoiceSignedVersion: number | null;
  acknowledgementSigned: boolean;
};

export type PaymentAdminControls = {
  kind: 'payment';
  id: number;
  purchaseId: number;
  stage: string;
  stageLabel: string;
  stages: { key: string; label: string }[];
  allowedTargetStages: string[];
  blockedTargetStages: { stage: string; reason: string }[];
  allowedResendKinds: [];
  preOpening: boolean;
  canUnpay: boolean;
};

export type AdminControls = GoodsAdminControls | PaymentAdminControls;

export function useDocResendMe() {
  return useQuery({
    queryKey: ['doc-resend', 'me'],
    queryFn: async () => {
      try { return await api.get<DocResendMe>('/doc-resend/me'); }
      catch { return { enabled: false, flag: DOC_RESEND_FLAG, canAct: false } as DocResendMe; }
    },
  });
}

export function useAdminControls(kind: 'goods' | 'payment', id: number, enabled: boolean) {
  const path = kind === 'goods' ? `/goods-purchases/${id}/admin-controls` : `/payment-orders/${id}/admin-controls`;
  return useQuery({
    queryKey: ['doc-resend', 'controls', kind, id],
    queryFn: () => api.get<AdminControls>(path),
    enabled: enabled && id > 0,
  });
}

export function postGoodsStage(id: number, stage: string, reason: string, expectedStage: string) {
  return api.post<Purchase>(`/goods-purchases/${id}/admin-stage`, { stage, reason, confirmed: true, expectedStage });
}
export function postPaymentStage(id: number, stage: string, reason: string, expectedStage: string) {
  return api.post<PaymentOrder>(`/payment-orders/${id}/admin-stage`, { stage, reason, confirmed: true, expectedStage });
}
export function postGoodsResend(id: number, kind: 'invoice' | 'acknowledgement', reason: string, expectedStage: string, values?: Record<string, string>) {
  return api.post<{ document: GoodsDocument; purchase: Purchase; kind: string }>(`/goods-purchases/${id}/admin-resend/${kind}`, { reason, confirmed: true, expectedStage, values: values ?? {} });
}
export function postAdminInvoice(id: number, items: unknown[], reason: string, expectedStage: string) {
  return api.post<Purchase>(`/goods-purchases/${id}/admin-invoice`, { items, reason, confirmed: true, expectedStage });
}

export const BLOCK_REASON: Record<string, string> = {
  completed_financial_lock: 'پس از تکمیل خرید، بازگشت مرحله ممکن نیست؛ پورسانت ثبت شده و ممکن است دستور پرداخت ساخته شده باشد.',
  settlement_financial_lock: 'پس از تسویه با شرکت، بازگشت به مراحل قبل از تسویه ممکن نیست؛ اعتبار مشتری مصرف شده است.',
  pre_opening_unpay_forbidden: 'این دستور در ماندهٔ افتتاحیه است و بازگشت مرحله ندارد.',
};
