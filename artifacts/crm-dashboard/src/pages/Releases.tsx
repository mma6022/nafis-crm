import { useState, FormEvent, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Server, AlertTriangle, CheckCircle2, RotateCcw, RefreshCw, Info, Globe, Database, OctagonAlert } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { mapOperation, releaseGate, paginate, ridToTehran, crmRefetchMs, type OperationView } from '@/lib/releases-model';
import './releases.css';

// Release 84(A): «نسخه‌ها» = two admin-only tabs.
//  * «نسخه‌های سایت»: read-only registry (GET /api/site-releases). No rollback button; manual by the developer.
//  * «نسخه‌های CRM»: the installed release manager (GET /api/releases, POST /api/releases/activate, unchanged)
//    + CRM metadata (GET /api/crm-release-meta). Rollback older than the last schema change is disabled.

type Tab = 'site' | 'crm';

type Release = { id: string; version: string; active: boolean; ready: boolean; source: 'installed' | 'uploaded' };
type Operation = { target?: string; status?: string; error?: string; updatedAt?: string };
type ReleasesResponse = { available: boolean; reason?: string; current: string | null; latest: string | null; updatesAvailable: boolean; releases: Release[]; operation?: Operation | null };
type CrmMetaEntry = { commit: string | null; branch: string | null; description: string | null; schemaChange: string | null };
type CrmMeta = { available: boolean; reason?: string; schemaCutoff: string | null; cutoffSource?: string; releases: Record<string, CrmMetaEntry> };
type SiteRelease = { rid: string; commit: string | null; branch: string | null; description: string | null; rollback: string | null; notes: string | null; tehran: string | null; current: boolean; onDisk: boolean | null };
type SiteResponse = { available: boolean; reason?: string; current?: string | null; releases?: SiteRelease[]; invalidRows?: number };

const SITE_PAGE = 10;
const CRM_PAGE = 15;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401 || res.status === 403) throw new Error('شما دسترسی لازم برای مشاهده این بخش را ندارید.');
  if (!res.ok) throw new Error('خطا در دریافت وضعیت نسخه‌ها. لطفاً دوباره تلاش کنید.');
  return res.json();
}

function When({ rid }: { rid: string }) {
  const t = ridToTehran(rid);
  if (!t) return <div className="rel-when"><b>—</b></div>;
  return (
    <div className="rel-when" title={`${t.iso} به وقت تهران`}>
      <b>{t.time}</b>
      <span>{t.date}</span>
      <small>به وقت تهران</small>
    </div>
  );
}

function Pager({ page, pages, total, onPage, label }: { page: number; pages: number; total: number; onPage: (p: number) => void; label: string }) {
  if (pages <= 1) return <div className="rel-pager"><span>{total.toLocaleString('fa-IR')} {label}</span></div>;
  return (
    <div className="rel-pager">
      <span>{total.toLocaleString('fa-IR')} {label} · صفحه‌ی {page.toLocaleString('fa-IR')} از {pages.toLocaleString('fa-IR')}</span>
      <div className="pagination-actions">
        <button type="button" className="page-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} data-testid="rel-page-prev">قبلی</button>
        <button type="button" className="page-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} data-testid="rel-page-next">بعدی</button>
      </div>
    </div>
  );
}

function OpBanner({ view }: { view: OperationView }) {
  if (view.kind === 'none') return null;
  const tone = view.kind === 'running' ? 'warn' : view.kind === 'success' ? 'ok' : 'err';
  const Icon = view.kind === 'running' ? RefreshCw : view.kind === 'success' ? CheckCircle2 : view.kind === 'manual_recovery' ? OctagonAlert : AlertTriangle;
  return (
    <div className={`rel-note ${tone}`} role={tone === 'err' ? 'alert' : 'status'} data-testid={`rel-op-${view.kind}`}>
      <Icon size={22} className={view.kind === 'running' ? 'animate-spin' : ''} aria-hidden />
      <div><strong>{view.title}</strong><p>{view.message}</p></div>
    </div>
  );
}

