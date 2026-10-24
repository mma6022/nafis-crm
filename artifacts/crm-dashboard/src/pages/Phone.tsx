import { CustomerIdBadge } from '@/components/customer/CustomerName';
import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Settings, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, Wifi, WifiOff, AlertTriangle, Play, Square, Save, RefreshCw, Users } from 'lucide-react';
import { useVoip } from '@/components/voip/VoipProvider';
import { useVoipContacts, useVoipHistory, useVoipExtensions, saveVoipConfig, saveVoipExtension } from '@/components/voip/voip-api';
import { formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { AfterCallPopup } from '@/components/voip/AfterCallPopup';
import { TestExtensionSettings } from '@/components/voip/TestExtensionSettings';
import { useGetAuthSession, getGetAuthSessionQueryKey } from '@workspace/api-client-react';

export default function PhonePage() {
  const { error, logError, clearError } = useVoip();
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const isAdmin = session?.user?.role === 'admin';

  return (
    <section>
      <div className="page-intro">
        <div>
          <h2>تلفن شرکت</h2>
          <p>مرحله اول: تنظیم سرور ویپ و آزمایش ثبت یک داخلی از همین مرورگر</p>
        </div>
      </div>
      
      <AfterCallPopup />
      {error && (
        <div className="error-state" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={clearError}>بستن</button>
        </div>
      )}

      {logError && (
        <div className="error-state" style={{ marginBottom: 16, backgroundColor: '#fef3c7', color: '#92400e', borderColor: '#fbbf24' }}>
          <span>خطای گزارش‌گیری: {logError}</span>
        </div>
      )}

      <div className="detail-grid">
         <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {isAdmin && <AdminConfigPanel />}
            {isAdmin && <TestExtensionSettings />}
            <ConnectionPanel />
            <DialerPanel />
         </div>
         <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <HistoryPanel />
            {isAdmin && <ExtensionsPanel />}
            <AvabomSyncPanel />
         </div>
      </div>
    </section>
  );
}

function ConnectionPanel() {
  const { config, isConfigLoading, configError, refetchConfig, connection, connectionDetail, connect, disconnect, canCall } = useVoip();
  const [password, setPassword] = useState('');

  if (isConfigLoading) return <SkeletonPanel rows={3} />;
  if (configError) return <div className="panel" role="alert"><p>دریافت تنظیمات تلفن ناموفق بود.</p><button className="btn btn-ghost" onClick={refetchConfig}>تلاش دوباره</button></div>;
  
  if (!config) return <div className="panel"><p>تنظیمات یافت نشد.</p></div>;

  const canConnect = config.enabled && config.wssUrl && config.extension && canCall;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>۳. تست اتصال داخلی به سرور ویپ</h3>
          <p>سبز یعنی سرور SIP ثبت داخلی را تأیید کرده است، نه صرفاً باز شدن ارتباط شبکه.</p>
        </div>
        <span role="status" aria-live="polite" data-testid="voip-connection-status" data-state={connection} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span aria-hidden="true" data-testid="voip-connection-dot" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: connection === 'registered' ? '#10b981' : connection === 'connecting' ? '#f59e0b' : '#ef4444' }} />
          {connection === 'registered' ? 'متصل؛ داخلی ثبت شد' : connection === 'connecting' ? 'در حال اتصال…' : 'متصل نیست'}
        </span>
      </div>
      <div style={{ marginTop: 16 }}>
        <p data-testid="voip-connection-detail" style={{ fontSize: 12, color: '#64748b' }}>{connectionDetail}</p>
        <p style={{ fontSize: 12, color: '#64748b' }}>این وضعیت مخصوص همین حساب و همین مرورگر است. ثبت داخلی، تست میکروفن و صدای دوطرفه نیست.</p>
        {!canCall ? (
          <div className="empty-state">
            <AlertTriangle />
            <strong>دسترسی تماس ندارید</strong>
            <p>مجوز تماس سیستمی برای حساب شما فعال نیست.</p>
          </div>
        ) : !config.enabled ? (
          <div className="empty-state">
            <AlertTriangle />
            <strong>تلفن غیرفعال است</strong>
            <p>مدیر سیستم باید تلفن را فعال کند.</p>
          </div>
        ) : !config.extension ? (
          <div className="empty-state">
            <AlertTriangle />
            <strong>داخلی تخصیص نیافته</strong>
            <p>برای حساب شما داخلی تنظیم نشده است.</p>
          </div>
        ) : (
          <div className="form-grid">
            <div className="field full">
               <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                 <span>وضعیت فعلی:</span>
                 <strong style={{ 
                   color: connection === 'registered' ? '#10b981' : 
                          connection === 'error' ? '#ef4444' : 
                          connection === 'connecting' ? '#f59e0b' : '#64748b'
                 }}>
                   {connection === 'registered' ? 'متصل' : 
                    connection === 'error' ? 'خطا در اتصال' : 
                    connection === 'connecting' ? 'در حال اتصال...' : 'قطع'}
                 </strong>
               </div>
            </div>
            {connection !== 'registered' && connection !== 'connecting' && (
              <>
                <div className="field full">
                  <label>رمز عبور داخلی ({config.extension})</label>
                  <input
                    data-testid="voip-test-password"
                    autoComplete="off"
                    type="password" 
                    value={password} 
                    onChange={e => setPassword(e.target.value)} 
                    dir="ltr"
                    placeholder="رمز عبور SIP"
                  />
                </div>
                <div className="field full">
                  <button 
                    className="btn btn-primary" 
                    data-testid="voip-test-connect"
                    onClick={() => { void connect(password); setPassword(''); }}
                    disabled={!password || !canConnect}
                  >
                    <Play size={15} /> اتصال به تلفن
                  </button>
                  <p style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
                    توجه: برای دریافت تماس‌ها، این تب باید باز بماند.
                  </p>
                </div>
              </>
            )}
            {(connection === 'registered' || connection === 'connecting') && (
              <div className="field full">
                <button className="btn btn-ghost" data-testid="voip-test-disconnect" onClick={() => { void disconnect(); }}>
                  <Square size={15} /> قطع اتصال
                </button>
                <p style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
                  توجه: تا زمانی که متصل هستید، این تب باید باز بماند تا تماس‌ها دریافت شوند.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DialerPanel() {
  const { dial, canCall, connection, call } = useVoip();
  const [phone, setPhone] = useState('');
  const [search, setSearch] = useState('');
  const { data: contactsData, isLoading } = useVoipContacts(search);
  const canDialSystem = connection === 'registered' && canCall && !call;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>شماره‌گیر</h3>
          <p>جستجوی مشتری یا شماره‌گیری مستقیم</p>
        </div>
        <PhoneCall color="#9aa4b3" />
      </div>
      
      <div className="form-grid" style={{ marginTop: 16 }}>
        <div className="field full">
          <label>شماره تماس</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input 
              dir="ltr" 
              value={phone} 
              onChange={e => setPhone(e.target.value)} 
              placeholder="09..."
            />
            <button 
              className="btn btn-primary" 
              disabled={!phone || !canDialSystem} 
              onClick={() => dial(phone)}
              title={canDialSystem ? "تماس" : "برای تماس باید متصل باشید"}
            >
              <Phone size={15} /> تماس
            </button>
          </div>
        </div>
        
        <div className="field full" style={{ marginTop: 16 }}>
          <label>جستجوی مخاطبین CRM</label>
          <input 
            value={search} 
            onChange={e => setSearch(e.target.value)} 
            placeholder="جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)"
          />
        </div>
      </div>
      
      {search && (
        <div style={{ marginTop: 16, borderTop: '1px solid #edf0f4', paddingTop: 16 }}>
          {isLoading ? <p style={{ fontSize: 13, color: '#64748b' }}>در حال جستجو...</p> : (
            contactsData?.items && contactsData.items.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {contactsData.items.map(contact => (
                  <div key={contact.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                    <div>
                      <strong style={{ display: 'block', fontSize: 13, color: '#0f172a' }}>{contact.name}</strong>
                      <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {contact.customerSalespersonName || 'بدون تخصیص'}</span>
                      <span style={{ fontSize: 12, color: '#64748b' }} dir="ltr">{contact.phone}</span>
                    </div>
                    <button 
                      className="btn btn-ghost" 
                      onClick={() => dial(contact.phone)}
                      disabled={!canDialSystem}
                      title={canDialSystem ? "تماس" : "برای تماس باید متصل باشید"}
                      style={{ padding: '6px 10px' }}
                    >
                      <Phone size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : <p style={{ fontSize: 12, color: '#64748b' }}>مخاطبی یافت نشد.</p>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryPanel() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useVoipHistory(page);
  
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>تاریخچه تماس‌ها (سیستم)</h3>
          <p>سوابق تماس‌های ثبت‌شده در مرورگر</p>
        </div>
        <RefreshCw color="#9aa4b3" />
      </div>
      
      {isLoading ? <SkeletonPanel rows={4} /> : isError ? <p style={{ color: '#ef4444', fontSize: 13, marginTop: 16 }}>خطا در دریافت تاریخچه</p> : (
        <>
          {data?.items && data.items.length > 0 ? (
             <div style={{ overflowX: 'auto', marginTop: 16 }}>
               <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                 <thead>
                   <tr>
                     <th style={{ width: 30 }}></th>
                     <th>شماره / مشتری</th>
                     <th>داخلی</th>
                     <th>وضعیت</th>
                     <th>زمان شروع</th>
                     <th>مدت زمان</th>
                   </tr>
                 </thead>
                 <tbody>
                   {data.items.map(record => (
                     <tr key={record.id}>
                       <td>
                         {record.direction === 'incoming' ? <PhoneIncoming size={14} color="#3b82f6" /> : <PhoneOutgoing size={14} color="#10b981" />}
                       </td>
                       <td dir="ltr" style={{ textAlign: 'right' }}>
                         {record.customerName ? (
                            <>
                           <a href={`/customers/${record.customerId}`} className="text-link" style={{ fontWeight: 600 }}>{record.customerName}</a> <CustomerIdBadge id={record.customerId} />
                           <span style={{ display: 'block', fontSize: 11, color: '#64748b' }}>کارشناس فروش: {(record as typeof record & { customerSalespersonName?: string | null }).customerSalespersonName || 'بدون تخصیص'}</span>
                            </>
                         ) : record.phone}
                       </td>
                       <td>{record.actorName} ({record.extension})</td>
                       <td>
                         <span style={{
                           color: record.status === 'completed' ? '#10b981' : 
                                  record.status === 'missed' ? '#ef4444' :
                                  record.status === 'rejected' ? '#f59e0b' : '#64748b'
                         }}>
                           {record.status === 'completed' ? 'پایان‌یافته' :
                            record.status === 'missed' ? 'از دست رفته' :
                            record.status === 'rejected' ? 'رد شده' :
                            record.status === 'failed' ? 'ناموفق' : 
                            record.status === 'ringing' ? 'در حال زنگ...' :
                            record.status === 'answered' ? 'پاسخ داده شده' : record.status}
                         </span>
                       </td>
                       <td>{formatDateTime(record.startedAt)}</td>
                       <td>
                         {record.endedAt && record.answeredAt 
                           ? `${Math.max(0, Math.round((new Date(record.endedAt).getTime() - new Date(record.answeredAt).getTime()) / 1000))} ثانیه`
                           : '—'}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
          ) : (
            <div className="empty-state" style={{ marginTop: 16 }}>
              <Phone />
              <strong>تاریخچه‌ای وجود ندارد</strong>
            </div>
          )}
          
          {data && data.total > data.limit && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost" disabled={page === 1} onClick={() => setPage(p => p - 1)}>قبلی</button>
              <span style={{ fontSize: 13, display: 'flex', alignItems: 'center' }}>صفحه {page}</span>
              <button className="btn btn-ghost" disabled={page * data.limit >= data.total} onClick={() => setPage(p => p + 1)}>بعدی</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AdminConfigPanel() {
  const { config, connection } = useVoip();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    enabled: false, wssUrl: '', sipDomain: '', stunUrls: ''
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  
  useEffect(() => {
    if (config && !dirty) {
      setForm({
        enabled: config.enabled,
        wssUrl: config.wssUrl,
        sipDomain: config.sipDomain,
        stunUrls: config.stunUrls.join(', ')
      });
    }
  }, [config, dirty]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccess('');
    setError('');
    try {
      await saveVoipConfig({
        enabled: form.enabled,
        wssUrl: form.wssUrl.trim(),
        sipDomain: form.sipDomain.trim(),
        stunUrls: form.stunUrls.split(',').map(s => s.trim()).filter(Boolean)
      });
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['voip-config'] });
      queryClient.invalidateQueries({ queryKey: ['voip-extensions'] });
      setSuccess('تنظیمات با موفقیت ذخیره شد.');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError('خطا در ذخیره تنظیمات: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>۱. تنظیمات سرور ویپ (مخصوص ادمین)</h3>
          <p>برای سرور SIP سازگار با WebRTC؛ وابسته به سرویس‌دهنده خاصی نیست.</p>
        </div>
        <Settings color="#9aa4b3" />
      </div>
      <p style={{ fontSize: 12, color: '#92400e' }}>مرورگر مستقیم به SIP روی UDP یا TCP معمولی وصل نمی‌شود. WSS و WebRTC باید روی سرور و داخلی فعال و گواهی TLS معتبر باشد. سرور داخل شبکه شرکت نیز باید از دستگاه شما قابل دسترس باشد.</p>
      <form onSubmit={handleSubmit} style={{ marginTop: 16 }} onChange={() => setDirty(true)}>
        <fieldset disabled={saving || connection === 'registered' || connection === 'connecting'} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="form-grid">
          <div className="field full">
            <label className="boolean-field">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm({...form, enabled: e.target.checked})} />
              <strong>فعال‌سازی سیستم تلفن در مرورگر</strong>
            </label>
          </div>
          <div className="field full">
            <label htmlFor="voip-wss-url">آدرس اتصال مرورگر (WSS، شامل پورت و مسیر)</label>
            <input id="voip-wss-url" data-testid="voip-wss-url" dir="ltr" value={form.wssUrl} onChange={e => setForm({...form, wssUrl: e.target.value})} placeholder="wss://pbx.example.com:8089/ws" required={form.enabled} />
            <small>آدرس بالا فقط نمونه است؛ پورت و مسیر واقعی را از تنظیمات سرور شرکت وارد کنید. پورت WSS با پورت SIP متفاوت است.</small>
          </div>
          <div className="field full">
            <label htmlFor="voip-sip-server">سرور SIP (دامنه یا IP، با پورت اختیاری)</label>
            <input id="voip-sip-server" data-testid="voip-sip-server" dir="ltr" value={form.sipDomain} onChange={e => setForm({...form, sipDomain: e.target.value})} placeholder="192.168.1.10 یا pbx.example.com:5060" required />
          </div>
          <div className="field full">
            <label>آدرس‌های STUN برای صدا (اختیاری، جدا شده با کاما)</label>
            <textarea dir="ltr" value={form.stunUrls} onChange={e => setForm({...form, stunUrls: e.target.value})} placeholder="stun:stun.l.google.com:19302" />
          </div>
        </div>
        <div className="form-footer" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="submit" className="btn btn-primary" data-testid="voip-save-server" disabled={saving}>
            <Save size={15} /> {saving ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}
          </button>
          {success && <span style={{ color: '#10b981', fontSize: 13 }}>{success}</span>}
        </div>
        </fieldset>
        {error && <p role="alert" className="form-error">{error}</p>}
        {connection === 'registered' && <p style={{ fontSize: 12 }}>برای تغییر سرور، ابتدا اتصال فعلی را قطع کنید.</p>}
      </form>
    </div>
  );
}

function ExtensionsPanel() {
  const { config } = useVoip();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useVoipExtensions(!!config?.enabled);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [form, setForm] = useState({ extension: '', authorizationUsername: '' });
  const [saving, setSaving] = useState(false);
  const [extMessage, setExtMessage] = useState({ text: '', type: '' });


  const handleEdit = (ext: any) => {
    setEditingUserId(ext.userId);
    setForm({ 
      extension: ext.extension || '', 
      authorizationUsername: ext.authorizationUsername || '' 
    });
    setExtMessage({ text: '', type: '' });
  };

  const handleSave = async (userId: number) => {
    setSaving(true);
    setExtMessage({ text: '', type: '' });
    try {
      await saveVoipExtension(userId, {
        extension: form.extension.trim() || null,
        authorizationUsername: form.authorizationUsername.trim() || null
      });
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['voip-config'] });
      setEditingUserId(null);
      setExtMessage({ text: 'داخلی ذخیره شد.', type: 'success' });
      setTimeout(() => setExtMessage({ text: '', type: '' }), 3000);
    } catch (err: any) {
      setExtMessage({ text: err.message || 'خطا در ذخیره', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>مدیریت داخلی‌ها</h3>
          <p>تخصیص داخلی به کاربران سیستم</p>
        </div>
        <Users color="#9aa4b3" />
      </div>
      
      {extMessage.text && (
        <div style={{ padding: '8px 12px', marginTop: 12, borderRadius: 6, fontSize: 13, backgroundColor: extMessage.type === 'success' ? '#d1fae5' : '#fee2e2', color: extMessage.type === 'success' ? '#065f46' : '#991b1b' }}>
          {extMessage.text}
        </div>
      )}

      {isLoading ? <SkeletonPanel rows={3} /> : (
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th>کاربر</th>
                <th>شماره داخلی</th>
                <th>نام کاربری Auth</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map(item => (
                <tr key={item.userId}>
                  <td>{item.displayName}</td>
                  {editingUserId === item.userId ? (
                    <>
                      <td><input dir="ltr" value={form.extension} onChange={e => setForm({...form, extension: e.target.value})} placeholder="مثال: 101" style={{ width: '100px', padding: 4 }} /></td>
                      <td><input dir="ltr" value={form.authorizationUsername} onChange={e => setForm({...form, authorizationUsername: e.target.value})} placeholder="اختیاری" style={{ width: '120px', padding: 4 }} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-primary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => handleSave(item.userId)} disabled={saving}>ذخیره</button>
                          <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => setEditingUserId(null)}>لغو</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td dir="ltr">{item.extension || 'ندارد'}</td>
                      <td dir="ltr">{item.authorizationUsername || 'ندارد'}</td>
                      <td>
                        <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => handleEdit(item)}>ویرایش</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AvabomSyncPanel() {
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>همگام‌سازی با سرور شرکت</h3>
          <p>دریافت سوابق قبلی و دفترچه تلفن</p>
        </div>
        <RefreshCw color="#9aa4b3" />
      </div>
      <div className="empty-state" style={{ marginTop: 16 }}>
        <AlertTriangle color="#f59e0b" />
        <strong>همگام‌سازی در حال حاضر در دسترس نیست</strong>
        <p>این قابلیت در انتظار مستندات API جهت پیاده‌سازی می‌باشد.</p>
      </div>
    </div>
  );
}
