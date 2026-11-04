/* bale v1.1: «ربات‌های بله» (admin + sales manager). The token lives only in a masked field until «تست اتصال»/«ذخیره»;
   the server seals it with AES-256-GCM and never returns it — this page can only show «توکن ذخیره شده». */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import './bale-bot.css';
import { bbFetch, BbError, useBaleBotMe, fa, type BbAdminExpert, type BbBot } from './api';
import { I, Uname, useToast, Steps, Modal, Confirm } from './ui';

const ST: Record<string, [string, string, string]> = { on: ['chip s', 'check', 'وصل'], off: ['chip', 'x', 'قطع'], err: ['chip r', 'alert', 'خطای توکن'] };
const since = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tehran' }) : '');
const BOTST = ['کارشناس', 'توکن', 'تست اتصال'];
type Admin = { hasKey: boolean; noSend: number[]; experts: BbAdminExpert[] };
type W = null | { k: 'wiz'; s: number; userId: number | null; replace: boolean } | { k: 'saved'; e: BbAdminExpert } | { k: 'off'; e: BbAdminExpert };

export default function BaleBotAdmin() {
  const meQ = useBaleBotMe(); const me = meQ.data; const [, nav] = useLocation();
  useEffect(() => { document.title = 'ربات‌های بله | نفیس وام'; }, []);
  if (meQ.isLoading) return <div className="bbt" dir="rtl"><main className="pg bbpg"><span className="bbsk" /></main></div>;
  if (!me) { nav('/'); return null; }
  if (!me.canManage) return <div className="bbt" dir="rtl" data-testid="bale-bot-no-access"><main className="pg bbpg"><section className="card na"><div className="ci"><I n="lock" /></div><b>این بخش برای مدیر سیستم است</b>
    <p>وصل و قطع ربات‌های بله با مدیر سیستم است. گفتگوهای ربات خودتان در «گفتگوهای بله» است.</p>{me.bot?.username ? <p className="ltr" dir="ltr">@{me.bot.username}</p> : null}
    <Link className="btn pri" href="/bale-bot"><I n="chat" />گفتگوهای بله‌ی من</Link></section></main></div>;
  return <AdminPage />;
}

