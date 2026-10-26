import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, FlaskConical, KeyRound, MousePointerClick, Power, ShieldAlert, Trash2 } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { toast } from '@/hooks/use-toast';
import { AssistantAvatar } from '@/features/assistant/AssistantAvatar';
import { asFetch, asWhen, faNum, type AsKind } from '@/features/assistant/api';
import { ManagerPanel } from '@/features/assistant/ManagerPanel';
import '@/features/assistant/assistant.css';

type Tok = { id: number; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Adm = { id: number; slug: string; name: string; label: string; kind: AsKind; boundRole: string | null; boundUser: { id: number; name: string } | null; enabled: boolean; maxMessagesPerHour: number; online: boolean; lastSeenAt: string | null; tokens: Tok[] };
type AdminData = { globalEnabled: boolean; creditInquiryPermission: 'manager' | 'expert'; managerAccess?: boolean; assistants: Adm[] };
type AuditItem = { id: number; at: string; assistantId: number | null; actor: string | null; action: string; customerId: number | null; outcome: string };

const KEY = ['admin-assistants'];
type Reporting = { excludeTestCustomers: boolean; pageUsageEnabled: boolean };

/** v10: reporting switches — test customers out of the manager reports (default ON) + the page-usage tracker (default ON). Admin only; user 29 gets 403 and sees nothing. */
function ReportingPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-assistant-reporting'], queryFn: () => asFetch<Reporting>('/admin/assistants/reporting-settings'), retry: false });
  const [busy, setBusy] = useState(false);
  if (q.isError) return null;
  const d = q.data;
  const set = async (body: Partial<Reporting>, msg: string) => {
    if (busy) return; setBusy(true);
    try { const r = await asFetch<Reporting>('/admin/assistants/reporting-settings', { method: 'PUT', body }); qc.setQueryData(['admin-assistant-reporting'], r); toast({ title: msg }); }
    catch (e) { toast({ title: (e as Error).message }); } finally { setBusy(false); }
  };
  const row = (icon: ReactNode, title: string, help: string, on: boolean | undefined, testid: string, flip: () => void) =>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 0' }}>
      {icon}
      <div style={{ flex: 1, minWidth: 200 }}><b>{title}</b><div style={{ color: 'var(--nf-ink-muted)', fontSize: 13 }}>{help}</div></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minHeight: 44 }}>
        <input type="checkbox" checked={Boolean(on)} disabled={busy || on === undefined} onChange={flip} data-testid={testid} style={{ width: 20, height: 20 }} />
        {on === undefined ? '…' : on ? 'روشن' : 'خاموش'}
      </label>
    </div>;
  return <div className="panel" data-testid="panel-assistant-reporting">
    <h3 style={{ marginTop: 0 }}>گزارش‌ها</h3>
    {row(<FlaskConical size={20} />, 'حذف مشتری‌های تستی از گزارش‌ها', 'مشتری‌هایی که نامشان با TEST یا «تست» شروع می‌شود (یا [TEST] در توضیحاتشان است) در گزارش مدیر فروش، هشدارها و آمار دستیارها شمرده نمی‌شوند. فقط در گزارش؛ خود مشتری تغییری نمی‌کند.',
      d?.excludeTestCustomers, 'toggle-exclude-test-customers', () => void set({ excludeTestCustomers: !d?.excludeTestCustomers }, d?.excludeTestCustomers ? 'مشتری‌های تستی دوباره شمرده می‌شوند' : 'مشتری‌های تستی از گزارش‌ها حذف شدند'))}
    {row(<MousePointerClick size={20} />, 'ثبت استفاده از صفحه‌ها', 'فقط نوع صفحه (بدون شماره‌ی مشتری)، زمان ورود، مدت فعال بودن تب، کلیک منو و راه ورود ثبت می‌شود؛ هیچ اطلاعات مشتری یا شماره‌ای ثبت نمی‌شود. نگهداری ۹۰ روز.',
      d?.pageUsageEnabled, 'toggle-page-usage', () => void set({ pageUsageEnabled: !d?.pageUsageEnabled }, d?.pageUsageEnabled ? 'ثبت استفاده خاموش شد' : 'ثبت استفاده روشن شد'))}
  </div>;
}
const OUTCOME: Record<string, string> = { ok: 'انجام شد', forbidden: 'رد شد (مجاز نیست)', not_in_scope: 'رد شد (خارج از دسترسی)', banned_word: 'رد شد (واژه‌ی ممنوع)', rate_limited: 'سقف پیام', disabled: 'خاموش بود', bad_token: 'توکن نامعتبر' };
async function copy(s: string) { try { await navigator.clipboard.writeText(s); return true; } catch { return false; } }

