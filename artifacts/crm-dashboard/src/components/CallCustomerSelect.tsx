import { CustomerName, customerNameText } from '@/components/customer/CustomerName';
import { OtherOwnerResults } from '@/components/customer/OtherOwnerResults';
import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { getListCustomersQueryKey, useListCustomers } from '@workspace/api-client-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandInput, CommandItem, CommandList } from './ui/command';
import './CallCustomerSelect.css';

export type CallCustomer = {
  id: number; name: string; phone: string; salespersonName?: string | null;
  nationalCode?: string | null; postalCode?: string | null; birthDateJalali?: string | null;
  verificationStatus?: string; isUrgent?: boolean;
  /** crm-no-plan-option: the old form shows «اعتبارسنجی سریع» for P1/P2/P3 only. */
  priority?: number | null;
};

export function CallCustomerSelect({ selected, disabled, onSelect, id = 'call-customer', labelId = 'call-customer-label', testId = 'select-call-customer' }: {
  selected?: CallCustomer; disabled: boolean; onSelect: (customer: CallCustomer) => void;
  /** Reused outside the call form (e.g. consultation edit): trigger id, its label's id and test id. */
  id?: string; labelId?: string; testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = { search: debouncedSearch || undefined, limit: 50 };
  const customers = useListCustomers(params, {
    query: { queryKey: getListCustomersQueryKey(params), enabled: open && !disabled, staleTime: 0 },
  });
  const waiting = search.trim() !== debouncedSearch || customers.isFetching;
  const items = customers.data?.items ?? [];
  return <Popover open={open} onOpenChange={(next) => {
    setOpen(next);
    if (!next) { setSearch(''); setDebouncedSearch(''); }
  }}>
    <PopoverTrigger asChild>
      <button id={id} type="button" role="combobox" aria-expanded={open}
        aria-labelledby={labelId} disabled={disabled}
        className="call-customer-trigger" data-testid={testId}>
        <span>{selected ? `${customerNameText(selected.name, selected.id)} · ${selected.phone}` : 'یک مشتری را انتخاب کنید'}</span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" dir="rtl" className="call-customer-popover">
      <Command shouldFilter={false}>
        <CommandInput value={search} onValueChange={setSearch}
          aria-label="جست‌وجوی نام یا شناسه‌ی مشتری" placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)"
          data-testid="input-call-customer-search" />
        <CommandList aria-label="مشتریان">
          {waiting ? <div className="call-customer-message" role="status">در حال جست‌وجو…</div>
            : customers.isError ? <div className="call-customer-message" role="alert">
              دریافت مشتریان انجام نشد.
              <button type="button" className="btn btn-ghost" onClick={() => void customers.refetch()}>تلاش دوباره</button>
            </div>
            : items.length === 0 ? <div className="call-customer-message" role="status">مشتری‌ای پیدا نشد.</div>
            : items.map(customer => <CommandItem key={customer.id} value={String(customer.id)}
              data-testid={`option-call-customer-${customer.id}`}
              onSelect={() => { onSelect(customer); setOpen(false); setSearch(''); setDebouncedSearch(''); }}>
              <Check size={15} aria-hidden="true" style={{ opacity: selected?.id === customer.id ? 1 : 0 }} />
              <span><strong><CustomerName id={customer.id} name={customer.name} /></strong><small>{customer.phone} · کارشناس پرونده: {customer.salespersonName || 'بدون تخصیص'}</small></span>
            </CommandItem>)}
          {!waiting && !customers.isError ? <OtherOwnerResults page={customers.data} variant="inline" /> : null}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}
