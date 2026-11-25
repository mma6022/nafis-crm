// «مدیریت فروش» — ویرایش ربات بله‌ی کارشناس‌ها (flag.smc_bot_edit_v1).
// Reuses SMC primitives (Chip, Seg, Tgl, smc-dlg, smc-wbar, smc-mask) and the 3-step bot-connect wizard pattern.
import { useEffect, useRef, useState } from 'react';
import { smcApi, type ApiError, type SmcBotsState, type SmcExpertBot } from '../api';
import { c, fa, I, Chip, Seg, Tgl } from '../ui';

const initial = (n: string) => n.replace(/^(خانم|آقای) /, '').trim().slice(0, 1) || '؟';

type ExpertListProps = {
  state: SmcBotsState;
  canWrite: boolean;
  aiLive: boolean;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, auditId?: number | null) => void;
  onModeChange?: (userId: number, mode: 'own' | 'shared') => void;
  onAiChange?: (botId: number, ai: boolean) => void;
};

export function ExpertBotsList({
  state,
  canWrite,
  aiLive,
  onRefresh,
  onToast,
  onModeChange,
  onAiChange,
}: ExpertListProps) {
  const [editing, setEditing] = useState<SmcExpertBot | null>(null);

  return (
    <div className={c('bale')} data-testid="smc-bots-list">
      {!state.hasKey ? (
        <div className={c('mbanner warn')} role="alert">
          <I n="lock" />
          <span>کلید رمزنگاری توکن روی سرور نیست؛ تا مدیر فنی کلید را نگذارد، توکن تازه ذخیره نمی‌شود.</span>
        </div>
      ) : null}

      {state.experts.map((e) => {
        const b = e.bot;
        const hasTok = Boolean(b?.tokenSaved);
        const stChip = !b || !hasTok
          ? <Chip>وصل نیست</Chip>
          : b.status === 'err'
            ? <Chip k="r">خطای توکن</Chip>
            : e.paused
              ? <Chip k="g">موقتاً بی‌کار</Chip>
              : b.status === 'on'
                ? <Chip k="ok">وصل</Chip>
                : <Chip>غیرفعال</Chip>;

        return (
          <div
            key={e.userId}
            className={c('bcard')}
            data-testid={e.readonlySend ? `smc-bot-card-${e.userId}` : `sab-expert-${e.userId}`}
          >
            <div className={c('brow')}>
              <span className={c('av sm')} aria-hidden="true">{initial(e.name)}</span>
              <span className={c('bnm')}>
                <b>{e.name}</b>
                <span className={c('hint')}>
                  {b && hasTok ? (
                    <>
                      {b.name ? <>{b.name} · </> : null}
                      {b.username ? <span dir="ltr">@{b.username}</span> : 'شناسه ثبت‌شده'}
                      {e.paused ? ' · پاسخ از ربات مشترک' : ''}
                    </>
                  ) : (
                    'هنوز ربات اختصاصی وصل نشده'
                  )}
                </span>
              </span>
              <span className={c('bot-meta')}>
                {stChip}
                <Chip k={hasTok ? 'ok' : undefined}>
                  <I n="lock" />
                  توکن: {b?.tokenStatusLabel ?? 'ثبت نشده'}
                </Chip>
                {e.readonlySend ? <Chip k="lock">فقط پیام انتقال</Chip> : null}
              </span>
              <span className={c('sp')} />
              {state.sabEnabled && !e.readonlySend && onModeChange ? (
                <Seg
                  label={`ربات ${e.name}`}
                  value={e.mode}
                  options={[['own', 'ربات خودش'], ['shared', 'ربات مشترک']]}
                  onChange={(v) => {
                    if (canWrite && v !== e.mode) onModeChange(e.userId, v);
                  }}
                />
              ) : null}
              {state.sabEnabled && !e.readonlySend && e.mode === 'own' && b && hasTok && onAiChange ? (
                <Tgl
                  on={b.ai && aiLive}
                  disabled={!canWrite}
                  onClick={() => onAiChange(b.id, !b.ai)}
                >
                  هوش مصنوعی
                </Tgl>
              ) : null}
              {canWrite ? (
                <button
                  type="button"
                  className={c('btn', hasTok ? 'gh' : 'pri')}
                  data-testid={`smc-bot-edit-${e.userId}`}
                  onClick={() => setEditing(e)}
                >
                  <I n={hasTok ? 'edit' : 'plus'} />
                  {hasTok ? 'ویرایش ربات' : 'وصل کردن ربات'}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {editing ? (
        <BotEditWizard
          expert={editing}
          sabEnabled={state.sabEnabled}
          hasKey={state.hasKey}
          onClose={() => setEditing(null)}
          onSaved={async (msg, auditId) => {
            setEditing(null);
            await onRefresh();
            onToast(msg, auditId);
          }}
        />
      ) : null}
    </div>
  );
}

export function BotsSection({
  state,
  onRefresh,
  onToast,
}: {
  state: SmcBotsState;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, auditId?: number | null) => void;
}) {
  return (
    <div className={c('bale')} data-testid="smc-bots-section">
      <div className={c('mbanner ok')}>
        <I n="lock" />
        <span>تغییرات ربات‌ها بلافاصله ذخیره و در تاریخچه ثبت می‌شوند؛ توکن قبلی نمایش داده نمی‌شود و فقط به‌صورت «ثبت شده» قابل مشاهده است.</span>
      </div>
      <ExpertBotsList
        state={state}
        canWrite={true}
        aiLive={false}
        onRefresh={onRefresh}
        onToast={onToast}
      />
    </div>
  );
}

const WIZARD_STEPS = ['مشخصات و وضعیت', 'توکن ربات', 'بازبینی و ذخیره'] as const;

function BotEditWizard({
  expert,
  sabEnabled,
  hasKey,
  onClose,
  onSaved,
}: {
  expert: SmcExpertBot;
  sabEnabled: boolean;
  hasKey: boolean;
  onClose: () => void;
  onSaved: (msg: string, auditId?: number | null) => Promise<void>;
}) {
  const b = expert.bot;
  const hasSavedToken = Boolean(b?.tokenSaved);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [botName, setBotName] = useState(b?.name ?? '');
  const [status, setStatus] = useState<'on' | 'off'>(b?.status === 'off' ? 'off' : 'on');
  const [mode, setMode] = useState<'own' | 'shared'>(expert.mode);
  const [ai, setAi] = useState<boolean>(b?.ai ?? false);
  const [newToken, setNewToken] = useState('');
  const [testedNew, setTestedNew] = useState<{ name: string | null; username: string | null } | null>(null);
  const [testedSaved, setTestedSaved] = useState<{ name: string | null; username: string | null } | null>(null);
  const [askDisconnect, setAskDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dlgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dlgRef.current?.querySelector<HTMLInputElement | HTMLButtonElement>('input,button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const trimmedToken = newToken.trim();
  const tokenReady = hasSavedToken || trimmedToken.length > 0;

  const testCandidate = async () => {
    setErr(null);
    setTestedNew(null);
    setBusy(true);
    try {
      const r = await smcApi<{ ok: true; bot: { name: string | null; username: string | null } }>('/bots/test', {
        method: 'POST',
        body: { token: trimmedToken },
      });
      setTestedNew(r.bot);
      if (!botName.trim() && r.bot.name) setBotName(r.bot.name);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const testSaved = async () => {
    setErr(null);
    setTestedSaved(null);
    setBusy(true);
    try {
      const r = await smcApi<{ ok: true; bot: { name: string | null; username: string | null } }>(`/bots/${expert.userId}/test`, {
        method: 'POST',
        body: {},
      });
      setTestedSaved(r.bot);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await smcApi<{ auditId?: number }>(`/bots/${expert.userId}/disconnect`, { method: 'POST', body: {} });
      setNewToken('');
      await onSaved(`اتصال ربات ${expert.name} قطع شد.`, r.auditId ?? null);
    } catch (e) {
      setErr((e as ApiError).message);
      setBusy(false);
    }
  };

  const doSave = async () => {
    setErr(null);
    if (!hasSavedToken && !trimmedToken) {
      setErr('برای اتصال ربات تازه، ابتدا توکن ربات را در گام دوم وارد کنید.');
      setStep(2);
      return;
    }
    const cleanName = botName.trim();
    if (hasSavedToken && !cleanName) {
      setErr('نام نمایشی ربات نمی‌تواند خالی باشد.');
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        status,
        ...(cleanName ? { botName: cleanName } : {}),
        ...(trimmedToken ? { token: trimmedToken } : {}),
        ...(sabEnabled && !expert.readonlySend ? { mode } : {}),
        ...(sabEnabled && !expert.readonlySend && (hasSavedToken || trimmedToken) ? { ai } : {}),
      };
      const r = await smcApi<{ changed?: boolean; auditId?: number }>(`/bots/${expert.userId}`, {
        method: 'PUT',
        body: payload,
      });
      setNewToken('');
      await onSaved(
        r.changed === false ? 'چیزی عوض نشده بود.' : `تنظیمات ربات ${expert.name} ذخیره شد.`,
        r.changed === false ? null : (r.auditId ?? null),
      );
    } catch (e) {
      setErr((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className={c('scrim')} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div
        className={c('dlg', 'botdlg')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="smc-bot-wiz-title"
        data-testid="smc-bot-wizard"
        ref={dlgRef}
      >
        <div className={c('botdlg-hd')}>
          <div>
            <h3 id="smc-bot-wiz-title">{hasSavedToken ? `ویرایش ربات ${expert.name}` : `وصل کردن ربات ${expert.name}`}</h3>
            <p className={c('hint')}>
              {b?.username ? <span dir="ltr">@{b.username}</span> : 'ربات بله‌ی کارشناس'}
              {expert.readonlySend ? ' · فقط پیام انتقال' : ''}
            </p>
          </div>
          <button type="button" className={c('btn gh')} aria-label="بستن" disabled={busy} onClick={onClose}>
            <I n="x" />
          </button>
        </div>

        <div className={c('wbar')} role="tablist" aria-label="مراحل ویرایش ربات">
          {WIZARD_STEPS.map((label, idx) => {
            const n = (idx + 1) as 1 | 2 | 3;
            return (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={step === n}
                className={c(step === n ? 'on' : step > n ? 'done' : undefined)}
                onClick={() => { setErr(null); setStep(n); }}
                data-testid={`smc-bot-step-${n}`}
              >
                <span className={c('wn')}>{fa(n)}</span>
                {label}
              </button>
            );
          })}
        </div>

        {step === 1 ? (
          <div className={c('botdlg-body')} data-testid="smc-bot-pane-1">
            {expert.readonlySend ? (
              <div className={c('mbanner warn')}>
                <I n="lock" />
                <span>این ربات فقط برای پیام انتقال فعال است؛ ارسال عادی و خودکار برای مشتریان از این ربات بسته می‌ماند.</span>
              </div>
            ) : null}

            <label className={c('bot-fld')}>
              <span className={c('lbl')}>نام نمایشی ربات</span>
              <input
                className={c('inp')}
                type="text"
                maxLength={80}
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                placeholder={hasSavedToken ? 'نام نمایشی ربات در سامانه' : 'اختیاری — از بله خوانده می‌شود'}
                data-testid="smc-bot-name-input"
              />
            </label>

            <div className={c('bot-fld')}>
              <span className={c('lbl')}>وضعیت ربات</span>
              <Seg
                label="وضعیت ربات"
                value={status}
                options={[['on', 'فعال (وصل)'], ['off', 'غیرفعال (قطع موقت)']]}
                onChange={(v) => {
                  if (!tokenReady && v === 'on') return;
                  setStatus(v);
                }}
              />
              {!tokenReady ? <span className={c('hint')}>برای فعال‌سازی، توکن را در گام دوم وارد کنید.</span> : null}
            </div>

            {sabEnabled && !expert.readonlySend ? (
              <div className={c('bot-fld')}>
                <span className={c('lbl')}>حالت پاسخگویی</span>
                <Seg<'own' | 'shared'>
                  label="حالت پاسخگویی"
                  value={mode}
                  options={[['own', 'ربات خودش'], ['shared', 'ربات مشترک']]}
                  onChange={(v) => setMode(v)}
                />
              </div>
            ) : null}

            {sabEnabled && !expert.readonlySend && tokenReady ? (
              <div className={c('bot-fld')}>
                <Tgl on={ai} onClick={() => setAi(!ai)}>پاسخ هوش مصنوعی این ربات</Tgl>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className={c('botdlg-body')} data-testid="smc-bot-pane-2">
            <div className={c('bot-tokrow')}>
              <span className={c('lbl')}>وضعیت توکن فعلی</span>
              <Chip k={hasSavedToken ? 'ok' : undefined}>
                <I n="lock" />
                {hasSavedToken ? 'ثبت شده' : 'ثبت نشده'}
              </Chip>
              {hasSavedToken ? (
                <button
                  type="button"
                  className={c('btn gh')}
                  disabled={busy}
                  onClick={() => void testSaved()}
                  data-testid="smc-bot-test-saved"
                >
                  <I n="rf" />
                  آزمایش اتصال فعلی
                </button>
              ) : null}
            </div>

            {testedSaved ? (
              <div className={c('mbanner ok')} data-testid="smc-bot-test-saved-ok">
                <span>اتصال برقرار است{testedSaved.username ? ` (@${testedSaved.username})` : ''}.</span>
              </div>
            ) : null}

            {hasSavedToken ? (
              <p className={c('hint')}>
                توکن فعلی رمزنگاری‌شده نگهداری می‌شود و به مرورگر فرستاده نمی‌شود. اگر نمی‌خواهید توکن را عوض کنید، کادر زیر را خالی بگذارید.
              </p>
            ) : null}

            <div className={c('bot-fld')}>
              <label className={c('bot-fld')}>
                <span className={c('lbl')}>{hasSavedToken ? 'توکن تازه (اختیاری)' : 'توکن ربات (از @botfather)'}</span>
                <input
                  className={c('inp mask')}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore=""
                  data-lpignore="true"
                  dir="ltr"
                  value={newToken}
                  onChange={(e) => { setNewToken(e.target.value); setTestedNew(null); }}
                  placeholder={hasSavedToken ? 'برای تعویض توکن، توکن جدید را بچسبانید' : '123456789:AAAA...'}
                  data-testid="smc-bot-token-input"
                />
              </label>
              <div className={c('row1')}>
                <button
                  type="button"
                  className={c('btn gh')}
                  disabled={busy || trimmedToken.length < 8}
                  onClick={() => void testCandidate()}
                  data-testid="smc-bot-test-new"
                >
                  <I n="rf" />
                  آزمایش توکن تازه
                </button>
                {!hasKey ? <span className={c('hint')}>کلید رمزنگاری روی سرور نیست.</span> : null}
              </div>
            </div>

            {testedNew ? (
              <div className={c('mbanner ok')} data-testid="smc-bot-test-new-ok">
                <span>توکن معتبر است: {testedNew.name ?? 'ربات'} {testedNew.username ? `(@${testedNew.username})` : ''}</span>
              </div>
            ) : null}

            {hasSavedToken ? (
              <div className={c('bot-danger')}>
                {!askDisconnect ? (
                  <button
                    type="button"
                    className={c('btn gh')}
                    disabled={busy}
                    onClick={() => setAskDisconnect(true)}
                    data-testid="smc-bot-disconnect-ask"
                  >
                    قطع اتصال ربات
                  </button>
                ) : (
                  <div className={c('bcard ask')}>
                    <b>اتصال ربات {expert.name} قطع شود؟</b>
                    <span className={c('hint')}>گفتگوهای قبلی حذف نمی‌شوند؛ توکن فعلی پاک می‌شود و ربات خاموش می‌ماند.</span>
                    <div className={c('row1')}>
                      <button type="button" className={c('btn gh')} disabled={busy} onClick={() => setAskDisconnect(false)}>انصراف</button>
                      <button
                        type="button"
                        className={c('btn pri')}
                        disabled={busy}
                        onClick={() => void doDisconnect()}
                        data-testid="smc-bot-disconnect-confirm"
                      >
                        بله، قطع شود
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className={c('botdlg-body')} data-testid="smc-bot-pane-3">
            <div className={c('rvw')}>
              <div className={c('rvw-row')}>
                <span>کارشناس</span>
                <b>{expert.name}</b>
              </div>
              <div className={c('rvw-row')}>
                <span>نام نمایشی ربات</span>
                <b>{botName.trim() || testedNew?.name || 'از مشخصات ربات در بله'}</b>
              </div>
              <div className={c('rvw-row')}>
                <span>وضعیت ربات</span>
                <b>{status === 'on' ? 'فعال (وصل)' : 'غیرفعال (قطع موقت)'}</b>
              </div>
              {sabEnabled && !expert.readonlySend ? (
                <>
                  <div className={c('rvw-row')}>
                    <span>حالت پاسخگویی</span>
                    <b>{mode === 'own' ? 'ربات خودش' : 'ربات مشترک'}</b>
                  </div>
                  <div className={c('rvw-row')}>
                    <span>پاسخ هوش مصنوعی</span>
                    <b>{ai ? 'روشن' : 'خاموش'}</b>
                  </div>
                </>
              ) : null}
              <div className={c('rvw-row')}>
                <span>توکن ربات</span>
                <b>
                  {trimmedToken
                    ? `توکن تازه جایگزین می‌شود${testedNew?.username ? ` (@${testedNew.username})` : ''}`
                    : hasSavedToken
                      ? 'بدون تغییر (ثبت شده)'
                      : 'وارد نشده'}
                </b>
              </div>
            </div>
            <p className={c('hint')}>این تغییر در تاریخچه ثبت می‌شود و ارتباط شخصی بله را قطع نمی‌کند.</p>
          </div>
        ) : null}

        {err ? <p className={c('err')} role="alert" data-testid="smc-bot-err">{err}</p> : null}

        <div className={c('row1', 'botdlg-ft')}>
          <button type="button" className={c('btn gh')} disabled={busy} onClick={onClose}>انصراف</button>
          <span className={c('sp')} />
          {step > 1 ? (
            <button type="button" className={c('btn gh')} disabled={busy} onClick={() => { setErr(null); setStep((step - 1) as 1 | 2); }}>
              قبلی
            </button>
          ) : null}
          {step < 3 ? (
            <button
              type="button"
              className={c('btn pri')}
              disabled={busy}
              onClick={() => { setErr(null); setStep((step + 1) as 2 | 3); }}
              data-testid="smc-bot-next"
            >
              بعدی
            </button>
          ) : (
            <button
              type="button"
              className={c('btn pri')}
              disabled={busy || (!hasSavedToken && !trimmedToken)}
              onClick={() => void doSave()}
              data-testid="smc-bot-save"
            >
              {busy ? 'در حال ذخیره…' : 'ذخیره تغییرات'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
