import { Link } from 'wouter';
import { ShieldCheck } from 'lucide-react';
import type { Profile } from './api';

const statusText: Record<string, string> = { verified: 'تأیید شده', pending: 'در انتظار نتیجه', failed: 'ناموفق' };
export function ProfilePage({ profile }: { profile: Profile }) {
  const rows: Array<[string, string | null | undefined, string]> = [
    ['نام', profile.firstName, 'first-name'], ['نام خانوادگی', profile.lastName, 'last-name'], ['نام پدر', profile.fatherName, 'father'],
    ['کد ملی', profile.nationalCode, 'national'], ['تاریخ تولد', profile.birthDateJalali, 'birth'],
    ['کد پستی', profile.postalCode, 'postal'], ['شماره همراه', profile.mobile, 'mobile'],
  ];
  return <>
    <div className="cp-pagehead"><div><p className="cp-eyebrow">حساب شخصی</p><h1 className="cp-title">پروفایل</h1></div>
      <span className="cp-kicker" data-testid="status-verification"><ShieldCheck size={14} /> تأیید کامل: {statusText[profile.verificationStatus] || 'تکمیل نشده'}</span></div>
    <section className="cp-card"><p className="cp-kicker"><ShieldCheck size={14} /> هویت و مالکیت شماره همراه تأیید شده است</p><dl className="cp-dl">{rows.map(([label, value, key]) => <div key={key}><dt>{label}</dt><dd data-testid={`text-profile-${key}`} dir={['first-name', 'last-name', 'father'].includes(key) ? undefined : 'ltr'}>{value || 'ثبت نشده'}</dd></div>)}</dl>
      {profile.verificationMessage && <div className="cp-alert cp-alert-info" role="status" style={{ marginTop: 16 }}>{profile.verificationMessage}</div>}
      {profile.verificationStatus !== 'verified' && <p className="cp-hint" style={{ marginTop: 16 }}>تأیید کامل (کد پستی و استعلام رسمی) از بخش درخواست تسهیلات انجام می‌شود. <Link href="/customer/apply" className="cp-link" data-testid="link-profile-verify">رفتن به درخواست ←</Link></p>}
    </section></>;
}
