import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, useGetAuthSession, getListUsersQueryKey, getListVoipRecordingsQueryKey } from '@workspace/api-client-react';
import { useVoip } from './VoipProvider';
import { saveVoipExtension } from './voip-api';

export function TestExtensionSettings() {
  const { config, connection } = useVoip();
  const { data: session } = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ extension: '', authorizationUsername: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (config && !dirty) setForm({ extension: config.extension ?? '', authorizationUsername: config.authorizationUsername ?? '' });
  }, [config, dirty]);
  if (session?.user.role !== 'admin') return null;
  return <div className="panel" data-testid="voip-test-extension-settings">
    <div className="panel-head"><div><h3>۲. داخلی آزمایشی این حساب</h3><p>داخلی روی سرور ویپ باید از قبل ساخته شده باشد. این تنظیم فقط به حساب فعلی CRM تخصیص داده می‌شود.</p></div></div>
    <form style={{ marginTop: 16 }} onSubmit={async event => {
      event.preventDefault();
      if (saving) return;
      setSaving(true); setMessage(''); setError('');
      try {
        await saveVoipExtension(session.user.id, {
          extension: form.extension.trim(), authorizationUsername: form.authorizationUsername.trim() || null,
        });
        setDirty(false);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['voip-config'] }),
          queryClient.invalidateQueries({ queryKey: ['voip-extensions'] }),
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListVoipRecordingsQueryKey().slice(0, 1) }),
        ]);
        setMessage('داخلی ذخیره شد؛ در بخش تست اتصال، رمز همان داخلی را وارد کنید.');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'ذخیره داخلی انجام نشد.');
      } finally { setSaving(false); }
    }}>
      <div className="form-grid">
        <label className="field">شماره داخلی (SIP User)
          <input dir="ltr" required maxLength={32} disabled={saving || connection === 'connecting' || connection === 'registered'} value={form.extension} placeholder="1001" data-testid="voip-test-extension" onChange={e => { setDirty(true); setForm(current => ({ ...current, extension: e.target.value })); }} />
        </label>
        <label className="field">نام کاربری احراز (Auth ID، اختیاری)
          <input dir="ltr" maxLength={128} disabled={saving || connection === 'connecting' || connection === 'registered'} value={form.authorizationUsername} placeholder="اگر متفاوت است وارد کنید" data-testid="voip-test-auth-user" onChange={e => { setDirty(true); setForm(current => ({ ...current, authorizationUsername: e.target.value })); }} />
        </label>
      </div>
      <p style={{ fontSize: 12, color: '#64748b' }}>اگر نام کاربری احراز خالی باشد، شماره داخلی استفاده می‌شود. رمز داخلی در پایگاه داده یا حافظه دائمی مرورگر ذخیره نمی‌شود.</p>
      <div className="form-footer"><button className="btn btn-primary" disabled={saving || connection === 'connecting' || connection === 'registered'} data-testid="voip-save-test-extension">{saving ? 'در حال ذخیره…' : 'ذخیره داخلی آزمایشی'}</button></div>
      {connection === 'registered' && <p style={{ fontSize: 12 }}>برای تغییر تنظیمات، ابتدا اتصال فعلی را قطع کنید.</p>}
      {message && <p role="status" style={{ color: '#047857' }}>{message}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
  </div>;
}