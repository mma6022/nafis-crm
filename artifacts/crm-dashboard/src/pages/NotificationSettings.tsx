import { CheckCircle2, DatabaseBackup, Download, History, KeyRound, MessageCircle, Save, Send, ShieldAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetNotificationSettingsQueryKey,
  getListNotificationDeliveriesQueryKey,
  useGetNotificationSettings,
  useListNotificationDeliveries,
  useUpdateNotificationSettings,
  type NotificationSettingsInput,
} from '@workspace/api-client-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';

export default function NotificationSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useGetNotificationSettings({
    query: { queryKey: getGetNotificationSettingsQueryKey() },
  });
  const deliveryParams = { limit: 20 };
  const deliveries = useListNotificationDeliveries(deliveryParams, {
    query: { queryKey: getListNotificationDeliveriesQueryKey(deliveryParams) },
  });
  const update = useUpdateNotificationSettings();
  const [form, setForm] = useState<NotificationSettingsInput | null>(null);
  const databaseFile = useRef<HTMLInputElement>(null);
  const [databaseBusy, setDatabaseBusy] = useState<'download' | 'upload' | null>(null);
  const [databaseMessage, setDatabaseMessage] = useState('');
  const [databaseError, setDatabaseError] = useState('');

  useEffect(() => {
    if (!settings.data) return;
    const { telegramBotTokenConfigured: _telegram, ...editable } = settings.data;
    setForm(editable);
  }, [settings.data]);

  if (settings.isLoading || !form) return <SkeletonPanel rows={7} />;
  if (settings.isError) return <ErrorState onRetry={() => settings.refetch()} />;

  const setValue = <K extends keyof NotificationSettingsInput>(key: K, value: NotificationSettingsInput[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { data: form },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetNotificationSettingsQueryKey() }),
      },
    );
  };

  const downloadBackup = async () => {
    setDatabaseBusy('download');
    setDatabaseError('');
    setDatabaseMessage('');
    try {
      const response = await fetch('/api/database-backup', { credentials: 'include' });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `crm-backup-${new Date().toISOString().slice(0, 10)}.db`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDatabaseMessage('نسخه پشتیبان آماده و دانلود شد.');
    } catch {
      setDatabaseError('دانلود نسخه پشتیبان انجام نشد.');
    } finally {
      setDatabaseBusy(null);
    }
  };

  const uploadDatabase = async (file: File) => {
    const confirmed = window.confirm('با ادامه، دیتابیس فعلی پس از گرفتن نسخه پشتیبان با فایل انتخاب‌شده جایگزین می‌شود و سامانه چند لحظه راه‌اندازی مجدد خواهد شد. ادامه می‌دهید؟');
    if (!confirmed) {
      if (databaseFile.current) databaseFile.current.value = '';
      return;
    }
    setDatabaseBusy('upload');
    setDatabaseError('');
    setDatabaseMessage('');
    try {
      const response = await fetch('/api/database-restore', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(result?.message);
      setDatabaseMessage(result?.message ?? 'دیتابیس جدید پذیرفته شد. سامانه در حال راه‌اندازی مجدد است.');
      window.setTimeout(() => window.location.reload(), 4000);
    } catch (error) {
      setDatabaseError(error instanceof Error && error.message ? error.message : 'آپلود دیتابیس انجام نشد.');
      setDatabaseBusy(null);
    } finally {
      if (databaseFile.current) databaseFile.current.value = '';
    }
  };

  return (
    <section className="data-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">مدیریت ارتباطات خودکار</div>
          <h2>تنظیمات اعلان‌ها</h2>
          <p>پیام ثبت مشتری جدید برای گروه فروش و خود مشتری را مدیریت کنید.</p>
        </div>
      </div>

      <div className="notification-secret-status">
        <div className="secret-status-card configured"><span className="secret-status-icon"><CheckCircle2 size={18} /></span><div><strong>رله پیامک ایران</strong><span>ارسال از طریق آدرس قابل تنظیم انجام می‌شود</span></div><Send size={16} /></div>
        <SecretStatus label="توکن ربات تلگرام" configured={Boolean(settings.data?.telegramBotTokenConfigured)} />
      </div>

      <form onSubmit={submit} className="notification-settings-grid">
        <section className="panel notification-settings-card">
          <div className="panel-head">
            <div><h3><Send size={17} /> پیامک IPPanel</h3><p>ارسال پترن به شماره مشتری پس از ثبت پرونده</p></div>
            <label className="settings-switch"><input type="checkbox" checked={form.ippanelEnabled} onChange={(event) => setValue('ippanelEnabled', event.target.checked)} data-testid="checkbox-ippanel-enabled" /><span>{form.ippanelEnabled ? 'فعال' : 'غیرفعال'}</span></label>
          </div>
          <div className="form-grid">
            <div className="field full"><label htmlFor="ippanel-relay">آدرس سرور رله</label><input id="ippanel-relay" type="url" dir="ltr" value={form.ippanelRelayUrl} onChange={(event) => setValue('ippanelRelayUrl', event.target.value)} data-testid="input-ippanel-relay" /></div>
            <div className="field"><label htmlFor="ippanel-from">شماره فرستنده</label><input id="ippanel-from" dir="ltr" value={form.ippanelFromNumber} onChange={(event) => setValue('ippanelFromNumber', event.target.value)} data-testid="input-ippanel-from" /></div>
            <div className="field"><label htmlFor="ippanel-pattern">کد پترن</label><input id="ippanel-pattern" dir="ltr" value={form.ippanelPatternCode} onChange={(event) => setValue('ippanelPatternCode', event.target.value)} data-testid="input-ippanel-pattern" /></div>
          </div>
          <div className="settings-help">درخواست با پارامترهای ثابت <code>name</code>، <code>sale_name</code> و <code>sale_mobile</code> به رله ارسال می‌شود. کلید IPPanel داخل CRM یا payload رله قرار نمی‌گیرد.</div>
        </section>

        <section className="panel notification-settings-card">
          <div className="panel-head">
            <div><h3><MessageCircle size={17} /> پیام گروه تلگرام</h3><p>اعلام مشتری جدید به گروه فروش</p></div>
            <label className="settings-switch"><input type="checkbox" checked={form.telegramEnabled} onChange={(event) => setValue('telegramEnabled', event.target.checked)} data-testid="checkbox-telegram-enabled" /><span>{form.telegramEnabled ? 'فعال' : 'غیرفعال'}</span></label>
          </div>
          <div className="form-grid">
            <div className="field full"><label htmlFor="telegram-chat-id">شناسه گروه فروش</label><input id="telegram-chat-id" dir="ltr" value={form.telegramGroupChatId} onChange={(event) => setValue('telegramGroupChatId', event.target.value)} data-testid="input-telegram-chat-id" /></div>
            <div className="field full"><label htmlFor="telegram-template">قالب پیام</label><textarea id="telegram-template" className="settings-template-textarea" value={form.telegramMessageTemplate} onChange={(event) => setValue('telegramMessageTemplate', event.target.value)} data-testid="textarea-telegram-template" /></div>
          </div>
          <div className="settings-help">متغیرهای قابل استفاده: <code>{'{name}'}</code> <code>{'{phone}'}</code> <code>{'{salesperson}'}</code> <code>{'{salespersonPhone}'}</code> <code>{'{description}'}</code></div>
        </section>

        {update.isError ? <div className="profile-form-error notification-settings-feedback" data-testid="error-save-notification-settings">ذخیره تنظیمات انجام نشد. دوباره تلاش کنید.</div> : null}
        {update.isSuccess ? <div className="ai-extract-success notification-settings-feedback" data-testid="success-save-notification-settings">تنظیمات اعلان‌ها ذخیره شد.</div> : null}
        <div className="notification-settings-actions">
          <button type="submit" className="btn btn-primary" disabled={update.isPending} data-testid="button-save-notification-settings"><Save size={16} />{update.isPending ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}</button>
        </div>
      </form>

      <section className="panel notification-delivery-panel" data-testid="panel-database-backup">
        <div className="panel-head">
          <div><h3><DatabaseBackup size={17} /> پشتیبان‌گیری دیتابیس</h3><p>دانلود نسخه فعلی یا جایگزینی دیتابیس با فایل سالم CRM</p></div>
        </div>
        <div className="settings-help">سامانه هر روز رأس ساعت ۰۰:۰۱ به وقت تهران نسخه پشتیبان خودکار می‌گیرد و هفت نسخه روزانه اخیر را نگه می‌دارد.</div>
        {databaseError ? <div className="profile-form-error" style={{ marginTop: 14 }} data-testid="error-database-backup">{databaseError}</div> : null}
        {databaseMessage ? <div className="ai-extract-success" style={{ marginTop: 14 }} data-testid="success-database-backup">{databaseMessage}</div> : null}
        <div className="form-footer">
          <button className="btn btn-primary" type="button" onClick={downloadBackup} disabled={databaseBusy !== null} data-testid="button-download-database">
            <Download size={16} />{databaseBusy === 'download' ? 'در حال آماده‌سازی…' : 'دانلود پشتیبان'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => databaseFile.current?.click()} disabled={databaseBusy !== null} data-testid="button-upload-database">
            <Upload size={16} />{databaseBusy === 'upload' ? 'در حال بررسی و جایگزینی…' : 'آپلود دیتابیس جدید'}
          </button>
          <input ref={databaseFile} type="file" accept=".db,.sqlite,.sqlite3,application/x-sqlite3" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDatabase(file); }} />
        </div>
      </section>

      <section className="panel notification-delivery-panel">
        <div className="panel-head">
          <div><h3><History size={17} /> گزارش ارسال اعلان‌ها</h3><p>آخرین نتیجه‌های ارسال برای مشتریان جدید</p></div>
        </div>
        {deliveries.isLoading ? <div className="loading-stack"><div className="skeleton loading-line" /><div className="skeleton loading-line" /></div> : null}
        {deliveries.isError ? <ErrorState onRetry={() => deliveries.refetch()} /> : null}
        {deliveries.data?.length === 0 ? <div className="empty-state compact">هنوز اعلانی ارسال نشده است.</div> : null}
        {deliveries.data?.length ? (
          <div className="notification-delivery-list">
            {deliveries.data.map((delivery) => (
              <div className="notification-delivery-row" key={delivery.id}>
                <span className={`delivery-status ${delivery.status}`}>{deliveryStatusLabel(delivery.status)}</span>
                <div><strong>{delivery.customerName}</strong><span>{delivery.channel === 'telegram' ? 'تلگرام' : 'پیامک IPPanel'} · {formatNotificationDate(delivery.createdAt)}</span></div>
                <span className="delivery-error">{delivery.errorMessage || 'ارسال با موفقیت انجام شد'}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </section>
  );
}

function SecretStatus({ label, configured }: { label: string; configured: boolean }) {
  return <div className={`secret-status-card ${configured ? 'configured' : 'missing'}`}><span className="secret-status-icon">{configured ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}</span><div><strong>{label}</strong><span>{configured ? 'به‌صورت امن تنظیم شده است' : 'هنوز در Secrets تنظیم نشده است'}</span></div><KeyRound size={16} /></div>;
}

const deliveryStatusLabel = (status: string) => ({
  sent: 'ارسال شد',
  failed: 'ناموفق',
  not_configured: 'تنظیم نشده',
  invalid_recipient: 'شماره نامعتبر',
}[status] ?? status);

const formatNotificationDate = (value: string) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Tehran',
}).format(new Date(value));