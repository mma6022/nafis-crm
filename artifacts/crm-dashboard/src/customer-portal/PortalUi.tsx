// Shared building blocks of the redesigned customer tracking pages (nfp-* classes from nfp.css).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { getPublicLoanPlan } from '@workspace/api-client-react';
import {
  AlertCircle, Ban, Check, ChevronLeft, ExternalLink, FileText, FileX, Hourglass, MessageSquare,
  PartyPopper, PenLine, Phone, RefreshCw, Search, Upload, UserRound, X,
} from 'lucide-react';
import type { Application } from './api';
import { monthlyPmt, planAnnualInterest } from './plan-calculator-values';
import {
  CHAT_HREF, DOC_STATUS, EMZAME_URL, PHASES, PHASE_HINTS, UNKNOWN_AMOUNT,
  isCompleted, stageCopy, stageLabel, terminalOf, type DocTone,
} from './customer-stage-map';
import { ExpertPickerButton } from './ExpertPicker';

const DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const fa = (value: string | number) => String(value).replace(/\d/g, d => DIGITS[Number(d)]);
export const money = (value: number) => Math.round(value).toLocaleString('fa-IR');
const persianDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' });
export const day = (value?: string | null) => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : persianDate.format(d); };
export const formatMobile = (value: string) => fa(value.replace(/^(\d{4})(\d{3})(\d{0,4})$/, '$1 $2 $3').trim());
export const initials = (name?: string | null) => (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join(' ');
const months = (app: Application) => app.durationMonths || app.requestedDurationMonths || 0;
const payout = (app: Application) => { const n = Number(app.cashPayoutAmount); return app.cashPayoutAmount == null || app.cashPayoutAmount === '' || !Number.isFinite(n) ? null : n; };
const Sep = () => <span className="nfp-sep" aria-hidden="true" />;
const I = ({ icon: Icon, small }: { icon: typeof Check; small?: boolean }) => <Icon className={`nfp-i${small ? ' nfp-s' : ''}`} aria-hidden="true" />;

/** Installment is not returned by the API; it is computed client-side exactly like PlanCalculator (handoff §6). */
export function useInstallment(app: Application): number | null {
  const plan = useQuery({ queryKey: ['customer', 'plan-details', app.planId], queryFn: () => getPublicLoanPlan(app.planId), staleTime: 60_000, retry: false });
  const n = months(app);
  const principal = Number(app.approvedAmount ?? app.requestedAmount);
  if (!plan.data || !n || !Number.isSafeInteger(principal)) return null;
  const rate = planAnnualInterest(plan.data, n);
  return rate == null ? null : monthlyPmt(principal, rate, n);
}

export function Amount({ value, big }: { value: number | null; big?: boolean }) {
  if (value == null) return <span className="nfp-none">{UNKNOWN_AMOUNT}</span>;
  return big ? <b>{money(value)} <small>تومان</small></b> : <b>{money(value)} <small>تومان</small></b>;
}

export function Pill({ app }: { app: Application }) {
  const term = terminalOf(app.status);
  if (term) return <span className="nfp-st nfp-bad">{term.label}</span>;
  if (isCompleted(app)) return <span className="nfp-st nfp-ok">تکمیل‌شده</span>;
  return stageCopy(app.stage).turn === 'you' ? <span className="nfp-st nfp-you">نوبت شما</span> : <span className="nfp-st nfp-us">نوبت ما</span>;
}

export function PhaseBar({ app }: { app: Application }) {
  const p = stageCopy(app.stage).phase; const term = !!terminalOf(app.status); const done = isCompleted(app);
  return <div className="nf-progress" aria-hidden="true">{PHASES.map((_, i) => <span key={i} className={done || i < p ? 'is-done' : i === p && !term ? 'is-current' : ''} />)}</div>;
}

function Todo({ app }: { app: Application }) {
  const term = terminalOf(app.status);
  if (term) return <div className="nfp-rq-todo nfp-bad"><I icon={Ban} small />این درخواست {term.label}<span className="nfp-go">جزئیات<I icon={ChevronLeft} small /></span></div>;
  if (isCompleted(app)) return <div className="nfp-rq-todo nfp-ok"><I icon={Check} small />همه‌ی مراحل انجام شد</div>;
  const s = stageCopy(app.stage);
  return s.turn === 'you'
    ? <div className="nfp-rq-todo"><I icon={PenLine} small />{s.title}<span className="nfp-go">انجام<I icon={ChevronLeft} small /></span></div>
    : <div className="nfp-rq-todo nfp-us"><I icon={Hourglass} small />{s.title}</div>;
}

export function RequestCard({ app }: { app: Application }) {
  const inst = useInstallment(app);
  const pay = payout(app);
  const term = terminalOf(app.status);
  const phase = stageCopy(app.stage).phase;
  const name = app.planName || `درخواست ${fa(app.id)}`;
  return <Link className="nfp-rq" href={`/customer/applications/${app.id}`} aria-label={`${name}، پرونده ${fa(app.id)}`} data-testid={`link-application-${app.id}`}>
    <div className="nfp-rq-top" data-testid={`card-application-${app.id}`}><div><b>{name}</b><small>پرونده {fa(app.id)}<Sep />ثبت {day(app.createdAt)}</small></div><Pill app={app} /></div>
    <div className="nfp-rq-facts">
      <div><span>مبلغ دریافتی</span>{pay == null ? <b className="nfp-none">{UNKNOWN_AMOUNT}</b> : <b>{money(pay)} تومان</b>}</div>
      <div><span>مبلغ قسط<Sep />{fa(months(app))} قسط</span>{inst == null ? <b className="nfp-none">{UNKNOWN_AMOUNT}</b> : <b>{money(inst)} تومان</b>}</div>
    </div>
    {!term && <div style={{ display: 'grid', gap: 6 }}><PhaseBar app={app} /><span className="nfp-muted">مرحله {fa(phase + 1)} از {fa(PHASES.length)}: {PHASES[phase]}</span></div>}
    <Todo app={app} />
  </Link>;
}

export function SkeletonCards({ n = 2 }: { n?: number }) {
  return <div className="nfp-stack" role="status" aria-label="در حال دریافت اطلاعات">{Array.from({ length: n }, (_, i) => <div className="nfp-sk-card" aria-hidden="true" key={i}>
    <div className="nfp-sk" style={{ height: 20, width: '55%' }} /><div className="nfp-sk" style={{ height: 14, width: '35%' }} /><div className="nfp-sk" style={{ height: 6 }} /><div className="nfp-sk" style={{ height: 44 }} />
  </div>)}</div>;
}

export function ErrorBox({ title = 'درخواست‌ها بارگیری نشد', text = 'ارتباط با سامانه برقرار نشد. دوباره تلاش کنید.', retry }: { title?: string; text?: string; retry: () => void }) {
  return <div className="nfp-card"><div className="nfp-empty nfp-err" role="alert"><span className="nfp-big"><I icon={AlertCircle} /></span><h2>{title}</h2>
    <p>{text}</p>
    <button type="button" className="nf-btn nf-btn--secondary" onClick={retry} data-testid="button-retry"><I icon={RefreshCw} small />تلاش دوباره</button></div></div>;
}

export function EmptyBox({ icon = FileText, title, text, children }: { icon?: typeof Check; title: string; text?: string; children?: ReactNode }) {
  return <div className="nfp-card"><div className="nfp-empty"><span className="nfp-big"><I icon={icon} /></span><h2>{title}</h2>{text && <p>{text}</p>}{children}</div></div>;
}

export function NotFoundBox() {
  return <EmptyBox icon={Search} title="این پرونده پیدا نشد" text="اطلاعات موردنظر پیدا نشد. شاید شماره‌ی پرونده اشتباه است یا پرونده به حساب دیگری تعلق دارد.">
    <Link href="/customer/applications" className="nf-btn nf-btn--primary" data-testid="link-back-requests">رفتن به درخواست‌های من</Link>
  </EmptyBox>;
}

const EmzameLink = ({ label, className, testId }: { label: string; className: string; testId?: string }) =>
  <a className={className} href={EMZAME_URL} target="_blank" rel="noopener noreferrer" aria-label={`${label} (در پنجره‌ی جدید)`} data-testid={testId}><I icon={PenLine} small />{label}<I icon={ExternalLink} small /></a>;

export function NextCard({ app, context }: { app: Application; context?: ReactNode }) {
  const term = terminalOf(app.status);
  if (term) return <section className="nfp-next nfp-bad" aria-labelledby="nfp-next-t" data-testid="card-next-step">{context}
    <div className="nfp-hd2"><span className="nfp-ic"><I icon={Ban} /></span><div><span className="nfp-k">وضعیت پرونده</span><h2 id="nfp-next-t">این درخواست {term.label}</h2></div></div>
    <p>برای دانستن دلیل یا ثبت درخواست تازه، با کارشناس پرونده صحبت کنید.</p>
    <div className="nfp-acts"><Link className="nf-btn nf-btn--primary" href={CHAT_HREF}><I icon={MessageSquare} small />گفتگو با کارشناس</Link><Link className="nf-btn nf-btn--secondary" href="/customer/plans">درخواست تازه</Link></div>
  </section>;
  const s = stageCopy(app.stage);
  const cls = s.turn === 'you' ? ' nfp-you' : s.turn === 'done' ? ' nfp-done' : '';
  let acts: ReactNode = null;
  if (s.cta === 'sign') acts = <><EmzameLink label="ورود به امضامی" className="nf-btn nf-btn--primary" testId="link-emzame" /><ExpertPickerButton label="سؤال دارم؛ تماس با کارشناس" testId="button-next-expert" assigned={app.salesExpert} caseNo={app.id} /></>;
  else if (s.cta === 'docs') acts = <><Link className="nf-btn nf-btn--primary" href={CHAT_HREF}><I icon={Upload} small />ارسال مدارک در گفتگو</Link><a className="nf-btn nf-btn--secondary" href="#nfp-docs">دیدن فهرست مدارک</a></>;
  else if (s.cta === 'call') acts = <><ExpertPickerButton className="nf-btn nf-btn--primary nfp-call" label="تماس با کارشناس" testId="button-next-expert" assigned={app.salesExpert} caseNo={app.id} /><Link className="nf-btn nf-btn--secondary" href={CHAT_HREF}><I icon={MessageSquare} small />پیام در گفتگو</Link></>;
  else if (s.turn === 'done') acts = <Link className="nf-btn nf-btn--secondary" href={CHAT_HREF}><I icon={MessageSquare} small />گفتگو با کارشناس</Link>;
  const label = s.turn === 'you' ? 'مرحله‌ی بعدی: نوبت شما' : s.turn === 'done' ? 'پایان پرونده' : 'مرحله‌ی بعدی: نوبت ما';
  const icon = s.turn === 'you' ? (s.cta === 'sign' ? PenLine : s.cta === 'docs' ? Upload : Phone) : s.turn === 'done' ? PartyPopper : Hourglass;
  return <section className={`nfp-next${cls}`} aria-labelledby="nfp-next-t" data-testid="card-next-step">{context}
    <div className="nfp-hd2"><span className="nfp-ic"><I icon={icon} /></span><div><span className="nfp-k">{label}</span><h2 id="nfp-next-t">{s.title}</h2></div></div>
    <p>{s.description}</p>
    {acts && <div className="nfp-acts">{acts}</div>}
    {s.cta === 'sign' && <span className="nfp-ext"><I icon={ExternalLink} small />امضا در سایت امضامی (web.emzame.ir) انجام می‌شود.</span>}
  </section>;
}

export function PhaseBlock({ app }: { app: Application }) {
  const s = stageCopy(app.stage); const term = terminalOf(app.status); const done = isCompleted(app); const p = s.phase;
  return <section className={`nfp-card nfp-phase${term ? ' nfp-bad' : ''}`} aria-labelledby="nfp-ph"><h2 id="nfp-ph">پیشرفت پرونده</h2>
    <div className="nfp-phase-meta"><span>{term ? 'متوقف شد' : <>مرحله <b>{fa(p + 1)}</b> از {fa(PHASES.length)}</>}</span>
      <span>{term ? <span className="nfp-st nfp-bad">{term.label}</span> : done ? <span className="nfp-st nfp-ok">تکمیل‌شده</span> : <>وضعیت دقیق: <b data-testid="text-stage-label">{stageLabel(app.stage)}</b></>}</span></div>
    <PhaseBar app={app} />
    <ol className="nfp-phase-list">{PHASES.map((t, i) => {
      const c = done || i < p ? 'done' : i === p ? (term ? 'stop' : 'now') : 'fut';
      return <li className={`nfp-${c}`} key={t}><span className="nfp-m">{c === 'stop' ? <I icon={X} small /> : c === 'done' ? <Check className="nfp-i nfp-s" style={{ width: 16, height: 16 }} aria-hidden="true" /> : fa(i + 1)}</span>
        <div><b>{t}</b><small>{c === 'stop' ? `در این مرحله ${term!.label}` : c === 'now' ? (s.turn === 'you' ? 'الان نوبت شماست' : 'در حال انجام توسط نفیس وام') : PHASE_HINTS[i]}</small></div></li>;
    })}</ol>
  </section>;
}

export function MoneyBlock({ app }: { app: Application }) {
  const inst = useInstallment(app);
  return <section className="nfp-card" aria-labelledby="nfp-mn"><h2 id="nfp-mn">خلاصه‌ی وام</h2>
    <div className="nfp-facts" style={{ marginTop: 10 }}>
      <div className="nfp-fact nfp-big" data-testid="text-cash-payout"><span>مبلغ دریافتی</span><Amount value={payout(app)} big /></div>
      <div className="nfp-fact" data-testid="text-installment"><span>مبلغ قسط</span><Amount value={inst} /></div>
      <div className="nfp-fact"><span>تعداد اقساط</span><b>{fa(months(app))} <small>قسط ماهانه</small></b></div>
    </div></section>;
}

export function SignatureBlock({ app }: { app: Application }) {
  const s = stageCopy(app.stage); const need = s.cta === 'sign';
  const signed = app.currentPrimaryContractSigned || app.initialContractRetained;
  const title = app.stage === 'approved_contract_pending_signature' ? 'قرارداد جایگزین' : app.stage === 'final_invoice_pending_signature' ? 'صورت‌حساب نهایی' : 'قرارداد اولیه';
  const ok = !need && signed;
  return <section className="nfp-card" aria-labelledby="nfp-sg" data-testid="card-signature"><h2 id="nfp-sg">امضای قرارداد</h2>
    <div className="nfp-sig" style={{ marginTop: 10 }}><span className={`nfp-ic ${ok ? 'nfp-ok' : 'nfp-no'}`}><I icon={ok ? Check : PenLine} /></span><div>
      {need ? <><b style={{ color: 'var(--nf-ink)' }}>{title}: امضا نشده</b><p className="nfp-muted">امضا در سامانه‌ی امضامی انجام می‌شود.</p></>
        : signed ? <><b style={{ color: 'var(--nf-ink)' }}>قرارداد امضا شده است</b><p className="nfp-muted">{app.initialContractRetained ? 'همان قرارداد اول معتبر ماند؛ امضای دوباره لازم نیست.' : 'نیازی به اقدام شما نیست.'}</p></>
        : <><b style={{ color: 'var(--nf-ink)' }}>هنوز قراردادی برای امضا آماده نیست</b><p className="nfp-muted">کارشناس در حال تکمیل قرارداد است.</p></>}
    </div></div>
    {need && <><ol className="nfp-howto"><li>در امضامی با همین شماره همراه ثبت‌نام کنید.</li><li>گواهی امضای دیجیتال بگیرید.</li><li>{title} را باز کنید و امضا کنید.</li></ol>
      <a className="nf-btn nf-btn--secondary nf-btn--block" style={{ marginTop: 12 }} href={EMZAME_URL} target="_blank" rel="noopener noreferrer" aria-label="ورود به امضامی (در پنجره‌ی جدید)">ورود به امضامی<I icon={ExternalLink} small /></a></>}
  </section>;
}

type DocKind = keyof typeof DOC_STATUS;
const docKind = (d: Application['documents'][number]): DocKind =>
  d.status === 'approved' ? 'approved' : d.status === 'rejected' ? 'rejected' : d.status === 'incomplete' ? 'incomplete'
    : d.status === 'uploaded' || d.originalName ? 'pending' : 'missing';
const DOC_ICON: Record<DocTone, typeof Check> = { ok: Check, wait: Hourglass, bad: FileX, warn: FileX, none: FileText };
const DOC_CLASS: Record<DocTone, string> = { ok: 'nfp-ok', wait: 'nfp-wait', bad: 'nfp-bad', warn: 'nfp-warn', none: '' };

export function DocsBlock({ app }: { app: Application }) {
  const docs = app.documents ?? [];
  if (!docs.length) return null;
  const kinds = docs.map(docKind);
  const fix = kinds.filter(k => k === 'rejected' || k === 'incomplete').length;
  const miss = kinds.filter(k => k === 'missing').length;
  return <section className="nfp-card" id="nfp-docs" aria-labelledby="nfp-dc" data-testid="card-documents"><h2 id="nfp-dc">مدارک پرونده</h2>
    <p className="nfp-muted">{fix || miss ? <>{fix ? `${fa(fix)} مدرک نیاز به اصلاح` : ''}{fix && miss ? ' و ' : ''}{miss ? `${fa(miss)} مدرک هنوز ارسال نشده` : ''}.</> : kinds.every(k => k === 'approved') ? 'همه‌ی مدارک تأیید شده است.' : 'مدارک شما در حال بررسی است.'}</p>
    <div className="nfp-list">{docs.map((d, i) => { const m = DOC_STATUS[kinds[i]]; const Icon = DOC_ICON[m.tone];
      return <div className="nfp-li" key={d.id} data-testid={`doc-${d.requirementKey}`}><span className={`nfp-ic ${DOC_CLASS[m.tone]}`}><I icon={Icon} small /></span><div className="nfp-t"><b>{d.label}</b>
        <small className={DOC_CLASS[m.tone]}>{m.label}</small>
        {(m.tone === 'bad' || m.tone === 'warn') && d.reviewReason && <div className={`nfp-reason ${DOC_CLASS[m.tone]}`}>{d.reviewReason}</div>}</div></div>; })}</div>
    {(fix > 0 || miss > 0) && <Link className="nf-btn nf-btn--secondary nf-btn--block" style={{ marginTop: 8 }} href={CHAT_HREF}><I icon={Upload} small />ارسال مدرک در گفتگو با کارشناس</Link>}
  </section>;
}

export function ExpertBlock({ app }: { app: Application }) {
  const expert = app.salesExpert;
  if (!expert) return <section className="nfp-card" id="nfp-expert" aria-labelledby="nfp-ex" data-testid="panel-expert-handoff"><h2 id="nfp-ex">کارشناس پرونده</h2>
    <div className="nfp-exp" style={{ marginTop: 8 }}><span className="nfp-av"><I icon={UserRound} /></span><div><b data-testid="text-sales-expert-name">هنوز کارشناسی تعیین نشده</b><small>به‌زودی معرفی می‌شود. تا آن زمان در گفتگو پیام بدهید.</small></div></div>
    <Link className="nf-btn nf-btn--secondary nf-btn--block" style={{ marginTop: 12 }} href={CHAT_HREF}><I icon={MessageSquare} small />گفتگو با پشتیبانی</Link></section>;
  return <section className="nfp-card" id="nfp-expert" aria-labelledby="nfp-ex" data-testid="panel-expert-handoff"><h2 id="nfp-ex">کارشناس پرونده</h2>
    <div className="nfp-exp" style={{ marginTop: 8 }}><span className="nfp-av" aria-hidden="true">{initials(expert.name)}</span><div><b data-testid="text-sales-expert-name">{expert.name}</b></div></div>
    <div className="nfp-two"><ExpertPickerButton className="nf-btn nfp-call" label="تماس" ariaLabel="تماس با کارشناس" testId="button-expert-call" assigned={app.salesExpert} caseNo={app.id} />
      <ExpertPickerButton channel="whatsapp" className="nf-btn nf-btn--secondary nfp-wa" label="واتساپ" ariaLabel="پیام واتساپ به کارشناس" testId="button-expert-whatsapp" assigned={app.salesExpert} caseNo={app.id} /></div>
    <Link className="nf-btn nf-btn--secondary nf-btn--block" style={{ marginTop: 8 }} href={CHAT_HREF}><I icon={MessageSquare} small />گفتگو در پنل</Link></section>;
}

/** Mobile-only sticky bar on the detail page; repeats the primary action of the «مرحله‌ی بعدی» card. */
export function ActionBar({ app }: { app: Application }) {
  const term = terminalOf(app.status); const s = stageCopy(app.stage);
  let body: ReactNode;
  if (term) body = <Link className="nf-btn nf-btn--primary nf-btn--block" href={CHAT_HREF}><I icon={MessageSquare} small />گفتگو با کارشناس</Link>;
  else if (s.cta === 'sign') body = <><EmzameLink label="امضا در امضامی" className="nf-btn nf-btn--primary nf-btn--block" /><small>مرحله‌ی بعدی: {s.title}</small></>;
  else if (s.cta === 'docs') body = <><Link className="nf-btn nf-btn--primary nf-btn--block" href={CHAT_HREF}><I icon={Upload} small />ارسال مدارک در گفتگو</Link><small>مرحله‌ی بعدی: {s.title}</small></>;
  else if (s.cta === 'call') body = <><ExpertPickerButton className="nf-btn nf-btn--primary nf-btn--block nfp-call" label="تماس با کارشناس" testId="button-actbar-expert" assigned={app.salesExpert} caseNo={app.id} /><small>مرحله‌ی بعدی: {s.title}</small></>;
  else body = <><Link className="nf-btn nf-btn--secondary nf-btn--block" href={CHAT_HREF}><I icon={MessageSquare} small />سؤال دارم</Link><small>{s.turn === 'done' ? 'پرونده تکمیل شد' : s.turn === 'you' ? `مرحله‌ی بعدی: ${s.title}` : 'مرحله‌ی بعدی با نفیس وام است؛ کاری لازم نیست'}</small></>;
  return <div className="nfp-actbar" data-testid="bar-detail-action">{body}</div>;
}

export { I as Icon, Sep };