function SiteTab() {
  const [page, setPage] = useState(1);
  const q = useQuery<SiteResponse, Error>({ queryKey: ['site-releases'], queryFn: () => getJson<SiteResponse>('/api/site-releases'), staleTime: 60_000 });
  const note = (
    <div className="rel-note info" data-testid="site-manual-note">
      <Info size={22} aria-hidden />
      <div>
        <strong>بازگردانی سایت از این صفحه انجام نمی‌شود</strong>
        <p>این فهرست فقط برای دیدن است. بازگردانی نسخه‌ی سایت را توسعه‌دهنده به‌صورت دستی و با «مسیر بازگردانی» هر ردیف انجام می‌دهد.</p>
      </div>
    </div>
  );
  if (q.isLoading) return <>{note}<SkeletonPanel rows={6} /></>;
  if (q.isError) return <>{note}<ErrorState onRetry={() => q.refetch()} /></>;
  const d = q.data;
  if (!d?.available) {
    return (
      <>{note}
        <div className="panel" style={{ textAlign: 'center', padding: '48px 20px' }} data-testid="site-registry-unavailable">
          <Globe size={44} style={{ color: '#94a3b8', margin: '0 auto 14px' }} aria-hidden />
          <h3 style={{ fontSize: 17, color: '#334155', marginBottom: 8 }}>فهرست نسخه‌های سایت در دسترس نیست</h3>
          <p style={{ color: '#64748b', maxWidth: 420, margin: '0 auto', lineHeight: 1.8 }}>فایل ثبت نسخه‌های سایت روی سرور پیدا یا خوانده نشد ({d?.reason ?? 'نامشخص'}).</p>
        </div>
      </>
    );
  }
  const all = d.releases ?? [];
  const pg = paginate(all, page, SITE_PAGE);
  return (
    <>{note}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>نسخه‌های سایت</h3>
            <p>نسخه‌ی فعلی: <span className="rel-mono">{d.current ?? '—'}</span></p>
          </div>
          <button className="btn btn-ghost" onClick={() => q.refetch()} disabled={q.isRefetching} style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-testid="site-refresh">
            <RefreshCw size={16} className={q.isRefetching ? 'animate-spin' : ''} aria-hidden /> به‌روزرسانی
          </button>
        </div>
        {all.length === 0 ? <div className="empty-state compact">هیچ نسخه‌ای ثبت نشده.</div> : (
          <div className="rel-list" data-testid="site-release-list">
            {pg.rows.map((r) => (
              <div className={`rel-row${r.current ? ' is-current' : ''}`} key={r.rid} data-testid={`site-release-${r.rid}`}>
                <When rid={r.rid} />
                <div className="rel-main">
                  <span className="rel-desc">{r.description ?? '—'}</span>
                  <div className="rel-meta">
                    <span className="rel-chip">RID <span className="rel-mono">{r.rid}</span></span>
                    <span className="rel-chip">کامیت <span className="rel-mono">{r.commit ?? 'نامشخص'}</span></span>
                    <span className="rel-chip">شاخه <span className="rel-mono">{r.branch ?? 'نامشخص'}</span></span>
                  </div>
                  {r.notes ? <span className="rel-why">{r.notes}</span> : null}
                  {r.rollback ? (
                    <details className="rel-rollback">
                      <summary>مسیر بازگردانی (دستی)</summary>
                      <code>{r.rollback}</code>
                    </details>
                  ) : null}
                </div>
                <div className="rel-actions">
                  {r.current ? <span className="rel-badge current">نسخه‌ی فعلی</span> : null}
                  {r.onDisk === false ? <span className="rel-badge missing">روی سرور نیست</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
        <Pager page={pg.page} pages={pg.pages} total={pg.total} onPage={setPage} label="نسخه" />
      </div>
    </>
  );
}

function CrmTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Release | null>(null);
  const [confirmVersion, setConfirmVersion] = useState('');
  const [activationError, setActivationError] = useState('');

  const releasesQuery = useQuery<ReleasesResponse, Error>({
    queryKey: ['releases'],
    queryFn: () => getJson<ReleasesResponse>('/api/releases'),
    refetchInterval: (query) => crmRefetchMs(mapOperation(query.state.data?.operation).kind),
    refetchIntervalInBackground: false,
  });
  const metaQuery = useQuery<CrmMeta, Error>({ queryKey: ['crm-release-meta'], queryFn: () => getJson<CrmMeta>('/api/crm-release-meta'), staleTime: 5 * 60_000 });

  const activateMutation = useMutation<void, Error, { id: string }>({
    mutationFn: async ({ id }) => {
      const res = await fetch('/api/releases/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
      if (!res.ok && res.status !== 202) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'خطا در اعمال نسخه. لطفاً لاگ‌های سیستم را بررسی کنید.');
      }
    },
    onSuccess: () => {
      setActivationError('');
      setSelected(null);
      setConfirmVersion('');
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (err) => {
      setActivationError(err.message);
    }
  });

  const data = releasesQuery.data;
  const meta = metaQuery.data;
  const cutoff = meta?.available ? meta.schemaCutoff : null;
  const op = mapOperation(data?.operation);
  const sorted = useMemo(() => [...(data?.releases ?? [])].sort((a, b) => b.version.localeCompare(a.version) || b.id.localeCompare(a.id)), [data?.releases]);
  const gateFor = (r: Release) => releaseGate({ version: r.version, current: data?.current ?? null, cutoff, ready: r.ready, busy: op.blocksActions || activateMutation.isPending });

  const close = () => { setSelected(null); setActivationError(''); setConfirmVersion(''); };
  const handleActivate = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (!gateFor(selected).allowed) { setActivationError('این تغییر نسخه مجاز نیست.'); return; }
    if (confirmVersion !== selected.version) { setActivationError('شماره نسخه وارد شده تطابق ندارد.'); return; }
    activateMutation.mutate({ id: selected.id });
  };

  if (releasesQuery.isLoading) return <SkeletonPanel rows={6} />;
  if (releasesQuery.isError) return <ErrorState onRetry={() => releasesQuery.refetch()} />;
  if (!data || !data.available) {
    return (
      <div className="panel" style={{ textAlign: 'center', padding: '60px 20px' }}>
        <Server size={48} style={{ color: '#94a3b8', margin: '0 auto 16px' }} aria-hidden />
        <h3 style={{ fontSize: 18, color: '#334155', marginBottom: 8 }}>سیستم مدیریت نسخه‌ی CRM فعال نیست</h3>
        <p style={{ color: '#64748b', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>{data?.reason || 'این قابلیت فقط روی سرور عملیاتی و با سرویس مستقل انتشار در دسترس است.'}</p>
      </div>
    );
  }

  const pg = paginate(sorted, page, CRM_PAGE);
  const cutT = cutoff ? ridToTehran(cutoff) : null;
  const curT = data.current ? ridToTehran(data.current) : null;
  const selGate = selected ? gateFor(selected) : null;

  return (
    <>
      <OpBanner view={op} />
      {data.updatesAvailable && !op.blocksActions ? (
        <div className="rel-note info"><Info size={22} aria-hidden /><div><strong>نسخه‌ی جدیدتر نصب شده است</strong>
          <p>نسخه‌ی <span className="rel-mono">{data.latest}</span> روی سرور آماده‌ی استقرار است. دانلود و نشر خودکار انجام نمی‌شود.</p></div></div>
      ) : null}
      <div className={`rel-note ${cutoff ? 'warn' : 'err'}`} data-testid="crm-schema-cutoff">
        <Database size={22} aria-hidden />
        <div>
          <strong>{cutoff ? 'بازگردانی به قبل از آخرین تغییر ساختار دیتابیس بسته است' : 'آخرین تغییر ساختار دیتابیس معلوم نیست؛ همه‌ی بازگردانی‌ها بسته است'}</strong>
          <p>{cutoff
            ? <>آخرین تغییر ساختار: <span className="rel-mono">{cutoff}</span>{cutT ? ` (${cutT.date}، ساعت ${cutT.time} به وقت تهران)` : ''}. کد نسخه‌های قدیمی‌تر با دیتابیس فعلی سازگار نیست؛ بازگشت به آن‌ها فقط دستی و توسط توسعه‌دهنده انجام می‌شود.</>
            : 'فایل اطلاعات نسخه‌های CRM خوانده نشد. تا رفع آن، دکمه‌ی بازگردانی غیرفعال است.'}</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>نسخه‌های CRM</h3>
            <p>نسخه‌ی فعلی: <span className="rel-mono">{data.current ?? '—'}</span>{curT ? ` · ${curT.date}، ${curT.time} به وقت تهران` : ''}</p>
          </div>
          <button className="btn btn-ghost" onClick={() => releasesQuery.refetch()} disabled={releasesQuery.isRefetching} style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-testid="crm-refresh">
            <RefreshCw size={16} className={releasesQuery.isRefetching ? 'animate-spin' : ''} aria-hidden /> به‌روزرسانی
          </button>
        </div>
        {sorted.length === 0 ? <div className="empty-state compact">هیچ نسخه‌ای یافت نشد.</div> : (
          <div className="rel-list" data-testid="crm-release-list">
            {pg.rows.map((r) => {
              const m = meta?.releases?.[r.id] ?? meta?.releases?.[r.version] ?? null;
              const g = gateFor(r);
              const isCurrent = data.current === r.version;
              const isPending = op.kind === 'running' && data.operation?.target === r.id;
              return (
                <div className={`rel-row${isCurrent ? ' is-current' : ''}`} key={r.id} data-testid={`crm-release-${r.id}`}>
                  <When rid={r.version} />
                  <div className="rel-main">
                    <span className="rel-desc">{m?.description ?? 'بدون توضیح'}</span>
                    <div className="rel-meta">
                      <span className="rel-chip">RID <span className="rel-mono">{r.id}</span></span>
                      <span className="rel-chip">کامیت <span className="rel-mono">{m?.commit ?? 'نامشخص'}</span></span>
                      {m?.branch ? <span className="rel-chip">شاخه <span className="rel-mono">{m.branch}</span></span> : null}
                      {r.source === 'uploaded' ? <span className="rel-chip">آرشیو آپلودشده</span> : null}
                      {m?.schemaChange ? <span className="rel-badge schema" title={m.schemaChange}>تغییر ساختار دیتابیس</span> : null}
                    </div>
                  </div>
                  <div className="rel-actions">
                    {isCurrent ? <span className="rel-badge current">نسخه‌ی فعلی</span> : null}
                    {isPending ? <span className="rel-badge pending">در حال اعمال</span> : null}
                    {!r.ready ? <span className="rel-badge missing">نامعتبر</span> : null}
                    {g.action !== 'none' && r.ready ? (
                      <button
                        type="button"
                        className={`rel-btn${g.action === 'rollback' ? ' back' : ''}`}
                        aria-disabled={!g.allowed}
                        onClick={() => { if (g.allowed) setSelected(r); }}
                        data-testid={`crm-${g.action}-${r.id}`}
                      >
                        {g.action === 'rollback' ? <RotateCcw size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
                        {g.action === 'rollback' ? 'بازگردانی' : 'استقرار نسخه'}
                      </button>
                    ) : null}
                    {g.action !== 'none' && !g.allowed && r.ready ? <span className="rel-why">{g.reason}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Pager page={pg.page} pages={pg.pages} total={pg.total} onPage={setPage} label="نسخه" />
      </div>

      {selected && selGate ? (
        <Modal title={selGate.action === 'rollback' ? 'تأیید بازگردانی نسخه‌ی CRM' : 'تأیید استقرار نسخه‌ی CRM'} eyebrow="تغییر نسخه‌ی عملیاتی CRM" testId="release-activation-modal" onClose={close}>
          <form onSubmit={handleActivate}>
            <div className="rel-note warn">
              <AlertTriangle size={22} aria-hidden />
              <div>
                <strong>قطعی موقت CRM</strong>
                <p>این کار سرویس CRM را دوباره راه‌اندازی می‌کند. داده‌ها حفظ می‌شوند، اما تغییرات ساختاری دیتابیس برنمی‌گردند. سایت تغییری نمی‌کند.</p>
              </div>
            </div>
            <p style={{ marginBottom: 8, fontSize: 14, color: '#334155' }}>نسخه‌ی مقصد:</p>
            <div className="rel-mono" style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', padding: 12, background: '#f1f5f9', borderRadius: 6, border: '1px solid #e2e8f0', marginBottom: 20 }}>{selected.version}</div>
            <div className="field full">
              <label htmlFor="confirm-version" style={{ fontWeight: 700, color: '#334155' }}>برای تأیید، شماره نسخه‌ی بالا را دقیق وارد کنید:</label>
              <input id="confirm-version" dir="ltr" className="rel-mono" style={{ textAlign: 'center', fontSize: 16 }} value={confirmVersion} onChange={(e) => setConfirmVersion(e.target.value)} required autoComplete="off" />
            </div>
            {activationError ? <div className="profile-form-error" style={{ marginTop: 16 }}>{activationError}</div> : null}
            <div className="form-footer" style={{ marginTop: 28, display: 'flex', gap: 12 }}>
              <button className="btn" type="submit" style={{ backgroundColor: '#ea580c', color: '#fff', border: 'none', flex: 1, justifyContent: 'center', padding: 10, opacity: activateMutation.isPending || confirmVersion !== selected.version ? 0.6 : 1 }} disabled={activateMutation.isPending || confirmVersion !== selected.version || !selGate.allowed}>
                {activateMutation.isPending ? 'در حال ارسال درخواست...' : 'تأیید و اعمال'}
              </button>
              <button className="btn btn-ghost" type="button" style={{ flex: 1, justifyContent: 'center', padding: 10 }} onClick={close} disabled={activateMutation.isPending}>انصراف</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

export default function Releases() {
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tab') === 'crm' ? 'crm' : 'site'));
  const pick = (t: Tab) => {
    setTab(t);
    try { const u = new URL(window.location.href); u.searchParams.set('tab', t); window.history.replaceState(null, '', u.toString()); } catch { /* ignore */ }
  };
  const tabs: { k: Tab; l: string }[] = [{ k: 'site', l: 'نسخه‌های سایت' }, { k: 'crm', l: 'نسخه‌های CRM' }];
  return (
    <section className="data-page" data-testid="page-releases">
      <div className="page-intro">
        <div>
          <div className="eyebrow">مدیریت زیرساخت</div>
          <h2>نسخه‌ها</h2>
          <p>نسخه‌های منتشرشده‌ی سایت و CRM؛ همه‌ی زمان‌ها به وقت تهران</p>
        </div>
      </div>
      <div className="rel-tabs" role="tablist" aria-label="نوع نسخه">
        {tabs.map((t) => (
          <button key={t.k} type="button" role="tab" id={`rel-tab-${t.k}`} aria-controls={`rel-panel-${t.k}`} aria-selected={tab === t.k} tabIndex={tab === t.k ? 0 : -1}
            className={`rel-tab${tab === t.k ? ' active' : ''}`} onClick={() => pick(t.k)} data-testid={`tab-releases-${t.k}`}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const n: Tab = t.k === 'site' ? 'crm' : 'site'; pick(n); document.getElementById(`rel-tab-${n}`)?.focus(); } }}>
            {t.l}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`rel-panel-${tab}`} aria-labelledby={`rel-tab-${tab}`}>
        {tab === 'site' ? <SiteTab /> : <CrmTab />}
      </div>
    </section>
  );
}