function AdminPage() {
  const qc = useQueryClient(); const { toast, node } = useToast();
  const q = useQuery<Admin>({ queryKey: ['bb-admin'], queryFn: () => bbFetch('/bale-bot/admin/bots') });
  const [w, setW] = useState<W>(null); const [fresh, setFresh] = useState<number | null>(null);
  const reload = () => { void qc.invalidateQueries({ queryKey: ['bb-admin'] }); void qc.invalidateQueries({ queryKey: ['bale-bot-me'] }); };
  const ex = q.data?.experts ?? [];
  return <div className="bbt" dir="rtl" data-testid="bale-bot-admin"><main className="pg bbpg">
    <div className="ahd"><h2>ربات‌های بله</h2><span className="sp" /><button className="btn pri" type="button" onClick={() => setW({ k: 'wiz', s: 1, userId: null, replace: false })}><I n="plus" />وصل کردن ربات</button>
      <p>هر کارشناس ربات بله‌ی خودش را دارد. مشتری به ربات پیام می‌دهد و کارشناس از داخل CRM جواب می‌دهد.</p></div>
    {q.data && !q.data.hasKey ? <div className="offb top" role="alert"><I n="alert" /><div><b>کلید رمزنگاری روی سرور نیست</b><span>تا مدیر فنی کلید را نگذارد، توکن ذخیره نمی‌شود.</span></div></div> : null}
    <section className="card" aria-label="ربات‌ها"><ul className="brl">{q.isLoading ? <span className="bbsk" /> : ex.length ? ex.map((e) => {
      const b = e.bot; const st = b?.status ?? 'off'; const [cl, ic, t] = ST[st] ?? ST.off;
      return <li key={e.id} className={`br${fresh === e.id ? ' new' : ''}`}><span className="ava c2" aria-hidden="true">{e.name.trim()[0]}</span>
        <div className="tx"><b>{e.name}</b>{b && b.hasToken ? <><span className="u">@{b.username}</span><span className="m">{b.name}، وصل از {since(b.connectedAt)}</span></> : <span className="m">ربات وصل نیست</span>}
          {!e.flagOn ? <span className="m">صندوق بله برای این کارشناس هنوز روشن نشده است.</span> : null}</div>
        <div className="stc"><span className={cl}><I n={ic} />{t}</span>{b?.hasToken ? <span className="tsv"><I n="lock" />توکن ذخیره شده</span> : null}</div>
        <div className="ac">{st === 'on' && b?.hasToken ? <><button className="btn gh sm" type="button" onClick={() => setW({ k: 'saved', e })}><I n="shield" />تنظیمات</button><button className="btn lk sm" type="button" onClick={() => setW({ k: 'off', e })}>قطع اتصال</button></>
          : st === 'err' && b?.hasToken ? <><button className="btn pri sm" type="button" onClick={() => setW({ k: 'wiz', s: 2, userId: e.id, replace: true })}><I n="refresh" />تعویض توکن</button><button className="btn lk sm" type="button" onClick={() => setW({ k: 'off', e })}>قطع اتصال</button></>
          : <button className="btn pri sm" type="button" onClick={() => setW({ k: 'wiz', s: 2, userId: e.id, replace: false })}><I n="plus" />وصل کردن ربات</button>}</div>
        {st === 'err' && b?.hasToken ? <p className="er"><I n="alert" />بله این توکن را دیگر قبول نمی‌کند. پیام‌های تازه فقط ۲۴ ساعت روی بله می‌ماند؛ زود توکن تازه بگذارید.</p> : null}</li>; })
      : <li className="br"><span /><div className="tx"><span className="m">کارشناس فروشی پیدا نشد.</span></div></li>}</ul></section>
    <section className="card howc"><b>ساختن ربات برای کارشناس تازه</b><ol><li>کارشناس در بله به <Uname u="botfather" /> پیام می‌دهد و ربات تازه می‌سازد.</li><li>توکنی که <Uname u="botfather" /> می‌دهد را فقط این‌جا در «وصل کردن ربات» می‌گذارید.</li><li>لینک ربات را کارشناس به مشتری‌هایش می‌دهد؛ گفتگو با /start مشتری شروع می‌شود.</li></ol></section>
  </main>
  {w?.k === 'wiz' ? <BotWizard experts={ex} init={w} close={() => setW(null)} toast={toast} done={(e) => { setW(null); setFresh(e.id); toast(`ربات ${e.name} وصل شد؛ پیام‌ها از همین حالا می‌رسد.`); reload(); }} /> : null}
  {w?.k === 'saved' ? <Saved e={w.e} close={() => setW(null)} toast={toast} reload={reload} onReplace={() => setW({ k: 'wiz', s: 2, userId: w.e.id, replace: true })} onOff={() => setW({ k: 'off', e: w.e })} /> : null}
  {w?.k === 'off' ? <Confirm title={`اتصال ربات ${w.e.name} قطع شود؟`} items={['توکن از CRM پاک می‌شود. باطل کردن خود توکن فقط در @botfather بله ممکن است.', 'گفتگوهای قبلی در CRM می‌ماند.', 'پیام‌هایی که بعد از قطع برسد فقط ۲۴ ساعت روی بله می‌ماند؛ بعد از آن به CRM نمی‌آید.']}
    foot={<><button className="btn dng" type="button" onClick={async () => { const e = w.e; setW(null); try { await bbFetch(`/bale-bot/admin/bots/${e.bot!.id}/disconnect`, { body: {} }); toast('اتصال ربات قطع شد'); reload(); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } }}>قطع اتصال</button><button className="btn gh" type="button" onClick={() => setW(null)}>انصراف</button></>} /> : null}
  {node}</div>;
}

