// «مدیریت فروش» v1.3 §9 — ربات‌های بله و پیام‌ها (bale-voice-v1.3.md §3; Mohammad t358s1326). Only while flag.sales_admin_bale_v13 + console flags are ON.
// Ghasemi's read-only bot never appears here (server filters it). Tokens / keys: masked text field (no password field), cleared after save, never shown again.
import { useState, type ReactNode } from 'react';
import type { BaleState, QuickMessage, ViewLevel } from '../api';
import { c, fa, I, Chip, Seg, Tgl } from '../ui';

export type BaleAct = (path: string, method: 'PUT' | 'POST', body: unknown, okMsg: string) => Promise<boolean>;
const LV: [ViewLevel, string][] = [['own', 'فقط خودش'], ['all', 'همه'], ['none', 'هیچ']];
const STEPS: [string, string, string][] = [
  ['اشتراک شماره', 'شروع', 'مشتری ربات را شروع می‌کند؛ تا شماره را با دکمه‌ی اشتراک یا ورود دستی نفرستد، ربات همان درخواست را تکرار می‌کند و کار دیگری انجام نمی‌شود.'],
  ['تشخیص مشتری', 'بعد از اشتراک', 'شماره با پرونده‌ها تطبیق داده می‌شود.'],
  ['تقسیم یا وصل', 'تقسیم یا وصل', 'لید تازه با قوانین تقسیم مشتری ورودی می‌رود؛ مشتری یا پیگیری موجود به کارشناس خودش وصل و در صندوق همان کارشناس دیده می‌شود.'],
];
const initial = (n: string) => n.replace(/^(خانم|آقای) /, '').trim().slice(0, 1) || '؟';
const H = ({ children }: { children: ReactNode }) => <h3 className={c('bh3')}>{children}</h3>;

/** Masked secret input: a text field with CSS masking (never type=password), no autofill, emptied after save. */
function Secret({ label, onSave, busy, hint }: { label: string; onSave: (v: string) => Promise<boolean>; busy?: boolean; hint?: string }) {
  const [v, setV] = useState('');
  return (
    <div className={c('secret')}>
      <label className={c('lbl')}>{label}
        <input className={c('inp mask')} type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="" data-lpignore="true"
          dir="ltr" value={v} onChange={(e) => setV(e.target.value)} aria-label={label} data-testid="sab-secret" />
      </label>
      {hint ? <span className={c('hint')}>{hint}</span> : null}
      <button className={c('btn pri')} type="button" disabled={busy || v.trim().length < 8} onClick={async () => { const s = v.trim(); setV(''); await onSave(s); }}>ذخیره</button>
    </div>
  );
}

