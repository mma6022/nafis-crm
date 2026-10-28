/**
 * v82 · Armita site-apply-wizard v1.0.1 HANDOFF §۴ب: site answers → first-call / file form.
 * Only a one-to-one answer is prefilled (and only into an EMPTY field); everything else gets a «سایت: …» hint line.
 * Every prefilled field stays editable. No amount number, rank, city or guarantor detail is ever invented.
 */
import { saText, type SiteAnswers } from './api';

export type SitePrefill = Partial<{
  urgency: 'now' | 'month' | 'curious'; cheque: 'check'; gAvail: 'yes'; docsReady: 'none'; bounced: 'no';
  military: 'has_card' | 'no_card'; jobType: 'retired';
}>;
export type SiteHints = Partial<Record<'amount' | 'docsReady' | 'bounced' | 'military' | 'jobType' | 'sso' | 'gAvail', string>>;

export function sitePrefill(a: SiteAnswers): SitePrefill {
  const p: SitePrefill = {};
  if (a.need_timing === 'this_week') p.urgency = 'now';
  else if (a.need_timing === 'this_month') p.urgency = 'month';
  else if (a.need_timing === 'just_browsing') p.urgency = 'curious';
  const docs = a.documents ?? [];
  if (docs.includes('sayadi_cheque')) p.cheque = 'check';
  if (docs.includes('guarantor')) p.gAvail = 'yes';
  if (docs.length === 1 && docs[0] === 'none') p.docsReady = 'none';
  if (a.has_bounced_or_overdue === 'no') p.bounced = 'no';
  if (a.has_military_card === 'yes') p.military = 'has_card';
  else if (a.has_military_card === 'no') p.military = 'no_card';
  if (a.job_status === 'retired') p.jobType = 'retired';
  return p;
}

const JOB_ASK: Record<string, string> = {
  employee: 'با یا بدون لیست بیمه را بپرس', self_employed: 'با یا بدون مدرک شغلی را بپرس', no_fixed_income: 'شغل و درآمد فعلی را بپرس',
};
export function siteHints(a: SiteAnswers): SiteHints {
  const h: SiteHints = {};
  if (a.amount_range) h.amount = `سایت: ${saText('amount_range', a.amount_range)}؛ عدد دقیق را بپرس`;
  const docs = a.documents ?? [];
  if (docs.length && !(docs.length === 1 && docs[0] === 'none')) h.docsReady = `سایت: ${saText('documents', docs)}؛ آماده بودنش را بپرس`;
  if (a.has_bounced_or_overdue === 'yes') h.bounced = 'سایت: چک برگشتی یا بدهی معوق بانکی دارد (هر دو با هم پرسیده شده)؛ کدام است و رفع شده یا نه را بپرس';
  if (a.has_military_card === 'not_applicable') h.military = 'سایت: «مشمول نیستم» را زده؛ دلیلش را بپرس';
  if (a.job_status && a.job_status !== 'retired') h.jobType = `سایت: ${saText('job_status', a.job_status)}؛ ${JOB_ASK[a.job_status] ?? 'جزئیات را بپرس'}`;
  if (a.can_refer_retiree === 'yes') h.sso = 'سایت: می‌تواند یک متقاضی بازنشسته معرفی کند؛ این سؤال جداست';
  else if (a.can_refer_retiree === 'no') h.sso = 'سایت: متقاضی بازنشسته‌ای معرفی نمی‌کند؛ این سؤال جداست';
  if (!docs.includes('guarantor')) h.gAvail = 'سایت: ضامن را انتخاب نکرده؛ بپرس';
  return h;
}