function BotWizard({ experts, init, close, toast, done }: { experts: BbAdminExpert[]; init: { s: number; userId: number | null; replace: boolean }; close: () => void; toast: (t: string) => void; done: (e: BbAdminExpert) => void }) {
  const [s, setS] = useState(init.userId ? init.s : 1); const [uid, setUid] = useState<number | null>(init.userId);
  const [tok, setTok] = useState(''); const [er, setEr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<{ name: string | null; username: string | null } | null>(null);
  const e = experts.find((x) => x.id === uid) ?? null; const replace = init.replace || !!e?.bot?.hasToken;
  useEffect(() => () => setTok(''), []);
  const test = async () => { if (!tok.trim()) { setEr('bad_token'); return; } setBusy(true); setEr(null);
    try { const r = await bbFetch<{ bot: { name: string | null; username: string | null } }>('/bale-bot/admin/test', { body: { token: tok.trim() } }); setBot(r.bot); setS(3); } catch (x) { setEr(x instanceof BbError ? x.code ?? 'unknown' : 'unknown'); } finally { setBusy(false); } };
  const save = async () => { if (!e) return; setBusy(true);
    try { await bbFetch('/bale-bot/admin/bots', { body: { userId: e.id, token: tok.trim(), replace } }); setTok(''); done(e); } catch (x) { setEr(x instanceof BbError ? x.code ?? 'unknown' : 'unknown'); setS(2); toast(x instanceof BbError ? x.message : 'انجام نشد.'); } finally { setBusy(false); } };
  const errText = (c: string) => c === 'bad_token' ? <>بله این توکن را نشناخت. توکن را دوباره از <Uname u="botfather" /> کپی کنید و همین‌جا بچسبانید.</> : c === 'network' ? 'به بله وصل نشد؛ کمی بعد دوباره امتحان کنید.' : c === 'bot_in_use' ? 'این ربات برای کارشناس دیگری وصل است.' : c === 'key_missing' ? 'کلید رمزنگاری روی سرور نیست؛ با مدیر فنی هماهنگ کنید.' : 'انجام نشد؛ دوباره امتحان کنید.';
  let body: React.ReactNode, foot: React.ReactNode;
  if (s === 1) {
    body = <><div className="fld"><span className="flab" id="exl">ربات برای کدام کارشناس است؟</span><ul className="opl" role="radiogroup" aria-labelledby="exl">{experts.map((x) => { const has = !!x.bot?.hasToken; const why = !has ? 'ربات وصل ندارد' : x.bot?.status === 'err' ? 'ربات دارد؛ تعویض توکن از فهرست' : 'ربات وصل دارد';
      return <li key={x.id}><button className="opo" type="button" role="radio" aria-checked={uid === x.id} aria-disabled={has} onClick={() => { if (!has) setUid(x.id); }}><span className="rd" aria-hidden="true" /><span className="tx"><b>{x.name}</b>{why}</span></button></li>; })}</ul></div>
      <p className="hint"><I n="bale" /> ربات را خود کارشناس در بله با <Uname u="botfather" /> می‌سازد و توکنش را به شما می‌دهد.</p></>;
    foot = <><button className="btn pri" type="button" aria-disabled={!uid} onClick={() => uid && setS(2)}>بعدی: توکن<I n="arrow" /></button><button className="btn gh" type="button" onClick={close}>انصراف</button></>;
  } else if (s === 2) {
    body = <><div className="sel" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}><span className="ava c1" aria-hidden="true">{e?.name.trim()[0]}</span><b style={{ flex: 1 }}>{e?.name}</b>{init.userId ? null : <button className="btn lk sm" type="button" onClick={() => setS(1)}>عوض کردن</button>}</div>
      <div className="warn"><I n="alert" /><span>این ربات رو جای دیگه‌ای وصل نکنید؛ هر ربات فقط به یک جا پیام می‌دهد.</span></div>
      <div className="fld"><label className="flab" htmlFor="tk">توکن ربات</label><input id="tk" className="inp tok" type="password" autoComplete="off" spellCheck={false} value={tok} onChange={(x) => { setTok(x.target.value); setEr(null); }} aria-invalid={er ? true : undefined} aria-describedby={er ? 'tke' : 'tkh'} />
        {er ? <p className="ferr" id="tke" role="alert"><I n="alert" />{errText(er)}</p> : <p className="hint" id="tkh"><I n="lock" /> رمزنگاری‌شده ذخیره می‌شود و بعد از ذخیره دیگر نمایش داده نمی‌شود، حتی بخشی از آن.</p>}</div></>;
    foot = <><button className="btn pri" type="button" aria-disabled={busy || !tok.trim()} onClick={test}><I n="refresh" />تست اتصال</button>{init.userId ? <button className="btn gh" type="button" onClick={close}>انصراف</button> : <button className="btn gh" type="button" onClick={() => setS(1)}><I n="back" />قبلی</button>}</>;
  } else {
    body = <div className="tst"><div className="ci ok"><I n="check" /></div><h3>اتصال برقرار شد</h3><p>بله این ربات را شناخت:</p>
      <div className="botc"><span className="ava bot"><I n="bot" /></span><div style={{ flex: 1, minWidth: 0 }}><b>{bot?.name}</b><span className="u">@{bot?.username}</span></div></div>
      <p>بعد از ذخیره، پیام‌های این ربات از همین لحظه در صندوق {e?.name} می‌آید؛ پیام‌های قبل نمی‌آید.</p></div>;
    foot = <><button className="btn pri" type="button" aria-disabled={busy} onClick={save}><I n="check" />ذخیره و وصل کردن</button><button className="btn gh" type="button" onClick={() => setS(2)}><I n="back" />قبلی</button></>;
  }
  return <Modal cls="wz" title={replace ? 'تعویض توکن ربات بله' : 'وصل کردن ربات بله'} sub={`مرحله ${fa(s)} از ۳: ${BOTST[s - 1]}`} onClose={close}
    steps={<Steps labels={BOTST} s={s} err={s === 2 && !!er} onBack={(n) => { if (n === 1 && init.userId) return; setS(n); }} />} foot={foot}>{body}</Modal>;
}