export function BaleSection({ bs, act }: { bs: BaleState; act: BaleAct }) {
  const b = bs.bots; const can = bs.canWrite;
  const [step, setStep] = useState(0);
  const [connect, setConnect] = useState<number | 'new' | null>(null);
  const [pickUser, setPickUser] = useState<number | null>(null);
  const [askAll, setAskAll] = useState(false);
  const [keyForm, setKeyForm] = useState(false);
  const noBot = b.experts.filter((e) => !e.bot);
  const doConnect = async (userId: number, token: string) => { if (await act('/bale/bots/connect', 'POST', { userId, token }, 'ربات وصل شد؛ توکن ذخیره شده و دیگر دیده نمی‌شود. پاسخ هوش مصنوعی این ربات خاموش است.')) setConnect(null); return true; };
  return (
    <div className={c('bale')} data-testid="sab-bale">
      <H>ربات‌ها</H>
      {b.shared ? (
        <div className={c('bcard shared')} data-testid="sab-shared">
          <div className={c('brow')}>
            <span className={c('bnm')}><span className={c('lbl')}>ربات مشترک</span><b>{b.shared.name}</b>{b.shared.username ? <span className={c('hint')} dir="ltr">@{b.shared.username}</span> : null}
              {b.shared.hasToken ? <Chip k="ok">وصل</Chip> : <Chip>وصل نیست</Chip>}</span>
            <span className={c('sp')} />
            <Tgl on={b.shared.ai && b.aiLive} disabled={!can || !b.shared.hasToken} onClick={() => void act('/bale/ai', 'PUT', { botId: b.shared!.id, on: !b.shared!.ai }, b.shared!.ai ? 'پاسخ هوش مصنوعی ربات مشترک خاموش شد.' : 'پاسخ هوش مصنوعی ربات مشترک روشن شد.')}>پاسخ هوش مصنوعی</Tgl>
          </div>
          <div className={c('wiz')} role="group" aria-label="جریان اشتراک شماره در ربات مشترک">
            <div className={c('wbar')} role="tablist">
              {STEPS.map(([t], i) => <button key={t} type="button" role="tab" aria-selected={i === step} className={c(i === step && 'on', i < step && 'done')} onClick={() => setStep(i)}><span className={c('wn')}>{fa(i + 1)}</span>{t}</button>)}
            </div>
            <div className={c('wbody')} role="tabpanel"><b>{STEPS[step]![1]}</b><p>{STEPS[step]![2]}</p></div>
            {!b.contactFlow.forced ? <p className={c('hint')}>جریان اشتراک شماره در سامانه هنوز روشن نیست.</p> : null}
          </div>
        </div>
      ) : null}
      {b.experts.map((e) => (
        <div key={e.userId} className={c('bcard')} data-testid={`sab-expert-${e.userId}`}>
          <div className={c('brow')}>
            <span className={c('av sm')} aria-hidden="true">{initial(e.name)}</span>
            <span className={c('bnm')}><b>{e.name}</b>
              <span className={c('hint')}>{e.mode === 'own' ? (e.bot ? <><span dir="ltr">@{e.bot.username ?? '—'}</span> · {e.bot.status === 'on' ? 'وصل' : 'قطع'}</> : 'ربات خودش وصل نیست') : e.paused ? 'از ربات مشترک؛ ربات خودش موقتاً بی‌کار است' : 'از ربات مشترک'}</span></span>
            <span className={c('sp')} />
            <Seg label={`ربات ${e.name}`} value={e.mode} options={[['own', 'ربات خودش'], ['shared', 'ربات مشترک']]}
              onChange={(v) => { if (can && v !== e.mode) void act('/bale/mode', 'PUT', { userId: e.userId, mode: v }, v === 'shared' ? `${e.name} از ربات مشترک جواب می‌گیرد.` : `${e.name} با ربات خودش کار می‌کند.`); }} />
            {e.mode === 'own' && e.bot ? <Tgl on={e.bot.ai && b.aiLive} disabled={!can} onClick={() => void act('/bale/ai', 'PUT', { botId: e.bot!.id, on: !e.bot!.ai }, `پاسخ هوش مصنوعی ربات ${e.name} ${e.bot!.ai ? 'خاموش' : 'روشن'} شد.`)}>هوش مصنوعی</Tgl> : null}
            {e.mode === 'own' && !e.bot && can ? <button className={c('btn gh')} type="button" data-testid={`sab-connect-${e.userId}`} disabled={!b.canConnect} onClick={() => setConnect(connect === e.userId ? null : e.userId)}>وصل کردن ربات</button> : null}
          </div>
          {connect === e.userId ? <Secret label={`توکن ربات ${e.name} (از @botfather)`} hint="فقط یک‌بار وارد می‌شود و بعد از ذخیره دیده نمی‌شود." onSave={(t) => doConnect(e.userId, t)} /> : null}
        </div>
      ))}
      {can ? (
        <div className={c('row1 bact')}>
          <button className={c('btn dash')} type="button" disabled={!noBot.length || !b.canConnect} onClick={() => { setConnect(connect === 'new' ? null : 'new'); setPickUser(noBot[0]?.userId ?? null); }}><I n="plus" />ربات تازه</button>
          <button className={c('btn lk')} type="button" onClick={() => setAskAll(true)}><I n="copy" />یکسان برای همه: ربات مشترک</button>
        </div>
      ) : null}
      {connect === 'new' ? (
        <div className={c('bcard')}>
          <div className={c('picks')} role="radiogroup" aria-label="ربات تازه برای">
            {noBot.map((e) => <button key={e.userId} type="button" role="radio" aria-checked={pickUser === e.userId} className={c('pick', pickUser === e.userId && 'on')} onClick={() => setPickUser(e.userId)}>{e.name}</button>)}
          </div>
          {pickUser ? <Secret label="توکن ربات (از @botfather)" hint="فقط یک‌بار وارد می‌شود و بعد از ذخیره دیده نمی‌شود." onSave={(t) => doConnect(pickUser, t)} /> : null}
        </div>
      ) : null}
      {askAll ? (
        <div className={c('bcard ask')} role="alertdialog" data-nodnd="" aria-label="یکسان برای همه">
          <b>همه‌ی کارشناس‌ها از ربات مشترک جواب بگیرند؟</b>
          <p className={c('hint')}>ربات‌های شخصی وصل‌شده قطع نمی‌شوند و توکنشان می‌ماند؛ فقط تا برگرداندن بی‌کار می‌مانند. در «تاریخچه» با «برگرداندن» ثبت می‌شود.</p>
          <div className={c('row1')}><button className={c('btn gh')} type="button" onClick={() => setAskAll(false)}>انصراف</button>
            <button className={c('btn pri')} type="button" onClick={async () => { await act('/bale/mode', 'PUT', { all: true, mode: 'shared' }, 'همه از ربات مشترک جواب می‌گیرند.'); setAskAll(false); }}>بله، همه ربات مشترک</button></div>
        </div>
      ) : null}
      <div className={c('bcard')} data-testid="sab-key">
        <div className={c('brow')}>
          <span className={c('bnm')}><span className={c('lbl')}>کلید OpenAI و پایگاه دانش</span>
            <b>{b.openai.set ? 'کلید ذخیره شده' : 'کلیدی ثبت نشده'}</b>{b.openai.savedAt ? <span className={c('hint')}>{whenFa(b.openai.savedAt)}</span> : null}</span>
          <span className={c('sp')} />
          {can ? <button className={c('btn gh')} type="button" onClick={() => setKeyForm(!keyForm)}>کلید تازه</button> : null}
        </div>
        {keyForm ? <Secret label="کلید تازه‌ی OpenAI" hint="بعد از ذخیره نشان داده نمی‌شود." onSave={async (v) => { const ok = await act('/bale/key', 'POST', { value: v }, 'کلید ذخیره شد و دیگر نشان داده نمی‌شود.'); if (ok) setKeyForm(false); return ok; }} /> : null}
        {!b.aiMaster ? <p className={c('hint')}>سوییچ اصلی هوش مصنوعی خاموش است؛ هیچ رباتی پاسخ خودکار نمی‌دهد.</p> : null}
      </div>

      <H>دیدن پیام‌های بله</H>
      <ViewTable bs={bs} act={act} />
      <p className={c('hint')}>اگر «هیچ» باشد، «گفتگوهای بله» برایش دیده نمی‌شود؛ تخصیص مشتری سر جایش می‌ماند و کسانی که «همه» دارند همچنان گفتگو را می‌بینند.</p>

      <H>پیام‌های پیش‌فرض</H>
      <QuickList items={bs.quick} can={can} act={act} />

      <H>پیش‌نمایش گفتگو</H>
      <ChatPreview items={bs.quick} />
    </div>
  );
}

