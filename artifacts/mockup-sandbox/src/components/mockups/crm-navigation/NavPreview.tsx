import { useState } from 'react';
import {
  BarChart3, Bell, Building2, Calculator, ChevronDown, ClipboardList,
  Coins, CreditCard, FileSignature, Instagram, Landmark, LayoutDashboard,
  MessageCircle, MessagesSquare, Phone, PhoneCall, Server, Settings,
  Shield, ShieldCheck, ShoppingBag, UsersRound, Wallet, type LucideIcon,
} from 'lucide-react';

type NavItem = { href: string; label: string; icon: LucideIcon };
const items: NavItem[] = [
  { href: '/', label: 'نمای کلی', icon: LayoutDashboard },
  { href: '/customers', label: 'مشتریان', icon: UsersRound },
  { href: '/chat', label: 'گفتگو با مشتریان', icon: MessagesSquare },
  { href: '/internal-chat', label: 'گفتگوی داخلی', icon: MessageCircle },
  { href: '/wallet-management', label: 'مدیریت کیف پول', icon: CreditCard },
  { href: '/reminders', label: 'یادآورها', icon: Bell },
  { href: '/calls', label: 'تماس‌ها', icon: PhoneCall },
  { href: '/mobile-calls', label: 'تماس‌های موبایل', icon: PhoneCall },
  { href: '/instagram-inbox', label: 'سرنخ‌های دایرکت اینستاگرام', icon: Instagram },
  { href: '/phone', label: 'تلفن شرکت', icon: Phone },
  { href: '/consultations', label: 'مشاوره‌ها', icon: ClipboardList },
  { href: '/loan-applications', label: 'درخواست‌های تسهیلات', icon: Landmark },
  { href: '/loan-plans', label: 'طرح‌های تسهیلاتی', icon: CreditCard },
  { href: '/goods-purchases', label: 'خرید کالا', icon: ShoppingBag },
  { href: '/payment-orders', label: 'دستورهای پرداخت', icon: Wallet },
  { href: '/bank-accounts', label: 'حساب‌های بانکی', icon: Building2 },
  { href: '/accounting', label: 'حسابداری', icon: Calculator },
  { href: '/sales-reports', label: 'گزارش فروش', icon: BarChart3 },
  { href: '/sales-commissions', label: 'پورسانت فروش', icon: Coins },
  { href: '/contracts', label: 'قراردادها', icon: FileSignature },
  { href: '/users', label: 'کاربران CRM', icon: Shield },
  { href: '/manual-verifications', label: 'بررسی دستی هویت', icon: ShieldCheck },
  { href: '/settings/notifications', label: 'تنظیمات', icon: Settings },
  { href: '/settings/releases', label: 'نسخه‌های سایت', icon: Server },
];
const groups = [
  { id: 'talk', label: 'گفتگوها', icon: MessagesSquare, hrefs: ['/chat', '/internal-chat', '/instagram-inbox'] },
  { id: 'work', label: 'کارهای روزانه', icon: PhoneCall, hrefs: ['/calls', '/mobile-calls', '/phone', '/reminders'] },
  { id: 'cases', label: 'پرونده‌ها', icon: Landmark, hrefs: ['/consultations', '/loan-applications', '/loan-plans', '/contracts'] },
  { id: 'finance', label: 'مالی', icon: Wallet, hrefs: ['/wallet-management', '/goods-purchases', '/payment-orders', '/bank-accounts', '/accounting', '/sales-commissions'] },
  { id: 'manage', label: 'گزارش و مدیریت', icon: Shield, hrefs: ['/sales-reports', '/users', '/manual-verifications', '/settings/notifications', '/settings/releases'] },
];
const currentRoute = '/internal-chat';
const messages = ['سلام، وضعیت پرونده را بررسی کردم.', 'مدارک تکمیلی آماده است؟', 'بله، امروز برای ثبت ارسال می‌شود.', 'ممنون، بعد از ثبت خبر می‌دهم.'];

export function NavPreview({ grouped }: { grouped: boolean }) {
  const [open, setOpen] = useState('talk');
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = item.href === currentRoute;
    return <div className={`crm-nav-item ${active ? 'active' : ''}`} key={item.href}>
      <Icon /><span>{item.label}</span>
      {item.href === '/internal-chat' && <b className="crm-nav-badge">۳</b>}
    </div>;
  };
  return <div className="crm-nav-preview" dir="rtl">
    <aside>
      <div className="crm-nav-brand"><i>ن</i><div><strong>گروه مالی نفیس</strong><small>پنل مدیریت مشتریان</small></div></div>
      <div className="crm-nav-label">فضای کاری</div>
      <nav className="crm-nav-links" aria-label="نمونهٔ منوی اصلی">
        {!grouped ? items.map(renderItem) : <>
          {items.slice(0, 2).map(renderItem)}
          {groups.map(group => {
            const Icon = group.icon;
            const opened = open === group.id;
            return <section className="crm-nav-group" key={group.id}>
              <button className="crm-nav-group-button" aria-expanded={opened} onClick={() => setOpen(opened ? '' : group.id)}>
                <Icon /><span>{group.label}</span><ChevronDown className="chevron" />
              </button>
              {opened && <div className="crm-nav-group-items">{items.filter(item => group.hrefs.includes(item.href)).map(renderItem)}</div>}
            </section>;
          })}
        </>}
      </nav>
      <div className="crm-nav-support">پشتیبانی تیم · سامانه در دسترس است</div>
    </aside>
    <main className="crm-nav-content">
      <header className="crm-nav-topbar"><h2>گفتگوی داخلی</h2><span>منو و صفحه جداگانه اسکرول می‌شوند</span></header>
      <section className="crm-nav-chat">
        <div className="crm-nav-threads">
          <div className="crm-nav-thread selected"><b>گروه فروش</b><span>آخرین پیام · ۱۰:۳۲</span></div>
          <div className="crm-nav-thread"><b>گروه پیگیری فروش</b><span>پرونده تا عصر ارسال شود</span></div>
          <div className="crm-nav-thread"><b>سارا احمدی</b><span>ممنون، بررسی می‌کنم</span></div>
          <div className="crm-nav-thread"><b>علی رضایی</b><span>مدرک کامل شد</span></div>
        </div>
        <div className="crm-nav-messages">
          <header>گروه فروش</header>
          <div className="crm-nav-message-list">{messages.map((message, index) => <div className={`crm-nav-message ${index % 2 ? 'mine' : ''}`} key={message}>{message}</div>)}</div>
          <div className="crm-nav-composer">نوشتن پیام…</div>
        </div>
      </section>
    </main>
  </div>;
}
