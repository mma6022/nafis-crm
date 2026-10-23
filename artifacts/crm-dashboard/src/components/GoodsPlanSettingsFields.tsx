import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errText, type PlanFinanceSettings } from '@/lib/goods-api';

export type GoodsPlanForm = { customerPayoutPercent: string; developmentDiscountPercent: string; acknowledgementTemplateId: string };
export const blankGoodsPlanForm: GoodsPlanForm = { customerPayoutPercent: '', developmentDiscountPercent: '', acknowledgementTemplateId: '' };

export function saveGoodsPlanSettings(planId: number, f: GoodsPlanForm) {
  return api.put<PlanFinanceSettings>(`/goods-finance/plans/${planId}`, {
    customerPayoutPercent: Number(f.customerPayoutPercent),
    developmentDiscountPercent: Number(f.developmentDiscountPercent),
    acknowledgementTemplateId: Number(f.acknowledgementTemplateId),
  });
}

export function GoodsPlanSettingsFields({ planId, value, onChange, templates, enabled }: { planId?: number | null; value: GoodsPlanForm; onChange: (v: GoodsPlanForm) => void; templates: { id: number; name: string }[]; enabled: boolean }) {
  const q = useQuery({ queryKey: ['goods-plan-settings', planId], queryFn: () => api.get<PlanFinanceSettings | null>(`/goods-finance/plans/${planId}`), enabled: Boolean(planId && enabled), retry: false });
  useEffect(() => {
    const d = q.data;
    if (d) onChange({ customerPayoutPercent: d.customerPayoutPercent === null || d.customerPayoutPercent === undefined ? '' : String(d.customerPayoutPercent), developmentDiscountPercent: d.developmentDiscountPercent === null || d.developmentDiscountPercent === undefined ? '' : String(d.developmentDiscountPercent), acknowledgementTemplateId: d.acknowledgementTemplateId ? String(d.acknowledgementTemplateId) : '' });
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="loan-form-section">
    <div className="loan-form-section-title"><strong>تنظیمات مالی خرید کالا</strong><span>{enabled ? 'درصد پرداخت به مشتری، تخفیف توسعه و قالب اقرارنامه؛ همه الزامی.' : 'فقط برای طرح خرید کالا.'}</span></div>
    {q.isError ? <div className="gp-alert">{errText(q.error)}</div> : null}
    <fieldset disabled={!enabled} style={{ border: 0, padding: 0, margin: 0, opacity: enabled ? 1 : 0.55 }}>
      <div className="form-grid">
        <div className="field"><label>درصد پرداخت به مشتری</label><input type="number" min="0.01" max="100" step="0.01" required={enabled} value={value.customerPayoutPercent} onChange={(e) => onChange({ ...value, customerPayoutPercent: e.target.value })} data-testid="input-payout-percent" /></div>
        <div className="field"><label>درصد تخفیف توسعه</label><input type="number" min="0" max="100" step="0.01" required={enabled} value={value.developmentDiscountPercent} onChange={(e) => onChange({ ...value, developmentDiscountPercent: e.target.value })} data-testid="input-dev-discount" /></div>
        <div className="field full"><label>قالب رسید و اقرارنامه</label><select required={enabled} value={value.acknowledgementTemplateId} onChange={(e) => onChange({ ...value, acknowledgementTemplateId: e.target.value })} data-testid="select-ack-template"><option value="">انتخاب قالب</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
      </div>
    </fieldset>
  </section>;
}
