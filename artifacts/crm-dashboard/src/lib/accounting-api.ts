import { api } from './goods-api';

export type AccountingFund = {
  id: number; bankName: string; ownerName: string; fundName: string; iban: string;
  balanceToman: string; initialized: boolean;
};
export type AccountingAttachment = { id: number; name: string; mime: string; size: number };
export type AccountingDocument = {
  id: number; fundId: number; fundName: string; documentDate: string; transactionDate: string;
  amountToman: string; purpose: string; documentType: 'credit' | 'debit';
  transactionType: 'deposit' | 'withdrawal'; source: 'manual' | 'payment_order' | 'opening';
  sourceOrderId: number | null; balanceBeforeToman: string; balanceAfterToman: string;
  createdAt: string; createdByName: string; attachments: AccountingAttachment[];
  counterpartyAccountType: 'iban' | 'card' | null; counterpartyAccountNumber: string | null; counterpartyOwnerName: string | null;
};
export type AccountingInput = {
  requestKey: string; fundId: number; documentDate: string; transactionDate: string;
  amountToman: string; purpose: string; documentType: 'credit' | 'debit'; transactionType: 'deposit' | 'withdrawal';
  counterpartyAccountType?: 'iban' | 'card'; counterpartyAccountNumber?: string; counterpartyOwnerName?: string;
};
export const accountingApi = {
  funds: () => api.get<{ items: AccountingFund[] }>('/accounting/funds'),
  opening: (fundId: number, amountToman: string) => api.post<AccountingDocument>(`/accounting/funds/${fundId}/opening`, { amountToman }),
  list: (filters: { fundId?: string; from?: string; to?: string; page?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
    return api.get<{ items: AccountingDocument[]; total: number; page: number; limit: number }>(`/accounting/documents?${params}`);
  },
  get: (id: number) => api.get<AccountingDocument>(`/accounting/documents/${id}`),
  create: (input: AccountingInput, files: File[]) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(input)) body.set(key, String(value));
    for (const file of files) body.append('files', file);
    return api.post<AccountingDocument>('/accounting/documents', body);
  },
  attach: (id: number, files: File[]) => {
    const body = new FormData();
    for (const file of files) body.append('files', file);
    return api.post<AccountingDocument>(`/accounting/documents/${id}/attachments`, body);
  },
  attachmentUrl: (id: number, attachmentId: number) => `/api/accounting/documents/${id}/attachments/${attachmentId}`,
};