function ViewTable({ bs, act }: { bs: BaleState; act: BaleAct }) {
  const can = bs.canWrite; const v = bs.view;
  const [teamAsk, setTeamAsk] = useState<number | null>(null);
  const setUser = (id: number, name: string, lv: ViewLevel) => void act('/bale/view', 'PUT', { scope: 'user', id, level: lv }, `دید بله‌ی ${name}: ${LV.find((x) => x[0] === lv)![1]}`);
  const Person = ({ r }: { r: BaleState['view']['others'][number] }) => (
    <div className={c('vrow')} data-testid={`sab-view-${r.userId}`}>
      <span className={c('vnm')}>{r.name}{!r.baleOn ? <span className={c('hint')}> · بله برایش روشن نیست</span> : null}</span>
      <Seg label={`سطح دید ${r.name}`} value={r.effective} options={LV} onChange={(lv) => { if (can && lv !== r.effective) setUser(r.userId, r.name, lv); }} />
    </div>
  );
  return (
    <div className={c('vtab')} role="table" aria-label="سطح دید پیام‌های بله">
      <div className={c('vrow vhead')} role="row"><span>فرد یا تیم</span><span>سطح دید</span></div>
      <div className={c('vrow vgrp')}>
        <span className={c('vnm')}><b>مدیر فروش و ادمین</b></span>
        <Seg label="سطح دید مدیر فروش و ادمین" value={v.managers.level} options={LV} onChange={(lv) => { if (can && lv !== v.managers.level) void act('/bale/view', 'PUT', { scope: 'managers', level: lv }, `دید بله‌ی مدیر فروش و ادمین: ${LV.find((x) => x[0] === lv)![1]}`); }} />
      </div>
      {v.teams.map((t) => (
        <div key={t.id}>
          <div className={c('vrow vteam')}>
            <span className={c('vnm')}><b>{t.name}</b><span className={c('hint')}> · {fa(t.members.length)} کارشناس</span></span>
            {can ? <button className={c('btn lk')} type="button" aria-expanded={teamAsk === t.id} onClick={() => setTeamAsk(teamAsk === t.id ? null : t.id)}><I n="copy" />یکسان برای همه‌ی تیم…</button> : null}
          </div>
          {teamAsk === t.id ? (
            <div className={c('vrow vpick')}>
              <span className={c('hint')}>برای همه‌ی {t.name}:</span>
              <Seg label={`سطح دید ${t.name}`} value={t.level ?? 'own'} options={LV} onChange={async (lv) => { await act('/bale/view', 'PUT', { scope: 'team', id: t.id, level: lv, applyMembers: true }, `دید بله‌ی ${t.name}: ${LV.find((x) => x[0] === lv)![1]} (همه‌ی اعضا)`); setTeamAsk(null); }} />
            </div>
          ) : null}
          {t.members.map((r) => <Person key={r.userId} r={r} />)}
        </div>
      ))}
      {v.others.length ? <div className={c('vrow vteam')}><span className={c('vnm')}><b>بدون تیم</b></span></div> : null}
      {v.others.map((r) => <Person key={r.userId} r={r} />)}
    </div>
  );
}

