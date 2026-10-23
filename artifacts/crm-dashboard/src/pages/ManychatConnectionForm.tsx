import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react';

export type ManychatStatus = {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  replyMode?: 'intake' | 'ai';
  source?: 'database' | 'environment' | 'none';
  mode?: 'api' | 'flow';
  verifiedAt?: string | null;
  credentialsUnreadable?: boolean;
};

const errors: Record<string, string> = {
  invalid_credentials_format: 'کلید ارتباط باید حداقل ۲۴ کاراکتر باشد؛ در حالت API، توکن نیز باید معتبر باشد.',
  invalid_token: 'Manychat توکن را نپذیرفت (401/403). توکن Public API همان حساب را از Settings → API بررسی کنید.',
  provider_unavailable: 'ارتباط با Manychat برقرار نشد. کمی بعد دوباره تلاش کنید.',
  rate_limited: 'Manychat فعلاً درخواست‌های بیشتری نمی‌پذیرد. کمی بعد تلاش کنید.',
  provider_rejected: 'پاسخ Manychat معتبر نبود؛ حساب و دسترسی Public API را بررسی کنید.',
  credential_storage_unavailable: 'ذخیرهٔ امن تنظیمات روی سرور ممکن نیست؛ مدیر سرور باید کلید رمزنگاری را بررسی کند.',
  account_changed: 'توکن اکنون به حساب دیگری تعلق دارد. تنظیمات را با توکن و کلید درست دوباره ثبت کنید.',
  connection_not_configured: 'ابتدا توکن و کلید را ثبت کنید.',
  connection_changed: 'تنظیمات اتصال در حین بررسی تغییر کرد؛ دوباره تلاش کنید.',
  test_dm_required: 'پیش از روشن‌کردن پاسخ خودکار، یک دایرکت آزمایشی از حساب دیگر بفرستید تا در این صندوق ثبت شود.',
  live_confirmation_required: 'تأیید کنید که پیام آزمایشی را در اینستاگرام، Manychat و صندوق CRM دیده‌اید.',
  send_in_progress: 'ارسالی در حال انجام است؛ چند لحظه بعد دوباره تلاش کنید. ارسال شروع‌شده ممکن است تکمیل شود.',
};

async function action(path: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/instagram/manychat/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(errors[data.error ?? ''] ?? `درخواست انجام نشد (${response.status}).`);
  return data;
}

