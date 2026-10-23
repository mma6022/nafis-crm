import { useState, FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Server, AlertTriangle, CheckCircle2, RotateCcw, RefreshCw, Info } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';

type Release = {
  id: string;
  version: string;
  active: boolean;
  ready: boolean;
  source: 'installed' | 'uploaded';
};

type Operation = {
  target: string;
  status: string;
  error?: string;
};

type ReleasesResponse = {
  available: boolean;
  reason?: string;
  current: string | null;
  latest: string | null;
  updatesAvailable: boolean;
  releases: Release[];
  operation?: Operation;
};

export default function Releases() {
  const queryClient = useQueryClient();
  const [selectedRelease, setSelectedRelease] = useState<Release | null>(null);
  const [confirmVersion, setConfirmVersion] = useState('');
  const [activationError, setActivationError] = useState('');

  const releasesQuery = useQuery<ReleasesResponse, Error>({
    queryKey: ['releases'],
    queryFn: async () => {
      const res = await fetch('/api/releases', { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        throw new Error('شما دسترسی لازم برای مشاهده این بخش را ندارید.');
      }
      if (!res.ok) {
        throw new Error('خطا در دریافت وضعیت نسخه‌ها. لطفاً دوباره تلاش کنید.');
      }
      return res.json();
    },
    refetchInterval: 5000,
  });

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
      setSelectedRelease(null);
      setConfirmVersion('');
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: (err) => {
      setActivationError(err.message);
    }
  });

  const handleActivate = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRelease) return;
    if (confirmVersion !== selectedRelease.version) {
      setActivationError('شماره نسخه وارد شده تطابق ندارد.');
      return;
    }
    activateMutation.mutate({ id: selectedRelease.id });
  };

  if (releasesQuery.isLoading) {
    return (
      <section className="data-page">
        <div className="page-intro">
          <div>
            <div className="eyebrow">مدیریت زیرساخت</div>
            <h2>نسخه‌های سایت</h2>
          </div>
        </div>
        <SkeletonPanel rows={6} />
      </section>
    );
  }

  if (releasesQuery.isError) {
    return (
      <section className="data-page">
        <div className="page-intro">
          <div>
            <div className="eyebrow">مدیریت زیرساخت</div>
            <h2>نسخه‌های سایت</h2>
          </div>
        </div>
        <ErrorState onRetry={() => releasesQuery.refetch()} />
      </section>
    );
  }

  const data = releasesQuery.data;

  if (!data || !data.available) {
    return (
      <section className="data-page">
        <div className="page-intro">
          <div>
            <div className="eyebrow">مدیریت زیرساخت</div>
            <h2>نسخه‌های سایت</h2>
            <p>مدیریت و استقرار نسخه‌های عملیاتی سیستم</p>
          </div>
        </div>
        <div className="panel" style={{ textAlign: 'center', padding: '60px 20px' }}>
          <Server size={48} style={{ color: '#94a3b8', margin: '0 auto 16px' }} />
          <h3 style={{ fontSize: '18px', color: '#334155', marginBottom: '8px' }}>سیستم مدیریت نسخه فعال نیست</h3>
          <p style={{ color: '#64748b', maxWidth: '400px', margin: '0 auto', lineHeight: '1.6' }}>
            {data?.reason || 'این قابلیت فقط در محیط عملیاتی (Production) و زمانی که سیستم از طریق فایل‌های فشرده مستقر شده باشد در دسترس است.'}
          </p>
        </div>
      </section>
    );
  }

  const isOperating = data.operation && data.operation.status === 'running';
  // Sorting releases: newest version first (descending alphanumeric sort is sufficient for these numeric IDs)
  const sortedReleases = [...data.releases].sort((a, b) => b.version.localeCompare(a.version));

  return (
    <section className="data-page">
      <div className="page-intro" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="eyebrow">مدیریت زیرساخت</div>
          <h2>نسخه‌های سایت</h2>
          <p>مشاهده و تغییر نسخه عملیاتی در حال اجرا</p>
        </div>
        <button 
          className="btn btn-ghost" 
          onClick={() => releasesQuery.refetch()} 
          disabled={releasesQuery.isRefetching}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={16} className={releasesQuery.isRefetching ? 'animate-spin' : ''} />
          به‌روزرسانی
        </button>
      </div>

      {data.updatesAvailable && !isOperating && (
        <div style={{ backgroundColor: '#eff6ff', color: '#1e40af', padding: '16px', borderRadius: '8px', border: '1px solid #bfdbfe', marginBottom: '24px', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <Info size={24} style={{ flexShrink: 0 }} />
          <div>
            <strong style={{ display: 'block', marginBottom: '4px' }}>نسخه جدیدتر در دسترس است</strong>
            <p style={{ margin: 0, fontSize: '13px' }}>
              نسخه <strong dir="ltr" className="inline-block font-mono mx-1">{data.latest}</strong> در سیستم نصب شده و آماده استقرار است. برای اعمال آن، از لیست زیر گزینه استقرار را انتخاب کنید. دانلود و نشر به صورت خودکار انجام نمی‌شود.
            </p>
          </div>
        </div>
      )}

      {isOperating && (
        <div style={{ backgroundColor: '#fef3c7', color: '#92400e', padding: '16px', borderRadius: '8px', border: '1px solid #fde68a', marginBottom: '24px', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <RefreshCw size={24} className="animate-spin" style={{ flexShrink: 0 }} />
          <div>
            <strong style={{ display: 'block', marginBottom: '4px' }}>در حال استقرار نسخه...</strong>
            <p style={{ margin: 0, fontSize: '13px' }}>
              عملیات تغییر نسخه در حال انجام است. سایت تا دقایقی دیگر با نسخه جدید در دسترس خواهد بود. لطفاً منتظر بمانید.
            </p>
          </div>
        </div>
      )}
      
      {data.operation?.status === 'failed' && (
        <div style={{ backgroundColor: '#fef2f2', color: '#b91c1c', padding: '16px', borderRadius: '8px', border: '1px solid #fecaca', marginBottom: '24px', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <AlertTriangle size={24} style={{ flexShrink: 0 }} />
          <div>
            <strong style={{ display: 'block', marginBottom: '4px' }}>خطا در استقرار نسخه قبلی</strong>
            <p style={{ margin: 0, fontSize: '13px' }}>
              {data.operation.error || 'عملیات استقرار با مشکل روبه‌رو شد و تغییرات اعمال نشدند.'}
            </p>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>لیست نسخه‌ها</h3>
            <p>نسخه فعلی و نسخه‌های آماده در سیستم</p>
          </div>
        </div>

        {sortedReleases.length === 0 ? (
           <div className="empty-state compact">هیچ نسخه‌ای یافت نشد.</div>
        ) : (
          <div className="notification-delivery-list">
            {sortedReleases.map((release) => {
              const isCurrent = data.current === release.version;
              const isPending = data.operation?.target === release.id && data.operation?.status === 'applying';
              const isFailed = data.operation?.target === release.id && data.operation?.status === 'failed';
              const isOlder = data.current ? release.version < data.current : false;

              return (
                <div className="notification-delivery-row" key={release.id} style={{ alignItems: 'center', padding: '16px' }}>
                  <span 
                    className={`delivery-status ${isCurrent ? 'sent' : isPending ? 'in_progress' : release.ready ? 'ready' : 'failed'}`} 
                    style={{ 
                      width: '90px', 
                      textAlign: 'center', 
                      backgroundColor: isCurrent ? '#10b981' : isPending ? '#3b82f6' : release.ready ? '#f1f5f9' : '#fee2e2', 
                      color: isCurrent ? 'white' : isPending ? 'white' : release.ready ? '#475569' : '#ef4444',
                      border: 'none',
                      fontWeight: isCurrent || isPending ? 'bold' : 'normal'
                    }}
                  >
                    {isCurrent ? 'نسخه فعلی' : isPending ? 'در حال اعمال' : release.ready ? 'آماده' : 'نامعتبر'}
                  </span>
                  
                  <div style={{ flex: 1, marginRight: '16px' }}>
                    <strong style={{ fontSize: '15px', fontFamily: 'monospace', letterSpacing: '1px' }} dir="ltr" className="inline-block">{release.version}</strong>
                    <span style={{ display: 'block', fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                      {release.source === 'installed' ? 'نصب شده در سیستم' : 'آرشیو آپلود شده'}
                      {isFailed ? <span style={{ color: '#ef4444', marginRight: '8px' }}> • عملیات با خطا مواجه شد</span> : null}
                    </span>
                  </div>
                  
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {!isCurrent && release.ready && !isOperating && (
                      <button
                        className="btn"
                        style={{ 
                          padding: '6px 14px', 
                          fontSize: '13px', 
                          backgroundColor: isOlder ? '#fffbeb' : '#eff6ff', 
                          color: isOlder ? '#b45309' : '#1d4ed8',
                          border: `1px solid ${isOlder ? '#fde68a' : '#bfdbfe'}`,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                        onClick={() => setSelectedRelease(release)}
                      >
                        {isOlder ? <RotateCcw size={14} /> : <CheckCircle2 size={14} />}
                        {isOlder ? 'بازگردانی' : 'استقرار نسخه'}
                      </button>
                    )}
                    {isPending && (
                      <span style={{ color: '#3b82f6', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        در حال استقرار...
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedRelease && (
        <Modal
          title="تأیید استقرار نسخه"
          eyebrow="تغییر نسخه عملیاتی سایت"
          testId="release-activation-modal"
          onClose={() => {
            setSelectedRelease(null);
            setActivationError('');
            setConfirmVersion('');
          }}
        >
          <form onSubmit={handleActivate}>
            <div style={{ backgroundColor: '#fffbeb', color: '#b45309', padding: '16px', borderRadius: '8px', border: '1px solid #fde68a', marginBottom: '24px' }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                <AlertTriangle style={{ flexShrink: 0 }} size={24} />
                <div>
                  <strong style={{ display: 'block', marginBottom: '6px', fontSize: '15px' }}>هشدار قطعی موقت و ریسک داده‌ها</strong>
                  <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.7 }}>
                    استقرار این نسخه باعث راه‌اندازی مجدد سرویس و <strong>قطعی موقت</strong> خواهد شد.
                    داده‌های فعلی حفظ می‌شوند، اما <strong>تغییرات ساختاری دیتابیس (Schema) بازگردانی نمی‌شوند</strong>.
                    لطفاً اطمینان حاصل کنید که این نسخه با ساختار فعلی دیتابیس سازگاری دارد.
                  </p>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <p style={{ marginBottom: '8px', fontSize: '14px', color: '#334155' }}>شما در حال استقرار نسخه زیر هستید:</p>
              <div style={{ 
                fontFamily: 'monospace', 
                fontSize: '18px', 
                fontWeight: 'bold', 
                textAlign: 'center', 
                padding: '12px', 
                backgroundColor: '#f1f5f9', 
                borderRadius: '6px', 
                border: '1px solid #e2e8f0',
                color: '#0f172a',
                letterSpacing: '2px'
              }} dir="ltr">
                {selectedRelease.version}
              </div>
            </div>

            <div className="field full">
              <label htmlFor="confirm-version" style={{ fontWeight: 'bold', color: '#334155' }}>برای تأیید، شماره نسخه بالا را دقیق وارد کنید:</label>
              <input
                id="confirm-version"
                dir="ltr"
                style={{ fontFamily: 'monospace', letterSpacing: '1px', textAlign: 'center', fontSize: '16px' }}
                value={confirmVersion}
                onChange={(e) => setConfirmVersion(e.target.value)}
                placeholder="مثال: 202310150930"
                required
                autoComplete="off"
              />
            </div>

            {activationError && (
              <div className="profile-form-error" style={{ marginTop: '16px' }}>{activationError}</div>
            )}

            <div className="form-footer" style={{ marginTop: '32px', display: 'flex', gap: '12px' }}>
              <button
                className="btn"
                style={{ 
                  backgroundColor: confirmVersion === selectedRelease.version ? '#ea580c' : '#fdba74', 
                  color: 'white', 
                  border: 'none',
                  flex: 1,
                  display: 'flex',
                  justifyContent: 'center',
                  padding: '10px',
                  opacity: (activateMutation.isPending || confirmVersion !== selectedRelease.version) ? 0.7 : 1,
                  cursor: (activateMutation.isPending || confirmVersion !== selectedRelease.version) ? 'not-allowed' : 'pointer'
                }}
                type="submit"
                disabled={activateMutation.isPending || confirmVersion !== selectedRelease.version}
              >
                {activateMutation.isPending ? 'در حال ارسال درخواست...' : 'تأیید و استقرار'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
                onClick={() => {
                  setSelectedRelease(null);
                  setActivationError('');
                  setConfirmVersion('');
                }}
                disabled={activateMutation.isPending}
              >
                انصراف
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