function QuickList({ items, can, act }: { items: QuickMessage[]; can: boolean; act: BaleAct }) {
  const [ed, setEd] = useState<{ i: number; title: string; body: string } | null>(null);
  const save = (next: QuickMessage[], msg: string) => act('/bale/quick', 'PUT', { items: next }, msg);
  const move = (i: number, d: number) => { const n = [...items]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); void save(n, 'ترتیب پیام‌ها ذخیره شد.'); };
  return (
    <div className={c('qlist')} data-testid="sab-quick">
      {items.length === 0 && !ed ? <p className={c('hint')}>هنوز پیامی ساخته نشده است.</p> : null}
      {items.map((q, i) => ed?.i === i ? <QForm key={q.id} ed={ed} setEd={setEd} onSave={async () => { const n = [...items]; n[i] = { ...q, title: ed.title, body: ed.body }; if (await save(n, 'پیام ذخیره شد.')) setEd(null); }} /> : (
        <div key={q.id} className={c('qitem')}>
          <div className={c('qtx')}><b>{q.title}</b><p>{q.body}</p></div>
          {can ? <span className={c('qact')}>
            <button className={c('btn gh ib')} type="button" aria-label={`ویرایش ${q.title}`} onClick={() => setEd({ i, title: q.title, body: q.body })}><I n="edit" /></button>
            <button className={c('btn gh ib')} type="button" aria-label={`پایین بردن ${q.title}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}><I n="down" /></button>
            <button className={c('btn gh ib')} type="button" aria-label={`بالا بردن ${q.title}`} disabled={i === 0} onClick={() => move(i, -1)}><I n="up" /></button>
            <button className={c('btn gh ib bad')} type="button" aria-label={`حذف ${q.title}`} onClick={() => void save(items.filter((_, j) => j !== i), `«${q.title}» حذف شد.`)}><I n="trash" /></button>
          </span> : null}
        </div>
      ))}
      {ed && ed.i === -1 ? <QForm ed={ed} setEd={setEd} onSave={async () => { if (await save([...items, { id: '', title: ed.title, body: ed.body }], 'پیام تازه ذخیره شد.')) setEd(null); }} /> : null}
      {can && !ed && items.length < 12 ? <button className={c('btn dash')} type="button" data-testid="sab-quick-new" onClick={() => setEd({ i: -1, title: '', body: '' })}><I n="plus" />پیام تازه</button> : null}
    </div>
  );
}
function QForm({ ed, setEd, onSave }: { ed: { i: number; title: string; body: string }; setEd: (e: { i: number; title: string; body: string } | null) => void; onSave: () => void }) {
  return (
    <div className={c('qitem editing')}>
      <label className={c('lbl')}>عنوان<input className={c('inp')} value={ed.title} maxLength={40} onChange={(e) => setEd({ ...ed, title: e.target.value })} /></label>
      <label className={c('lbl')}>متن<textarea className={c('inp ta')} value={ed.body} maxLength={1000} onChange={(e) => setEd({ ...ed, body: e.target.value })} /></label>
      <div className={c('row1')}><button className={c('btn gh')} type="button" onClick={() => setEd(null)}>لغو</button>
        <button className={c('btn pri')} type="button" disabled={!ed.title.trim() || !ed.body.trim()} onClick={onSave}>ذخیره</button></div>
    </div>
  );
}
/** Static preview of a shared-bot chat (sample, not a real customer) with the canned-message bar as experts see it. */
function ChatPreview({ items }: { items: QuickMessage[] }) {
  return (
    <div className={c('bchat')} aria-label="پیش‌نمایش (نمونه)">
      <div className={c('bchd')}><span className={c('av sm')} aria-hidden="true">س</span><span className={c('bnm')}><b>مشتری نمونه</b><span className={c('hint')}>کارشناس: خانم حسنی · ربات مشترک</span></span></div>
      <div className={c('bmsgs')}>
        <p className={c('bm in')}>سلام، برای وام پیام دادم</p>
        <p className={c('bm out')}><span className={c('lbl')}>پاسخ خودکار</span>سلام، برای ادامه لطفاً شماره‌تان را با دکمه بفرستید یا دستی بنویسید.</p>
        <p className={c('bm in')}>شماره اشتراک شد</p>
        <p className={c('bsys')}>به خانم حسنی وصل شد. لید تازه ساخته نشد.</p>
      </div>
      {items.length ? <div className={c('qbar')} aria-hidden="true">{items.map((q) => <span key={q.id} className={c('qchip')}>{q.title}</span>)}</div> : null}
      <div className={c('bcomp')} aria-hidden="true"><span className={c('bplus')}>+</span><span className={c('binp')}>پیام بنویسید</span><span className={c('bsend')}>ارسال</span></div>
    </div>
  );
}
export const whenFa = (iso: string) => { try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: 'Asia/Tehran' }).format(new Date(iso)); } catch { return ''; } };