function Saved({ e, close, toast, reload, onReplace, onOff }: { e: BbAdminExpert; close: () => void; toast: (t: string) => void; reload: () => void; onReplace: () => void; onOff: () => void }) {
  const b = e.bot as NonNullable<BbBot>; const [busy, setBusy] = useState(false);
  const test = async () => { setBusy(true); try { await bbFetch(`/bale-bot/admin/bots/${b.id}/test`, { body: {} }); toast('اتصال برقرار است'); } catch (x) { toast(x instanceof BbError ? x.message : 'انجام نشد.'); } finally { setBusy(false); reload(); } };
  return <Modal title={`ربات ${e.name}`} sub="تنظیمات ربات بله" onClose={close} foot={<><button className="btn dng" type="button" onClick={onOff}>قطع اتصال</button><button className="btn gh" type="button" onClick={close}>بستن</button></>}>
    <div className="botc"><span className="ava bot"><I n="bot" /></span><div style={{ flex: 1, minWidth: 0 }}><b>{b.name}</b><span className="u">@{b.username}</span></div><span className="chip s"><I n="check" />وصل</span></div>
    <div className="fld"><span className="flab">توکن ربات</span><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className="tsv" style={{ minHeight: 44, padding: '0 12px' }}><I n="lock" />توکن ذخیره شده</span>
      <button className="btn gh sm" type="button" aria-disabled={busy} onClick={test}><I n="refresh" />تست اتصال</button><button className="btn gh sm" type="button" onClick={onReplace}><I n="pen" />تعویض توکن</button></div><p className="hint">توکن رمزنگاری‌شده نگه داشته می‌شود و دیگر نمایش داده نمی‌شود.</p></div>
    <div className="rvw"><div className="r"><span className="k">کارشناس</span><span className="v">{e.name}</span></div><div className="r"><span className="k">وصل از</span><span className="v">{since(b.connectedAt)}</span></div><div className="r"><span className="k">لینک ربات</span><span className="v ltr">ble.ir/{b.username}</span></div></div>
  </Modal>;
}
