import type { Application } from './api';

/** Only the server-provided contact of the customer's current expert is shown. */
export function ExpertHandoff({ expert }: { expert: Application['salesExpert'] }) {
  return <section className="cp-card" data-testid="panel-expert-handoff">
    <h2>ادامه مراحل با کارشناس فروش</h2>
    <p>درخواست شما ثبت شده است. برای ادامه مراحل با کارشناس فروش خود در ارتباط باشید.
      تکمیل اطلاعات قرارداد و ارسال آن برای امضا را کارشناس انجام می‌دهد.
      روند پرونده را از بخش «درخواست‌های تسهیلات» پیگیری کنید.</p>
    <div className="cp-list">
      <div className="cp-list-item"><span>کارشناس فروش شما</span>
        <strong data-testid="text-sales-expert-name">{expert?.name || 'در انتظار تخصیص کارشناس'}</strong></div>
      <div className="cp-list-item"><span>موبایل کارشناس</span>
        {expert?.mobile
          ? <a className="cp-link" dir="ltr" href={`tel:${expert.mobile}`} data-testid="link-sales-expert-mobile">{expert.mobile}</a>
          : <span>شماره تماس ثبت نشده است؛ از گفت‌وگو با کارشناس استفاده کنید.</span>}
      </div>
    </div>
    <h3>ثبت‌نام، گواهی امضا و امضای قرارداد</h3>
    <p>برای ثبت‌نام در امضامی، دریافت گواهی امضای دیجیتال و امضای قرارداد، وارد سایت شوید.
      پس از آماده‌شدن گواهی، به کارشناس فروش اطلاع دهید.</p>
    <a href="https://web.emzame.ir/" target="_blank" rel="noopener noreferrer"
      className="cp-btn cp-btn-outline" data-testid="link-emzame">ورود به امضامی</a>
  </section>;
}
