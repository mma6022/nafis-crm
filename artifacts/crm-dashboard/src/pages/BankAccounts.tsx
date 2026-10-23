import { useState, type FormEvent } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Plus } from 'lucide-react';
import { EmptyState, Modal } from '@/components/DataTools';
import { ErrorState, SkeletonPanel, formatDate } from '@/components/CrmShell';
import { api, digitsOnly, errText, listOf, ownerTypeLabel, useMe, type BankAccount } from '@/lib/goods-api';

export default function BankAccounts() {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const [type, setType] = useTableState('bankAccounts.type', '');
  const q = useQuery({ queryKey: ['bank-accounts'], queryFn: () => api.get<unknown>('/bank-accounts').then((d) => listOf<BankAccount>(d)) });
  const rows = (q.data ?? []).filter((a) => !type || a.ownerType === type);
  return <section className="data-page">
    <div className="page-intro"><div><div className="eyebrow">خزانه</div><h2>حساب‌های بانکی</h2><p>دفتر حساب‌های شرکت و اشخاص برای پرداخت دستورها.</p></div>
      {can('bank_accounts.manage') ? <button className="btn btn-primary" onClick={() => setOpen(true)} data-testid="button-new-bank-account"><Plus size={16} />حساب تازه</button> : null}</div>
    <div className="filter-tabs" style={{ width: 'fit-content', marginBottom: 14 }}>
      {[['', 'همه'], ['company', 'شرکت'], ['person', 'اشخاص']].map(([k, l]) => <button key={k} className={`filter-tab ${type === k ? 'active' : ''}`} onClick={() => setType(k)}>{l}</button>)}
    </div>
    {q.isLoading ? <SkeletonPanel rows={4} /> : q.isError ? <div className="panel"><div className="gp-alert">{errText(q.error)}</div><ErrorState onRetry={() => q.refetch()} /></div> : !rows.length ? <div className="panel"><EmptyState title="حسابی ثبت نشده" description="نخستین حساب شرکت را برای پرداخت‌ها اضافه کنید." /></div> :
      <div className="gp-bank-grid">{rows.map((a) => <div key={a.id} className="gp-bank-card" data-testid={`card-bank-${a.id}`}>
        <div className="gp-card-top"><Landmark size={18} /><span className="inline-badge gold">{ownerTypeLabel(a.ownerType ?? undefined)}</span></div>
        <strong>{a.bankName}</strong><span>{a.fundName || '—'}</span>
        <span className="mono gp-iban" dir="ltr">{a.iban}</span>
        <small>{a.ownerName}{a.verifiedAt ? ` · ${formatDate(a.verifiedAt)}` : ''}</small>
      </div>)}</div>}
    {open ? <NewAccount onClose={() => setOpen(false)} /> : null}
  </section>;
}

function NewAccount({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ bankName: '', iban: '', ownerType: '' });
  const m = useMutation({ mutationFn: () => api.post('/bank-accounts', { ...f, bankName: f.bankName.trim(), iban: `IR${digitsOnly(f.iban)}` }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['bank-accounts'] }); onClose(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!m.isPending) m.mutate(); };
  return <Modal title="ثبت حساب بانکی" eyebrow="خزانه" onClose={onClose} testId="new-bank-account">
    <form onSubmit={submit}><div className="form-grid">
      <div className="field"><label>نوع حساب</label><select required disabled={m.isPending} value={f.ownerType} onChange={(e) => setF({ ...f, ownerType: e.target.value })}><option value="" disabled>انتخاب کنید</option><option value="company">شرکتی</option><option value="person">شخصی</option></select></div>
      <div className="field"><label>نام بانک</label><input required maxLength={150} disabled={m.isPending} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} /></div>
      <div className="field full"><label>شبا (۲۴ رقم بدون IR)</label><input required disabled={m.isPending} dir="ltr" pattern="[0-9۰-۹٠-٩ ]{24,30}" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} /></div>
      <div className="field full"><p>نام صاحب حساب از سرویس استعلام شبا دریافت می‌شود. نام صندوق به‌صورت خودکار از «نام بانک + نام صاحب حساب» ساخته و پس از ثبت نمایش داده می‌شود.</p></div>
    </div>
    {m.isError ? <div className="gp-alert">{errText(m.error)}</div> : null}
    <div className="form-footer"><button className="btn btn-primary" disabled={m.isPending || !f.ownerType || !f.bankName.trim() || digitsOnly(f.iban).length !== 24}>{m.isPending ? 'در حال استعلام و ثبت…' : 'استعلام و ثبت حساب'}</button><button type="button" className="btn btn-ghost" disabled={m.isPending} onClick={onClose}>انصراف</button></div></form>
  </Modal>;
}
