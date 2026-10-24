import { Link } from 'wouter';
import type { CreditRankOverrideEntry } from '@workspace/api-client-react';
import { formatDateTime } from '@/components/CrmShell';

export const CREDIT_RANK_OVERRIDE_ACTION_LABELS: Record<CreditRankOverrideEntry['action'], string> = {
  preview_enabled: 'فعال‌سازی در ثبت درخواست',
  filing_fee_charged: 'پرداخت هزینه تشکیل پرونده',
  wallet_share_link: 'لینک شارژ کیف پول',
  case_created: 'ثبت پرونده',
  admin_plan_change: 'تغییر طرح توسط مدیر',
};

const ROLE_LABELS: Record<string, string> = { admin: 'مدیر', salesperson: 'کارشناس فروش', registrar: 'ثبات' };

/** Read-only list of «نادیده گرفتن رتبه» uses (admin only, no notifications). */
export function CreditRankOverrideRows({ items, showCase = true }: { items: CreditRankOverrideEntry[]; showCase?: boolean }) {
  return (
    <ul className="crx-list" data-testid="credit-rank-override-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {items.map((item) => (
        <li key={item.id} data-testid={`credit-rank-override-${item.id}`}
          style={{ border: '1px solid var(--line, #e4e7ec)', borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 13 }}>
            <strong>{CREDIT_RANK_OVERRIDE_ACTION_LABELS[item.action] ?? item.action}</strong>
            <span className="lwz-muted">{formatDateTime(item.createdAt)}</span>
            <span>{item.userName || `کاربر #${item.userId.toLocaleString('fa-IR', { useGrouping: false })}`}{item.userRole ? ` · ${ROLE_LABELS[item.userRole] ?? item.userRole}` : ''}</span>
            {showCase ? <>
              <Link href={`/customers/${item.customerId}`}>مشتری #{item.customerId.toLocaleString('fa-IR', { useGrouping: false })}</Link>
              {item.applicationId ? <Link href={`/loan-applications/${item.applicationId}`}>پرونده #{item.applicationId.toLocaleString('fa-IR', { useGrouping: false })}</Link> : <span className="lwz-muted">پیش از ثبت پرونده</span>}
            </> : null}
          </div>
          <p style={{ margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{item.reason}</p>
        </li>
      ))}
    </ul>
  );
}