export default function AssistantsSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => asFetch<AdminData>('/admin/assistants'), refetchInterval: 30_000 });
  const audit = useQuery({ queryKey: ['admin-assistant-audit'], queryFn: () => asFetch<{ items: AuditItem[] }>('/admin/assistant-audit?limit=50'), refetchInterval: 60_000 });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ a: Adm; token: string } | null>(null);
  const [revoke, setRevoke] = useState<{ a: Adm; t: Tok } | null>(null);
  const [confirmGlobal, setConfirmGlobal] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    if (busy) return; setBusy(true);
    try { await fn(); if (ok) toast({ title: ok }); await qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ['admin-assistant-audit'] }); void qc.invalidateQueries({ queryKey: ['assistant-mine'] }); }
    catch (e) { toast({ title: (e as Error).message }); } finally { setBusy(false); }
  };
  const d = q.data;
  const names = new Map((d?.assistants ?? []).map(a => [a.id, a.name]));

  return <section className="data-page" data-testid="page-assistants-settings">
    <div className="page-intro"><div><div className="eyebrow">مرحله‌ی ۱ · فقط پیشنهاد و گفتگو</div><h2>دستیارهای هوشمند</h2>
      <p>دستیارها فقط می‌خوانند، پیشنهاد می‌دهند و با کارشناس گفتگو می‌کنند. هیچ پیامی خودکار برای مشتری فرستاده نمی‌شود و یادآور فقط با کلیک خود کارشناس ثبت می‌شود. اولویت، تخصیص و اطلاعات مالی برای دستیارها بسته است.</p></div></div>
    {q.isLoading ? <SkeletonPanel rows={4} /> : q.isError || !d ? <ErrorState onRetry={() => q.refetch()} /> : <>
      <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderColor: d.globalEnabled ? '#CDE9D8' : '#F3D4D4' }} data-testid="panel-assistants-global">
        <Power size={22} color={d.globalEnabled ? '#1F7A4D' : '#B42318'} />
        <div style={{ flex: 1, minWidth: 200 }}><b>کلید اصلی دستیارها: {d.globalEnabled ? 'روشن' : 'خاموش'}</b>
          <div style={{ color: 'var(--nf-ink-muted)', fontSize: 13 }}>خاموش کردن، همه‌ی دستیارها را فوراً قطع می‌کند (اتصال‌ها ۴۲۳ می‌گیرند و چیزی برای کارشناس نمایش داده نمی‌شود). تنظیمات اعلان و تیم فروش تغییری نمی‌کند.</div></div>
        <button type="button" className={`btn ${d.globalEnabled ? '' : 'btn-primary'}`} disabled={busy} onClick={() => d.globalEnabled ? setConfirmGlobal(true) : void run(() => asFetch('/admin/assistants/global', { method: 'PUT', body: { enabled: true } }), 'کلید اصلی روشن شد')} data-testid="button-assistants-global">{d.globalEnabled ? 'خاموش کردن همه' : 'روشن کردن'}</button>
      </div>

      <div className="panel" data-testid="panel-credit-inquiry">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <ShieldAlert size={20} />
          <div style={{ flex: 1, minWidth: 200 }}><b>اجازه‌ی استعلام</b><div style={{ color: 'var(--nf-ink-muted)', fontSize: 13 }}>چه کسی اجازه‌ی استعلام اعتباری در ثبت هوشمند را می‌دهد. پیش‌فرض: مدیر. «تأیید ارسال» در هر حال با مدیر است.</div></div>
          <div role="radiogroup" aria-label="اجازه‌ی استعلام" style={{ display: 'flex', gap: 6 }}>
            {(['manager', 'expert'] as const).map(v => <button key={v} type="button" role="radio" aria-checked={d.creditInquiryPermission === v} className={`btn ${d.creditInquiryPermission === v ? 'btn-primary' : ''}`} disabled={busy}
              onClick={() => d.creditInquiryPermission !== v && void run(() => asFetch('/admin/assistants/settings', { method: 'PUT', body: { creditInquiryPermission: v } }), 'ذخیره شد')} data-testid={`button-credit-${v}`}>{v === 'manager' ? 'مدیر' : 'کارشناس'}</button>)}
          </div>
        </div>
      </div>

      {d.managerAccess !== false ? <ReportingPanel /> : null}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {d.assistants.map(a => {
          const live = a.tokens.filter(t => !t.revokedAt);
          const status = !d.globalEnabled || !a.enabled ? { c: '#9CA3AF', t: 'خاموش' } : a.online ? { c: '#16A34A', t: 'وصل' } : { c: '#F59E0B', t: 'وصل نیست' };
          return <div key={a.id} className="panel" data-testid={`panel-assistant-${a.slug}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AssistantAvatar slug={a.slug} kind={a.kind} state={a.enabled && d.globalEnabled ? 'idle' : 'off'} size={44} />
              <div style={{ flex: 1 }}><b>{a.label}</b>
                <div style={{ fontSize: 13, color: 'var(--nf-ink-muted)' }}>{a.kind === 'manager' ? 'مدیر فروش — فقط مدیر (admin) · فقط خواندن گزارش کارشناس‌ها و کارآموزها' : a.kind === 'filing' ? 'نقش ثبت (کارشناس ثبت، مدیر و کارشناس فروش همان پرونده)' : `کارشناس: ${a.boundUser?.name ?? '—'}`}</div>
                <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: '50%', background: status.c, display: 'inline-block' }} />{status.t}{a.lastSeenAt ? ` · آخرین اتصال ${asWhen(a.lastSeenAt)}` : ''}</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={a.enabled} disabled={busy} onChange={() => void run(() => asFetch(`/admin/assistants/${a.id}/${a.enabled ? 'disable' : 'enable'}`, { method: 'POST' }), a.enabled ? `${a.name} خاموش شد` : `${a.name} روشن شد`)} data-testid={`toggle-assistant-${a.slug}`} />
                {a.enabled ? 'روشن' : 'خاموش'}
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>سقف پیام عادی در ساعت:</span>
              <select value={a.maxMessagesPerHour} disabled={busy} onChange={e => void run(() => asFetch(`/admin/assistants/${a.id}`, { method: 'PUT', body: { maxMessagesPerHour: Number(e.target.value) } }), 'ذخیره شد')} data-testid={`select-limit-${a.slug}`}>
                {[2, 4, 6, 8, 10, 15, 20, 30].concat([a.maxMessagesPerHour]).filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y).map(v => <option key={v} value={v}>{faNum(v)}</option>)}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><KeyRound size={16} /><b style={{ fontSize: 14 }}>توکن اتصال</b><span style={{ flex: 1 }} />
                <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const r = await asFetch<{ token: string }>(`/admin/assistants/${a.id}/tokens`, { method: 'POST', body: { name: `${a.slug}-runner` } }); setIssued({ a, token: r.token }); })} data-testid={`button-token-issue-${a.slug}`}>صدور توکن</button></div>
              {live.length ? <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
                {live.map(t => <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <code dir="ltr">{t.name} · nva_{a.slug}_••••••</code><span style={{ color: 'var(--nf-ink-muted)' }}>{t.lastUsedAt ? `استفاده: ${asWhen(t.lastUsedAt)}` : 'هنوز استفاده نشده'}</span><span style={{ flex: 1 }} />
                  <button type="button" className="btn" onClick={() => setRevoke({ a, t })} aria-label="ابطال توکن" data-testid={`button-token-revoke-${t.id}`}><Trash2 size={15} /> ابطال</button>
                </li>)}
              </ul> : <div style={{ fontSize: 13, color: 'var(--nf-ink-muted)', marginTop: 6 }}>توکن فعالی ندارد.</div>}
            </div>
          </div>;
        })}
      </div>

      {d.managerAccess !== false && d.assistants.some(a => a.kind === 'manager') ? <ManagerPanel /> : null}

      <div className="panel" data-testid="panel-assistant-audit">
        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Bot size={18} /> گزارش کارهای دستیارها</h3>
        {audit.isLoading ? <SkeletonPanel rows={3} /> : audit.isError ? <ErrorState onRetry={() => audit.refetch()} /> : !audit.data?.items.length ? <div style={{ color: 'var(--nf-ink-muted)' }}>هنوز چیزی ثبت نشده.</div> :
          <div style={{ overflowX: 'auto' }}><table className="data-table" style={{ width: '100%' }}>
            <thead><tr><th>زمان</th><th>انجام‌دهنده</th><th>دستیار</th><th>کار</th><th>مشتری</th><th>نتیجه</th></tr></thead>
            <tbody>{audit.data.items.map(x => <tr key={x.id}><td>{asWhen(x.at)}</td><td>{x.actor ?? '—'}</td><td>{x.assistantId ? names.get(x.assistantId) ?? x.assistantId : '—'}</td><td dir="ltr" style={{ textAlign: 'right' }}>{x.action}</td><td>{x.customerId ? faNum(x.customerId) : '—'}</td><td>{OUTCOME[x.outcome] ?? x.outcome}</td></tr>)}</tbody>
          </table></div>}
      </div>
    </>}

    {issued ? <Modal title={`توکن ${issued.a.label}`} eyebrow="فقط همین یک بار نمایش داده می‌شود" onClose={() => setIssued(null)} testId="assistant-token">
      <p>این توکن را همین حالا کپی کنید و فقط در تنظیمات همان دستیار بگذارید. بعد از بستن این پنجره دیگر نمایش داده نمی‌شود.</p>
      <code dir="ltr" style={{ display: 'block', wordBreak: 'break-all', padding: 10, background: '#F7F8FC', borderRadius: 8 }} data-testid="text-issued-token">{issued.token}</code>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => void copy(issued.token).then(ok => toast({ title: ok ? 'کپی شد' : 'کپی نشد؛ دستی انتخاب کنید.' }))}><Copy size={15} /> کپی</button>
        <button type="button" className="btn" onClick={() => setIssued(null)}>بستم</button>
      </div>
    </Modal> : null}
    {revoke ? <Modal title="ابطال توکن" onClose={() => setRevoke(null)} testId="assistant-revoke">
      <p>اتصال دستیار فوراً قطع می‌شود. ({revoke.a.label} · {revoke.t.name})</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" style={{ background: '#B42318', borderColor: '#B42318' }} disabled={busy} onClick={() => void run(() => asFetch(`/admin/assistant-tokens/${revoke.t.id}/revoke`, { method: 'POST' }), 'توکن باطل شد').then(() => setRevoke(null))} data-testid="button-confirm-revoke">ابطال</button>
        <button type="button" className="btn" onClick={() => setRevoke(null)}>انصراف</button>
      </div>
    </Modal> : null}
    {confirmGlobal ? <Modal title="خاموش کردن همه‌ی دستیارها" onClose={() => setConfirmGlobal(false)} testId="assistant-global-off">
      <p>همه‌ی دستیارها فوراً قطع می‌شوند و دیگر برای هیچ کارشناسی نمایش داده نمی‌شوند.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" style={{ background: '#B42318', borderColor: '#B42318' }} disabled={busy} onClick={() => void run(() => asFetch('/admin/assistants/global', { method: 'PUT', body: { enabled: false } }), 'همه‌ی دستیارها خاموش شدند').then(() => setConfirmGlobal(false))} data-testid="button-confirm-global-off">خاموش کن</button>
        <button type="button" className="btn" onClick={() => setConfirmGlobal(false)}>انصراف</button>
      </div>
    </Modal> : null}
  </section>;
}