export default function ManychatConnectionForm({ status, onUpdated }: { status: ManychatStatus; onUpdated: () => void }) {
  const [setupMode, setSetupMode] = useState<'flow' | 'api'>(status.configured && status.mode === 'flow' ? 'flow' : 'api');
  const [replyMode, setReplyMode] = useState<'intake' | 'ai'>(status.replyMode ?? 'intake');
  const [apiToken, setApiToken] = useState('');
  const [bridgeSecret, setBridgeSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [confirmedLiveDelivery, setConfirmedLiveDelivery] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setReplyMode(status.replyMode ?? 'intake');
  }, [status.replyMode]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setPending(true); setError(''); setMessage('');
    try {
      await operation();
      setMessage(success);
      onUpdated();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'عملیات ناموفق بود.');
      return false;
    } finally {
      setPending(false);
    }
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await run(() => setupMode === 'flow'
      ? action('flow-config', { bridgeSecret })
      : action('config', { apiToken, bridgeSecret }),
    setupMode === 'flow'
      ? 'کلید ارتباط به‌صورت رمزگذاری‌شده ذخیره شد. این کار دریافت واقعی دایرکت یا تحویل پاسخ را تأیید نمی‌کند؛ پاسخ خودکار خاموش است.'
      : 'توکن در Manychat تأیید و هر دو مقدار به‌صورت رمزگذاری‌شده ذخیره شد. پاسخ خودکار هنوز خاموش است.')) {
      setApiToken(''); setBridgeSecret(''); setConfirmedLiveDelivery(false);
    }
  };
  const generateSecret = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setBridgeSecret(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    setShowSecret(true);
    setMessage(''); setError('');
  };
  const copySecret = async () => {
    if (!bridgeSecret || pending) return;
    setMessage(''); setError('');
    try {
      await navigator.clipboard.writeText(bridgeSecret);
      setMessage('کلید مستقل کپی شد؛ آن را در هدر X-CRM-Bridge-Secret در Manychat قرار دهید.');
    } catch {
      // Older browsers or denied clipboard access can still allow a direct copy.
      const field = document.createElement('textarea');
      const previousFocus = document.activeElement;
      field.value = bridgeSecret;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy_failed');
        setMessage('کلید مستقل کپی شد؛ آن را در هدر X-CRM-Bridge-Secret در Manychat قرار دهید.');
      } catch {
        setShowSecret(true);
        setError('کپی خودکار انجام نشد؛ کلید را از کادر انتخاب و به‌صورت دستی کپی کنید.');
      } finally {
        field.value = '';
        field.remove();
        if (previousFocus instanceof HTMLElement) previousFocus.focus();
      }
    }
  };

  return <div className="manychat-connection" data-testid="manychat-connection">
    <div className="manychat-progress">
      <span className={status.configured ? 'done' : ''}>{status.configured ? <Check size={13} /> : '۱'} {status.mode === 'flow' || setupMode === 'flow' ? 'کلید ارتباط' : 'توکن API'}</span>
      <span className={status.connected ? 'done' : ''}>{status.connected ? <Check size={13} /> : '۲'} دریافت رویداد Manychat</span>
      <span className={status.enabled ? 'done' : ''}>{status.enabled ? <Check size={13} /> : '۳'} پاسخ خودکار</span>
    </div>
    {status.credentialsUnreadable ? <p className="manychat-warning"><AlertTriangle size={15} /> کلید رمزنگاری سرور تغییر کرده یا داده‌ها خواندنی نیستند؛ تنظیمات را دوباره ثبت کنید.</p> : null}
    <div className="manychat-mode-choice" role="group" aria-label="روش اتصال">
      <label><input type="radio" name="manychat-mode" checked={setupMode === 'flow'} onChange={() => setSetupMode('flow')} /> بدون Public API؛ ارسال از Flow با تأخیر حداقل یک دقیقه</label>
      <label><input type="radio" name="manychat-mode" checked={setupMode === 'api'} onChange={() => setSetupMode('api')} /> Public API (در صورت فعال‌بودن دسترسی حساب)</label>
    </div>
    <section className="manychat-reply-mode" aria-labelledby="manychat-reply-mode-heading" data-testid="section-instagram-reply-mode">
      <div>
        <strong id="manychat-reply-mode-heading">حالت پاسخ‌گویی دایرکت</strong>
        <p>این انتخاب فقط شیوهٔ پاسخ را تعیین می‌کند و جایگزین تأیید انسانی پرونده نیست.</p>
      </div>
      <div className="manychat-mode-choice" role="radiogroup" aria-label="حالت پاسخ‌گویی">
        <label><input type="radio" name="instagram-reply-mode" value="intake" checked={replyMode === 'intake'} onChange={() => setReplyMode('intake')} data-testid="radio-instagram-reply-intake" /> ثبت اطلاعات</label>
        <label><input type="radio" name="instagram-reply-mode" value="ai" checked={replyMode === 'ai'} onChange={() => setReplyMode('ai')} data-testid="radio-instagram-reply-ai" /> مشاوره هوشمند</label>
      </div>
      <p className="manychat-ai-disclosure" data-testid="text-instagram-ai-disclosure">
        {replyMode === 'ai'
          ? 'مشاورهٔ هوشمند فقط از طرح‌های وام فعال و عمومی و متن همین گفت‌وگوی دایرکت استفاده می‌کند؛ به اطلاعات خصوصی CRM یا پروندهٔ مشتری دسترسی ندارد. تأیید وام را تضمین نمی‌کند؛ شمارهٔ تلفن تأییدنشده است و بررسی دستی کارشناس همچنان لازم است.'
          : 'در حالت ثبت اطلاعات، ربات نام، شمارهٔ تماس و درخواست را می‌پرسد؛ شماره هنوز تأیید نشده و ثبت مشتری یا بررسی نهایی همچنان با کارشناس است.'}
      </p>
      <button type="button" className="instagram-connect-button" disabled={pending || replyMode === (status.replyMode ?? 'intake')}
        onClick={() => void run(async () => {
          const result = await action('reply-mode', { replyMode });
          if (result.replyMode !== 'intake' && result.replyMode !== 'ai') {
            throw new Error('حالت پاسخ معتبر از سرور دریافت نشد؛ وضعیت را دوباره بررسی کنید.');
          }
          setReplyMode(result.replyMode);
          return result;
        }, `حالت «${replyMode === 'ai' ? 'مشاوره هوشمند' : 'ثبت اطلاعات'}» ذخیره شد؛ این تنظیم، تحویل پاسخ در دایرکت را تأیید نمی‌کند.`)}
        data-testid="button-save-instagram-reply-mode">
        {pending ? <LoaderCircle size={15} className="instagram-spinning" /> : <Check size={15} />} ذخیرهٔ حالت پاسخ
      </button>
    </section>
    <details className="manychat-help" open={!status.connected}>
      <summary>راهنمای اتصال و تنظیم Manychat</summary>
      <ol>
        <li>در <a href="https://manychat.com/" target="_blank" rel="noreferrer">Manychat</a> با حساب مدیر وارد شوید و مطمئن شوید پیج حرفه‌ای در بخش Instagram با <b>Connect Via Instagram</b> متصل است. رمز پیج را اینجا وارد نکنید.</li>
        {setupMode === 'api' ? <li>در همان حساب، به <b>Settings → API</b> بروید و توکن Account Public API را کپی کنید. فقط مقدار توکن کافی است؛ CRM پیشوند <code dir="ltr">Bearer</code> را در هدر اضافه می‌کند. این روش بدون دسترسی معتبر به API کار نمی‌کند. اگر Manychat شناسهٔ صفحه ندهد، تعویض توکن اتصال مجزایی می‌سازد و تاریخچهٔ قبلی با آن ادغام نمی‌شود.</li> : null}
        <li>«کلید ارتباط» توکن Manychat نیست؛ با دکمهٔ زیر کلید مستقل بسازید. قبل از ذخیره، آن را برای مرحلهٔ بعد نزد خود کپی کنید؛ پس از ذخیره دوباره نمایش داده نمی‌شود.</li>
        <li>پس از ذخیره، در Instagram <b>Default Reply</b> را روی <b>Every time a user sends a message</b> بگذارید و در Flow یک <b>Make External Request</b> با متد POST به نشانی HTTPS دامنهٔ اصلی CRM به‌علاوهٔ <code dir="ltr">/api/manychat/inbound</code> بسازید. هدر <code dir="ltr">X-CRM-Bridge-Secret</code> را برابر همین کلید قرار دهید.</li>
        <li>بدنهٔ JSON باید <code dir="ltr">subscriberId</code> را از <b>Contact ID</b> و <code dir="ltr">text</code> را از <b>Last Text Input</b> در Manychat بگیرد. برای متن از انتخاب‌گر متغیرها استفاده کنید تا JSON معتبر ساخته شود.</li>
        {setupMode === 'flow' ? <>
          <li>سه <b>Custom User Field</b> متنی به نام‌های <code dir="ltr">crm_request_id</code>، <code dir="ltr">crm_ready</code> و <code dir="ltr">crm_reply_text</code> بسازید. پاسخ درخواست اول را از مسیرهای <code dir="ltr">$.requestId</code>، <code dir="ltr">$.ready</code> و <code dir="ltr">$.reply</code> به این فیلدها نگاشت کنید.</li>
          <li>بعد از درخواست اول، <b>Smart Delay به مدت ۱ دقیقه</b> بگذارید. سپس External Request دوم با متد POST به <code dir="ltr">https://crm.nafisvam.com/api/manychat/reply</code> و همان هدر محرمانه بسازید. بدنه: <code dir="ltr">{'{"subscriberId":"<Contact ID>","requestId":"<crm_request_id>"}'}</code>. پاسخ دوم را از <code dir="ltr">$.ready</code> و <code dir="ltr">$.reply</code> به فیلدهای متناظر نگاشت کنید.</li>
          <li>فقط اگر <code dir="ltr">crm_ready</code> برابر <code dir="ltr">yes</code> است، یک Message با متن فیلد <code dir="ltr">crm_reply_text</code> بفرستید؛ در غیر این صورت پیام خودکار نفرستید و بررسی انسانی انجام دهید. پیام‌های پشت‌سرهم یک مخاطب طی دو دقیقه برای جلوگیری از تداخل Flowها عمداً پاسخ خودکار نمی‌گیرند. Flow را <b>Set Live</b> کنید.</li>
        </> : <li>در این حالت بلوک ارسال پاسخ دیگری نگذارید؛ CRM بعد از فعال‌سازی مدیر با API ارسال می‌کند.</li>}
        <li>با حساب دیگری یک دایرکت آزمایشی بفرستید. پس از مشاهدهٔ آن در پیج، Manychat و صندوق CRM، پاسخ خودکار را فعال کنید و دایرکت دیگری برای سنجش ارسال واقعی بفرستید؛ این آزمون لازم است چون ثبت تنظیمات، تحویل پیام را تأیید نمی‌کند.</li>
        <li>{replyMode === 'ai'
          ? 'در حالت مشاوره هوشمند، پاسخ فقط بر اساس طرح‌های وام فعال و عمومی و متن همین گفت‌وگو ساخته می‌شود؛ اطلاعات خصوصی CRM یا پروندهٔ مشتری وارد پاسخ نمی‌شود. پاسخ تضمین تأیید وام نیست، شماره تلفن تأییدنشده می‌ماند و بررسی دستی کارشناس همچنان لازم است.'
          : 'در حالت ثبت اطلاعات، CRM نام و نام خانوادگی، موبایل و درخواست را به‌ترتیب می‌پرسد. ثبت مشتری تنها پس از بررسی و تأیید کارشناس در همین صندوق انجام می‌شود.'}</li>
      </ol>
      <p>{setupMode === 'flow' ? 'در این روش هیچ توکن Public API لازم نیست. CRM پاسخ را آماده می‌کند، اما تحویل آن را فقط آزمون واقعی Flow ثابت می‌کند.' : 'تأیید توکن فقط دسترسی Public API را می‌سنجد.'} دریافت رویداد با کلید ارتباط به‌تنهایی منشأ اینستاگرامی را ثابت نمی‌کند. <a href="https://help.manychat.com/hc/en-us/articles/14281290924444-How-to-connect-Instagram-to-Manychat" target="_blank" rel="noreferrer">راهنمای اتصال رسمی</a></p>
    </details>
    <form className="manychat-fields" onSubmit={(event) => void save(event)} autoComplete="off">
      {setupMode === 'api' ? <label>توکن Public API حساب Manychat
        <input type="password" value={apiToken} onChange={(event) => setApiToken(event.target.value)} placeholder="توکن را از Settings → API وارد کنید" required minLength={16} autoComplete="new-password" data-testid="input-manychat-token" />
      </label> : null}
      <label>کلید مستقل ارتباط با CRM
        <span className="manychat-secret-row">
          <input type={showSecret ? 'text' : 'password'} dir="ltr" value={bridgeSecret} onChange={(event) => { setBridgeSecret(event.target.value); setMessage(''); setError(''); }} placeholder="حداقل ۲۴ کاراکتر" required minLength={24} autoComplete="new-password" data-testid="input-manychat-bridge" />
          <button type="button" onClick={() => setShowSecret((value) => !value)} aria-label={showSecret ? 'پنهان کردن کلید' : 'نمایش کلید'}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          <button type="button" onClick={() => void copySecret()} disabled={!bridgeSecret || pending} aria-label="کپی کلید مستقل" data-testid="button-copy-manychat-bridge"><Copy size={16} /> کپی</button>
        </span>
      </label>
      <div className="manychat-buttons">
        <button type="button" onClick={generateSecret} disabled={pending}>ساخت کلید امن</button>
        <button className="instagram-connect-button" type="submit" disabled={pending || (setupMode === 'api' && apiToken.length < 16) || bridgeSecret.length < 24}>
          {pending ? <LoaderCircle size={15} className="instagram-spinning" /> : <Check size={15} />} {setupMode === 'flow' ? 'ذخیرهٔ امن کلید ارتباط' : 'بررسی توکن و ذخیرهٔ امن'}
        </button>
      </div>
    </form>
    {status.source === 'database' && status.connected && !status.enabled ? <label className="manychat-confirmation">
      <input type="checkbox" checked={confirmedLiveDelivery} onChange={(event) => setConfirmedLiveDelivery(event.target.checked)} />
      تأیید می‌کنم دایرکت آزمایشی را در اینستاگرام و Manychat بررسی کرده‌ام و رویداد آن را در صندوق CRM می‌بینم.
    </label> : null}
    {status.configured ? <div className="manychat-buttons">
      <button type="button" disabled={pending} onClick={() => void run(() => action('check', {}), status.mode === 'flow'
        ? 'کلید ارتباط در CRM آماده است؛ دریافت واقعی دایرکت و تحویل Flow را جداگانه آزمایش کنید.'
        : 'توکن Public API معتبر است. دریافت دایرکت را جداگانه در صندوق بررسی کنید.')}>
        <RefreshCw size={14} /> {status.mode === 'flow' ? 'بررسی وضعیت ارتباط CRM' : 'بررسی دوبارهٔ توکن'}
      </button>
      {status.source === 'database' ? <button type="button" disabled={pending || (!status.enabled && (!status.connected || !confirmedLiveDelivery))}
        onClick={() => void run(() => action('autoreply', { enabled: !status.enabled, confirmedLiveDelivery }),
          status.enabled ? 'پاسخ‌های آماده‌نشده و تحویل‌داده‌نشده لغو شدند؛ Flow قبلاً آغازشده ممکن است تکمیل شود.' : 'آماده‌سازی پاسخ فعال شد. ارسال واقعی را با دایرکت دوم در Flow آزمایش کنید.')}>
        {status.enabled ? 'خاموش کردن پاسخ خودکار' : 'فعال کردن پاسخ خودکار'}
      </button> : null}
    </div> : null}
    {message ? <p className="instagram-connection-notice is-success" role="status">{message}</p> : null}
    {error ? <p className="instagram-connection-notice is-error" role="alert">{error}</p> : null}
  </div>;
}