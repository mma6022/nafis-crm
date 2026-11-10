/* bale v1.1 «گفتگوی بله داخل پنل کارشناس»: inbox (list · chat · customer pane), composer, link/lead modals.
   Design: nafis-design/screens/bale (45 scenes). Nothing here ever sends without a click on «ارسال»/«ثبت»:
   canned replies only fill the composer; «درخواست شماره» is an explicit expert action. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import './bale-bot.css';
import './bale-contact.css';
import '../customer-bale/customer-bale.css';
import { bbFetch, BbError, useBaleBotMe, bbListTime, bbTime, bbDay, bbDayKey, bbSize, bbDur, fa, fd, toLatin, PHONE_OK, bbUrl,
  type BbMe, type BbChat, type BbChats, type BbMessage } from './api';
import { I, Ava, Nm, Cid, Ph, Uname, Unverified, useToast, Steps, Modal, copyText, FaPhones, faPhoneString } from './ui';

export const CUST_STATUS: Record<string, string> = { in_progress: 'در حال انجام', cancelled: 'لغو شده', completed: 'اتمام' };
const STATUS: Record<string, [string, string]> = { sending: ['refresh', 'در حال ارسال'], sent: ['check', 'ارسال شد'], failed: ['alert', 'ارسال ناموفق'], wait: ['clock', 'کمی صبر کنید، دوباره ارسال می‌شود'] };
const WV = [6, 12, 18, 10, 22, 14, 8, 16, 24, 12, 7, 18, 13, 20, 9, 15, 11, 6, 14, 19, 10, 8];
const OTHER_HINT = 'مشتری کارشناس دیگر با این جستجو پیدا نمی‌شود؛ برای اتصال، از مشتری «درخواست شماره» بزنید';
const PREV_IC: Record<string, string> = { photo: 'img', video: 'video', animation: 'video', document: 'doc', audio: 'play', voice: 'mic', sticker: 'img', contact: 'contact', location: 'pin' };
const canned = (me: BbMe): [string, string][] => [
  ['سلام و خوش‌آمد', `سلام، ${me.name} هستم از نفیس وام. سؤال‌تون رو بنویسید، همین‌جا جواب می‌دم.`],
  ['مدارک لازم', 'کارت ملی و آخرین فیش حقوقی رو با عکس واضح همین‌جا بفرستید.'],
  ['طرح‌ها', 'طرح‌های وام رو این‌جا ببینید: nafisvam.com/plans'],
  ['درخواست شماره', 'بی‌زحمت شماره‌تون رو با دکمه‌ی «اشتراک شماره» بفرستید تا پرونده‌تون رو پیدا کنم.'],
  ['ثبت درخواست', 'درخواستتون ثبت شد؛ نتیجه‌ی بررسی رو همین‌جا خبر می‌دم.'],
  ['تماس فردا', 'فردا صبح باهاتون تماس می‌گیرم تا مراحل بعدی رو بگم.'],
];
const linked = (c: BbChat) => !!c.customer;
const otherFile = (c: BbChat) => !!c.customer?.restricted;
const noticeText = (k: string, actor: string | null, at: string, c: BbChat) =>
  k === 'mgr_wrote' ? `${actor ?? 'مدیر'} ساعت ${bbTime(at)} در این گفتگو پیام داد.`
  : k === 'linked_other' ? `این گفتگو به پرونده‌ی ${c.customer?.name ?? ''} وصل شد؛ مسئول پرونده ${c.customer?.expert ?? 'کارشناس دیگر'} می‌ماند و به ایشان هم خبر داده شد.`
  : `${actor ?? 'کارشناس دیگر'} گفتگوی بله را به پرونده‌ی شما وصل کرد.`;

type Modal = null | { k: 'search' } | { k: 'lead'; phone?: string } | { k: 'del'; m: BbMessage };

export default function BaleBotInbox() {
  const meQ = useBaleBotMe();
  const me = meQ.data;
  const [, nav] = useLocation();
  if (meQ.isLoading) return <div className="bbt" dir="rtl"><main className="pg bbpg"><span className="bbsk" /><span className="bbsk" /></main></div>;
  if (!me) { nav('/'); return null; }
  return <Inbox me={me} />;
}

function Inbox({ me }: { me: BbMe }) {
  const params = useParams<{ id?: string }>();
  const sel = params.id ? Number(params.id) : null;
  const [, nav] = useLocation();
  const qc = useQueryClient();
  const { toast, node: toastNode } = useToast();
  const [filter, setFilter] = useState<'all' | 'unread' | 'unlinked' | 'pending'>('all');
  const [q, setQ] = useState('');
  const [expert, setExpert] = useState<number | ''>('');
  const [modal, setModal] = useState<Modal>(null);
  const [manualWiz, setManualWiz] = useState(false);
  useEffect(() => { setManualWiz(false); }, [sel]);
  const qs = new URLSearchParams({ filter, ...(q.trim() ? { q: q.trim() } : {}), ...(expert ? { expert: String(expert) } : {}) }).toString();
  const listQ = useQuery<BbChats>({ queryKey: ['bb-chats', qs], queryFn: () => bbFetch(`/bale-bot/chats?${qs}`), refetchInterval: 5000 });
  const chatQ = useQuery<{ chat: BbChat; messages: BbMessage[] }>({ queryKey: ['bb-chat', sel], enabled: sel != null, queryFn: () => bbFetch(`/bale-bot/chats/${sel}`), refetchInterval: 4000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['bb-chats'] }); void qc.invalidateQueries({ queryKey: ['bb-chat', sel] }); void qc.invalidateQueries({ queryKey: ['bale-bot-me'] }); };
  const chat = chatQ.data?.chat ?? null;
  const allEmpty = listQ.data && listQ.data.counts.all === 0 && !q && filter === 'all' && !expert;
  const mob = sel != null ? 'chat' : 'list';
  useEffect(() => { document.title = 'گفتگوهای بله | نفیس وام'; }, []);
  // flag OFF: desktop auto-opens the first chat. flag ON: leave the mid pane empty (Armita scene 10).
  const first = listQ.data?.chats[0]?.id;
  useEffect(() => { if (me.contactFeature) return; if (sel == null && first != null && window.matchMedia('(min-width:1024px)').matches) nav(`/bale-bot/${first}`, { replace: true }); }, [sel, first, nav, me.contactFeature]);
  const err = (e: unknown) => toast(e instanceof BbError ? e.message : 'درخواست انجام نشد. دوباره تلاش کنید.');
  const askContact = async () => { if (!chat) return; try { await bbFetch(`/bale-bot/chats/${chat.id}/request-contact`, { body: {} }); toast('درخواست شماره فرستاده شد'); refresh(); } catch (e) { err(e); } };

  return <div className={`bbt${me.contactFeature ? " bc-on" : ""}${me.customerBot?.any ? " cb-on" : ""}`} dir="rtl" data-testid="bale-bot-inbox">
    {/* the floating «گزارش خطا» launcher sat on the bubbles of an open chat on phones; the top-bar bug icon stays */}
    <style>{'@media (max-width:1023px){body:has(.bbt .pg.chv) .diag-floating{display:none!important}}'}</style>
    <main className={`pg bbpg${mob === 'chat' ? ' chv' : ''}`}>
      <div className={`bx${allEmpty || !sel ? ' np' : ''}`} data-m={mob}>
        <ListPane me={me} data={listQ.data} loading={listQ.isLoading} sel={sel} filter={filter} setFilter={setFilter} q={q} setQ={setQ} expert={expert} setExpert={setExpert} toast={toast} />
        {sel != null && chat ? <>
          <ChatPane me={me} chat={chat} messages={chatQ.data!.messages} toast={toast} err={err} refresh={refresh} onAsk={askContact}
            onSearch={() => setModal({ k: 'search' })} onLead={() => setModal({ k: 'lead' })} onDelete={(m) => setModal({ k: 'del', m })} back={() => nav('/bale-bot')}
            wiz={manualWiz} setWiz={setManualWiz} />
          <CustPane me={me} chat={chat} toast={toast} onAsk={askContact} onSearch={() => setModal({ k: 'search' })} onLead={() => setModal({ k: 'lead' })}
            onManual={() => setManualWiz(true)} wiz={manualWiz} />
        </> : sel != null && chatQ.isError ? <section className="pane ch"><div className="na" style={{ margin: 'auto' }}><div className="ci"><I n="lock" /></div><b>این گفتگو پیدا نشد</b><p>شاید به ربات شما مربوط نیست.</p><Link className="btn pri" href="/bale-bot"><I n="chat" />گفتگوهای بله</Link></div></section>
          : sel != null ? <section className="pane ch"><span className="bbsk" /></section>
          : allEmpty ? <EmptyMain me={me} toast={toast} /> : me.contactFeature
            ? <section className="pane ch" aria-label="شروع"><div className="bc-empty"><b>یک گفتگو را انتخاب کنید</b><p>نام مشتری‌ها در فهرست دیده می‌شود؛ گفتگوهای در انتظار شماره یا تأیید علامت دارند.</p></div></section>
            : <section className="pane ch" aria-label="شروع"><div className="na" style={{ margin: 'auto' }}><div className="ci" style={{ background: 'var(--nf-brand-50)', color: 'var(--nf-brand-600)' }}><I n="chat" /></div><b>یک گفتگو را انتخاب کنید</b><p>پیام‌ها و پرونده‌ی مشتری این‌جا باز می‌شود.</p></div></section>}
      </div>
    </main>
    {modal?.k === 'search' && chat ? <SearchModal chat={chat} toast={toast} close={() => setModal(null)} onAsk={() => { setModal(null); void askContact(); }} onLead={() => setModal({ k: 'lead' })} done={(name) => { setModal(null); toast(`گفتگو به پرونده‌ی ${name} وصل شد.`); refresh(); }} /> : null}
    {modal?.k === 'lead' && chat ? <LeadModal me={me} chat={chat} toast={toast} close={() => setModal(null)} onAsk={askContact} done={(name) => { setModal(null); toast(`سرنخ ${name} ثبت شد و گفتگو به پرونده وصل شد.`); refresh(); }} /> : null}
    {modal?.k === 'del' ? <div className="mx cfx" data-bbdnd=""><div className="md cf" role="alertdialog" aria-modal="true" aria-labelledby="cft" aria-describedby="cfd">
      <div className="cfb"><div className="ci"><I n="trash" /></div><h2 id="cft">پیام حذف شود؟</h2><ul id="cfd"><li>پیام برای مشتری هم در بله پاک می‌شود.</li><li>در CRM با برچسب «حذف شد» می‌ماند.</li></ul></div>
      <div className="mf"><button className="btn dng" type="button" onClick={async () => { const m = modal.m; setModal(null); try { await bbFetch(`/bale-bot/messages/${m.id}/delete`, { body: {} }); toast('پیام حذف شد'); refresh(); } catch (e) { err(e); } }}>حذف پیام</button>
        <button className="btn gh" type="button" onClick={() => setModal(null)}>انصراف</button></div></div></div> : null}
    {toastNode}
  </div>;
}

function ListPane({ me, data, loading, sel, filter, setFilter, q, setQ, expert, setExpert, toast }: { me: BbMe; data?: BbChats; loading: boolean; sel: number | null; filter: string; setFilter: (f: 'all' | 'unread' | 'unlinked' | 'pending') => void; q: string; setQ: (s: string) => void; expert: number | ''; setExpert: (n: number | '') => void; toast: (t: string) => void }) {
  const [, nav] = useLocation();
  const fb = (v: 'all' | 'unread' | 'unlinked' | 'pending', t: string, n: number) => <button key={v} className="fb" type="button" role="radio" aria-checked={filter === v} onClick={() => setFilter(v)}>{t}{n ? <span className="n">{fa(n)}</span> : null}</button>;
  const empty = data && data.counts.all === 0 && !q && filter === 'all' && !expert;
  const u = me.bot?.username;
  return <section className="pane lst" aria-label="گفتگوها">
    {me.view === 'own' && me.bot?.status === 'err' ? <div className="offb" role="alert"><I n="alert" /><div><b>ربات شما قطع است</b><span>بله توکن ربات را قبول نکرد و پیام تازه نمی‌رسد. پیام‌های این مدت فقط ۲۴ ساعت روی بله می‌ماند؛ به مدیر سیستم بگویید توکن را عوض کند.</span></div></div> : null}
    <div className="lh"><div className="r1"><h2>گفتگوهای بله</h2>{me.canManage ? <Link className="btn lk sm" href="/bale-bot/admin"><I n="shield" />ربات‌ها</Link> : null}</div>
      {me.view === 'all' ? <div className="mgf" role="radiogroup" aria-label="کارشناس">
        <button className="fb" type="button" role="radio" aria-checked={expert === ''} onClick={() => setExpert('')}>همه‌ی کارشناس‌ها</button>
        {(data?.experts ?? []).map((e) => <button key={e.id} className="fb" type="button" role="radio" aria-checked={expert === e.id} onClick={() => setExpert(e.id)}>{e.name}</button>)}</div>
        : u ? <div className="botl"><span className="lg-b"><I n="bale" /></span><span className="bk">ربات من</span><span className="u">@{u}</span><button className="btn lk sm" type="button" aria-label={`کپی لینک ربات من، ble.ir/${u}`} onClick={() => copyText(`https://ble.ir/${u}`, toast)}><I n="copy" />لینک ربات من</button></div> : null}
      <label className="srch"><I n="search" /><input type="search" placeholder="جستجوی نام، نام کاربری یا شناسه" aria-label="جستجوی گفتگو" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="flt" role="radiogroup" aria-label="فیلتر گفتگوها">{fb('all', 'همه', 0)}{fb('unread', 'خوانده‌نشده', data?.counts.unread ?? 0)}{me.contactFeature ? fb('pending', 'در انتظار شماره', data?.counts.pending ?? data?.counts.unlinked ?? 0) : fb('unlinked', 'وصل‌نشده به مشتری', data?.counts.unlinked ?? 0)}</div></div>
    {loading ? <><span className="bbsk" /><span className="bbsk" /></> : empty ? <div className="lempty"><b>هنوز گفتگویی نیست</b>از لحظه‌ی وصل شدن ربات، پیام‌های مشتری‌ها این‌جا می‌آید.</div>
      : data && data.chats.length ? <ul className="cvl" aria-label="گفتگوها">{data.chats.map((c) => {
        const tags: React.ReactNode[] = [];
        if (me.contactFeature) {
          if (c.waitingNumber) tags.push(<span key="nl" className="chip mut"><I n="clock" />در انتظار شماره</span>);
          if (c.pendingTypedPhone) tags.push(<span key="tp" className="chip g"><I n="clock" />شمارهٔ تایپی، در انتظار تأیید</span>);
          if (c.sourceChip) tags.push(<span key="src" className="chip src"><I n="bot" />{c.sourceChip}</span>);
          if (c.waitingAssignment) tags.push(<span key="wa" className="chip mut"><I n="clock" />در انتظار تعیین کارشناس</span>);
          if (c.leadFromBale && !c.sharedCustomerBot) tags.push(<span key="ld" className="chip ld"><I n="plus" />لید جدید از بله</span>);
          if (otherFile(c)) tags.push(<span key="ot" className="chip s"><I n="lock" />کارشناس دیگر</span>);
        } else {
          if (!linked(c)) tags.push(<span key="nl" className="chip r"><I n="user-x" />وصل‌نشده به مشتری</span>);
          if (otherFile(c)) tags.push(<span key="ot" className="exc">پرونده‌ی {c.customer?.expert}</span>);
        }
        if (me.view === 'all' && c.expert.name) tags.push(<span key="ex" className="exc">{c.expert.name}</span>);
        if (c.notices.some((n) => n.kind === 'mgr_wrote')) tags.push(<span key="mg" className="chip g"><I n="bell" />پیام مدیر</span>);
        const pvKind = c.lastPreview && PREV_IC[c.lastPreview] ? c.lastPreview : null;
        const showCid = !!c.customer && !c.pendingTypedPhone;
        return <li key={c.id} className={`cv-r${c.unread ? ' un' : ''}`} aria-current={c.id === sel ? true : undefined} onClick={() => nav(`/bale-bot/${c.id}`)}>
          <a className="cv-hit" href={`#${c.id}`} onClick={(e) => { e.preventDefault(); nav(`/bale-bot/${c.id}`); }} aria-label={`گفتگو با ${c.name}${c.unread ? `، ${fa(c.unread)} پیام خوانده‌نشده` : ''}`} />
          <Ava name={c.name} seed={c.id} /><span className="nmr"><Nm name={c.name} />{showCid ? <Cid id={c.customer!.id} toast={toast} /> : null}</span><span className="tm">{bbListTime(c.lastAt)}</span>
          <span className="pv">{c.listTag ? c.listTag : <>{c.lastByManager ? 'مدیر: ' : c.lastOut ? 'شما: ' : ''}{pvKind ? <I n={PREV_IC[pvKind]} /> : null}{c.customerBot?.handoff && !c.customerBot.handoff.claimedBy ? 'واگذاری از پاسخ خودکار' : c.customerBot?.filing ? (c.customerBot.filing.stepLine.replace(/\d+/g, (d: string) => fa(d))) : (me.contactFeature && c.lastPreview && !pvKind ? faPhoneString(c.lastPreview) : c.lastPreview)}</>}</span>{c.unread ? <span className="ub" aria-hidden="true">{fa(c.unread)}</span> : null}
          {tags.length ? <span className="tg">{tags}</span> : null}
          {me.contactFeature && otherFile(c) && (c.customer?.phone || c.customer?.canOpen) ? <div className="bc-row-more">{c.customer!.phone ? <Ph phone={c.customer!.phone} toast={toast} /> : null}{c.customer!.canOpen ? <Link className="btn gh sm" href={`/customers/${c.customer!.id}`} onClick={(e) => e.stopPropagation()}><I n="file" />مشاهده‌ی پرونده</Link> : null}{c.customer!.expert ? <span className="bc-own">مسئول: {c.customer!.expert}</span> : null}</div> : null}</li>; })}</ul>
      : <div className="lempty"><b>گفتگویی پیدا نشد</b></div>}
    {data && data.counts.all ? <p className="lfoot"><I n="clock" />فقط پیام‌هایی که به ربات داده می‌شود؛ پیام‌های شخصی بله این‌جا نیست.</p> : null}
  </section>;
}

function EmptyMain({ me, toast }: { me: BbMe; toast: (t: string) => void }) {
  const b = me.bot;
  return <section className="pane ch" aria-label="شروع"><div className="na" style={{ margin: 'auto' }}>
    <div className="ci" style={{ background: 'var(--nf-brand-50)', color: 'var(--nf-brand-600)' }}><I n="bale" /></div>
    {b ? <><b>ربات شما وصل است؛ هنوز پیامی نرسیده</b>
      <p>از همین لحظه که ربات وصل شده، پیام‌های مشتری‌ها این‌جا می‌آید؛ پیام‌های قبل از وصل شدن نمی‌آید. ربات خودش گفتگو را شروع نمی‌کند: مشتری باید لینک ربات را باز کند و /start بزند.</p>
      <div className="botc" style={{ textAlign: 'start' }}><span className="ava bot"><I n="bot" /></span><div style={{ flex: 1, minWidth: 0 }}><b>{b.name}</b><span className="u">@{b.username}</span></div></div>
      <button className="btn pri" type="button" onClick={() => copyText(`https://ble.ir/${b.username}`, toast)}><I n="copy" />کپی لینک ربات من</button></>
      : <><b>هنوز رباتی برای شما وصل نشده</b><p>ربات بله‌ی شما را مدیر سیستم وصل می‌کند؛ بعد از آن پیام‌های مشتری‌ها این‌جا می‌آید.</p></>}
  </div></section>;
}

function LinkActs({ onAsk, onSearch, onLead, canWrite }: { onAsk: () => void; onSearch: () => void; onLead: () => void; canWrite: boolean }) {
  return <>{canWrite ? <button className="btn pri sm" type="button" onClick={onAsk}><I n="contact" />درخواست شماره</button> : null}
    <button className="btn gh sm" type="button" onClick={onSearch}><I n="search" />جستجو و وصل</button><button className="btn gh sm" type="button" onClick={onLead}><I n="plus" />ثبت سرنخ جدید</button></>;
}

function CStrip({ chat, toast, onAsk, onSearch, onLead }: { chat: BbChat; toast: (t: string) => void; onAsk: () => void; onSearch: () => void; onLead: () => void }) {
  const c = chat.customer;
  if (c && c.restricted) return <div className="cstrip"><span className="nmr">{c.name}<Cid id={c.id} toast={toast} /></span><span className="chip s"><I n="link" />پرونده‌ی {c.expert}</span></div>;
  if (c) return <div className="cstrip"><span className="nmr">{c.name}<Cid id={c.id} toast={toast} /></span>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}{chat.phoneVerified === false ? <Unverified /> : null}<span className="sp" />{!chat.waitingAssignment && c.canOpen ? <Link className="btn lk sm" href={`/customers/${c.id}`}>پرونده</Link> : null}</div>;
  if (chat.contactAskedAt) return <div className="cstrip"><span className="chip g"><I n="clock" />منتظر شماره‌ی مشتری</span><span className="sp" /><button className="btn lk sm" type="button" onClick={onSearch}>جستجو و وصل</button></div>;
  return <div className="cstrip"><span className="chip r"><I n="user-x" />وصل‌نشده به مشتری</span><div className="acts"><LinkActs canWrite={chat.canWrite} onAsk={onAsk} onSearch={onSearch} onLead={onLead} /></div></div>;
}

/** server codes from the contact auto-link (bale-bot.ts): never show the raw code. */
const MATCH_NOTE: Record<string, string> = {
  none: 'شماره‌ای که مشتری فرستاد به هیچ پرونده‌ای نخورد.',
  many: 'شماره‌ای که مشتری فرستاد به چند پرونده می‌خورد؛ با «جستجو و وصل» درستش را انتخاب کنید.',
};

const TASK_FA: Record<string, string> = {
  docs_review: 'بررسی مدارک', credit_fail: 'اعتبارسنجی ناموفق', identity_manual: 'هویت دستی',
  fee_unpaid: 'کارمزد پرداخت‌نشده', ai_handoff: 'واگذاری از پاسخ خودکار', talk_expert: 'گفتگو با کارشناس',
  admin_approval: 'تأیید مدیر',
};
function filingLine(cb: NonNullable<BbChat['customerBot']>) {
  if (!cb?.filing) return null;
  const n = cb.filing.step;
  return cb.filing.stepLine.replace(/\d+/g, (d) => String(d).replace(/[0-9]/g, x => '۰۱۲۳۴۵۶۷۸۹'[Number(x)]));
}
function CustomerBotBits({ chat, toast, refresh, err, where }: { chat: BbChat; toast: (t: string) => void; refresh?: () => void; err?: (e: unknown) => void; where: 'meta' | 'pane' | 'thread' }) {
  const cb = chat.customerBot;
  if (!cb || cb.restricted || !cb.flags?.any) return null;
  const claim = async () => {
    if (!cb.handoff || !refresh || !err) return;
    try { await bbFetch(`/bale-bot/chats/${chat.id}/customer-bot/claim-handoff`, { body: { id: cb.handoff.id } }); toast('واگذار شد'); refresh(); } catch (e) { err(e); }
  };
  const remind = async () => {
    if (!refresh || !err) return;
    try { const r = await bbFetch(`/bale-bot/chats/${chat.id}/customer-bot/check-sign`, { body: {} }); toast(r.status === 'signed' ? 'امضا شد' : 'وضعیت امضا به‌روز شد'); refresh(); } catch (e) { err(e); }
  };
  const task = (cb.tasks && cb.tasks[0]) || null;
  if (where === 'meta') {
    if (cb.handoff && !cb.handoff.claimedBy) return <div className="bc-meta"><span className="chip mut"><I n="bell" />واگذاری از پاسخ خودکار</span><button className="btn pri sm" type="button" onClick={claim}>واگذار به من</button></div>;
    if (task && (task.kind === 'docs_review' || task.kind === 'identity_manual' || task.kind === 'credit_fail' || task.kind === 'fee_unpaid' || task.kind === 'admin_approval'))
      return <div className="bc-meta"><span className="chip mut"><I n="clock" />در انتظار کارشناس</span><span className="kv">کار <b>{TASK_FA[task.kind] ?? task.kind}</b></span></div>;
    if (cb.filing?.contractStatus && cb.filing.contractStatus !== 'signed' && cb.filing.step >= 7)
      return <div className="bc-meta">{chat.customer?.phone ? <Ph phone={chat.customer.phone} toast={toast} /> : null}<span className="kv">وضعیت امضا <b>در انتظار امضا</b></span><button className="btn gh sm" type="button" onClick={remind}>به‌روزرسانی وضعیت</button></div>;
    if (cb.filing)
      return <div className="bc-meta">{chat.customer?.phone ? <Ph phone={chat.customer.phone} toast={toast} /> : null}<span className="kv">ثبت درخواست <b>{filingLine(cb)}</b></span><span className="kv">کارشناس <b>{chat.expert.name}</b></span>{cb.filing.applicationId ? <Link className="btn gh sm" href={`/loan-applications/${cb.filing.applicationId}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}</div>;
    return null;
  }
  if (where === 'pane') {
    return <>
      {cb.filing ? <div className="kv2"><span>پیشرفت ربات</span><b>{filingLine(cb)}</b></div> : null}
      {task ? <div className="kv2"><span>کار شما</span><b>{TASK_FA[task.kind] ?? task.kind} ارسال‌شده از بله</b></div> : null}
      {cb.filing?.contractStatus ? <div className="kv2"><span>وضعیت امضا</span><b>{cb.filing.contractStatus === 'signed' ? 'امضا شد' : 'در انتظار امضا'}</b></div> : null}
      {cb.filing?.contractStatus && cb.filing.contractStatus !== 'signed' ? <p className="m">وضعیت امضا از مسیر بررسی وضعیت فعلی خوانده می‌شود. متن قرارداد عوض نمی‌شود.</p> : null}
      {cb.handoff && !cb.handoff.claimedBy ? <p className="m">سؤال مشتری و پاسخ خودکار در گفتگو آمده است. با «واگذار به من» این گفتگو را جواب می‌دهید.</p> : null}
    </>;
  }
  if (where === 'thread' && cb.handoff) {
    return <><div className="sys" role="status">واگذاری به کارشناس فروش، {chat.expert.name}</div>
      <div className="bb-ctx"><small>متن سؤال مشتری</small>{cb.handoff.question}</div>
      <div className="bb-ctx"><small>پاسخ خودکار</small>{cb.handoff.answer}</div></>;
  }
  return null;
}

function CustPane({ chat, toast, onAsk, onSearch, onLead, onManual, wiz }: { me: BbMe; chat: BbChat; toast: (t: string) => void; onAsk: () => void; onSearch: () => void; onLead: () => void; onManual?: () => void; wiz?: boolean }) {
  const c = chat.customer;
  const prof = <><div className="pf"><Ava name={chat.name} seed={chat.id} cls="lg2" /><b dir={/^[\x20-\x7e]+$/.test(chat.name) ? 'ltr' : undefined}>{chat.name}</b>{chat.username ? <Uname u={chat.username} /> : <span className="u">نام کاربری ندارد</span>}</div>
    {chat.bio ? <p className="bio"><small>بیو در بله</small>{chat.bio}</p> : null}</>;
  let crm: React.ReactNode;
  if (chat.contactFeature && c && c.restricted && (c.phone || c.canOpen)) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip s"><I n="link" />وصل شد به پرونده‌ی کارشناس دیگر</span><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}<div className="kv2"><span>مسئول پرونده</span><b>{c.expert}</b></div>{c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}<p className="bc-perm">تأیید شماره فقط با کارشناس مشتری یا ادمین</p></div>;
  else if (chat.contactFeature && c && c.restricted) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip s"><I n="link" />وصل شد به پرونده‌ی کارشناس دیگر</span><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div><div className="kv2"><span>مسئول پرونده</span><b>{c.expert}</b></div><p className="m"><I n="lock" />شماره و جزئیات پرونده با مسئول آن است.</p></div>;
  else if (chat.contactFeature && chat.pendingTypedPhone) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip g"><I n="clock" />شمارهٔ تایپی، در انتظار تأیید</span><Ph phone={chat.pendingTypedPhone} toast={toast} />{chat.typedMatch ? <><div className="nmr">{chat.typedMatch.name}<Cid id={chat.typedMatch.id} toast={toast} /></div><p className="m">قبل از تأیید، پرونده‌ی تطبیق‌شده را ببینید. دکمه‌های تأیید و رد در سربرگ گفتگو هستند.</p></> : <p className="m">با تأیید، لید تازه ساخته می‌شود و طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد. دکمه‌های تأیید و رد در سربرگ گفتگو هستند.</p>}</div>;
  else if (chat.contactFeature && chat.waitingNumber) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip mut"><I n="clock" />در انتظار اشتراک شماره</span>{wiz ? null : <p className="m">وقتی مشتری شماره را با دکمه بفرستد، یا شما شماره را تأیید یا وارد کنید، گفتگو وصل می‌شود.</p>}{wiz ? <p className="m">فرم ورود دستی شماره در گفتگو باز است.</p> : null}{chat.canResendAsk ? <button className="btn gh sm" type="button" onClick={onAsk}><I n="contact" />ارسال دوباره‌ی درخواست شماره</button> : null}{chat.canManualEnter ? <button className="btn gh sm" type="button" onClick={onManual}><I n="pen" />ورود دستی شماره</button> : null}</div>;
  else if (chat.contactFeature && c && chat.sharedCustomerBot) {
    const expertLabel = chat.waitingAssignment ? 'در انتظار تعیین کارشناس' : (c.expert ?? chat.assignedExpertName ?? '—');
    const note = chat.waitingAssignment
      ? 'این لید از ربات مشترک نفیس وام آمده و طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد. لید تکراری ساخته نشده است.'
      : chat.routedExisting
        ? 'این مشتری از قبل کارشناس دارد. از ربات مشترک آمد و به همان کارشناس وصل شد؛ لید تازه ساخته نشد.'
        : (c.expert ? `طبق قاعده‌ی توزیع فعلی به ${c.expert} رسید. ورود از ربات نفیس وام است.` : 'طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد. ورود از ربات نفیس وام است.');
    crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip src"><I n="bot" />{chat.sourceChip || 'ربات نفیس وام'}</span><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}<div className="kv2"><span>کارشناس</span><b>{expertLabel}</b></div><p className="m">{note}</p>{!chat.waitingAssignment && c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}</div>;
  } else if (chat.contactFeature && c && chat.leadFromBale) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip ld"><I n="plus" />لید جدید از بله</span><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}<div className="kv2"><span>کارشناس</span><b>{c.expert ?? '—'}</b></div>{c.status ? <div className="kv2"><span>وضعیت</span><b>{CUST_STATUS[c.status] ?? c.status}</b></div> : null}{chat.sourceLine ? <p className="bc-src">{chat.sourceLine}</p> : null}{c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}</div>;
  else if (chat.contactFeature && c) crm = <div className="sec"><h3>پرونده در CRM</h3><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}<div className="kv2"><span>کارشناس</span><b>{c.expert ?? '—'}</b></div>{c.status ? <div className="kv2"><span>وضعیت</span><b>{CUST_STATUS[c.status] ?? c.status}</b></div> : null}{chat.sourceLine ? <p className="bc-src">{chat.sourceLine}</p> : null}<CustomerBotBits chat={chat} toast={toast} where="pane" />{c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}</div>;
  else if (c && c.restricted) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip s"><I n="link" />وصل شد به پرونده‌ی کارشناس دیگر</span><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div><div className="kv2"><span>مسئول پرونده</span><b>{c.expert}</b></div><p className="m"><I n="lock" />جزئیات پرونده با مسئول آن است؛ شما این گفتگو را جواب می‌دهید.</p></div>;
  else if (c) crm = <div className="sec"><h3>پرونده در CRM</h3><div className="nmr">{c.name}<Cid id={c.id} toast={toast} /></div>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}{chat.phoneVerified === false ? <Unverified /> : null}
    <div className="kv2"><span>کارشناس</span><b>{c.expert ?? '—'}</b></div>{c.status ? <div className="kv2"><span>وضعیت</span><b>{CUST_STATUS[c.status] ?? c.status}</b></div> : null}
    {c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />باز کردن پرونده</Link> : null}</div>;
  else if (chat.contactAskedAt) crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip g"><I n="clock" />منتظر شماره‌ی مشتری</span><p className="m">وقتی مشتری دکمه‌ی اشتراک را بزند و شماره مال خودش باشد، خودکار به پرونده وصل می‌شود.</p>
    <button className="btn gh sm" type="button" onClick={onSearch}><I n="search" />جستجو و وصل</button><button className="btn gh sm" type="button" onClick={onLead}><I n="plus" />ثبت سرنخ جدید</button></div>;
  else crm = <div className="sec"><h3>پرونده در CRM</h3><span className="chip r"><I n="user-x" />وصل‌نشده به مشتری</span>{chat.matchNote ? <p className="m"><I n="alert" />{MATCH_NOTE[chat.matchNote] ?? 'شماره‌ای که مشتری فرستاد خودکار وصل نشد.'}</p> : null}<LinkActs canWrite={chat.canWrite} onAsk={onAsk} onSearch={onSearch} onLead={onLead} /></div>;
  return <aside className="pane cp" aria-label="مشتری">{prof}{crm}</aside>;
}

function ChatPane({ me, chat, messages, toast, err, refresh, onAsk, onSearch, onLead, onDelete, back, wiz, setWiz }: { me: BbMe; chat: BbChat; messages: BbMessage[]; toast: (t: string) => void; err: (e: unknown) => void; refresh: () => void; onAsk: () => void; onSearch: () => void; onLead: () => void; onDelete: (m: BbMessage) => void; back: () => void; wiz: boolean; setWiz: (v: boolean) => void }) {
  const [menu, setMenu] = useState<number | null>(null);
  const [reply, setReply] = useState<BbMessage | null>(null);
  const [edit, setEdit] = useState<BbMessage | null>(null);
  const thRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => { const el = thRef.current; const th = el?.parentElement; if (th && th.scrollHeight > th.clientHeight + 1) th.scrollTop = th.scrollHeight; else if (el && window.innerWidth < 1024) el.scrollIntoView({ block: 'end' }); }, [lastId, chat.id]);
  useEffect(() => { setMenu(null); setReply(null); setEdit(null); }, [chat.id]);
  // the action menu opens under the tapped bubble; on a phone the last bubble can sit at the very bottom, so bring the menu into view.
  useEffect(() => { if (menu == null) return; const h = requestAnimationFrame(() => document.querySelector('.bbt .mmenu')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); return () => cancelAnimationFrame(h); }, [menu]);
  const seen = async (id: number) => { try { await bbFetch(`/bale-bot/notices/${id}/seen`, { body: {} }); refresh(); } catch (e) { err(e); } };
  const items: React.ReactNode[] = []; let day = '';
  for (const m of messages) {
    const dk = bbDayKey(m.at); if (dk !== day) { day = dk; items.push(<div key={`d${m.id}`} className="day">{bbDay(m.at)}</div>); }
    if (m.dir === 'in' && m.kind === 'text' && m.text?.trim() === '/start') { items.push(<div key={m.id} className="sys" role="status"><I n="bale" /><span>{chat.name} گفتگو را با /start شروع کرد</span></div>); continue; }
    items.push(<Bubble key={m.id} m={m} chat={chat} me={me} reply={m.replyTo ? byId.get(m.replyTo) : undefined} sel={menu === m.id} toast={toast} onClick={() => setMenu(menu === m.id ? null : m.id)}
      onRetry={async () => { try { await bbFetch(`/bale-bot/messages/${m.id}/retry`, { body: {} }); refresh(); } catch (e) { err(e); } }} />);
    if (m.kind === 'contact' && m.contact?.own && chat.customer && chat.linkMethod === 'contact') items.push(<div key={`l${m.id}`} className="sys ok" role="status"><I n="check" /><span>وصل شد به پرونده‌ی {chat.customer.name}<Cid id={chat.customer.id} toast={toast} /></span></div>);
    if (m.kind === 'contact' && m.contact?.own && chat.customer && chat.linkMethod === 'contact_other') items.push(<div key={`l${m.id}`} className="sys ok lko" role="status"><span className="chip s"><I n="link" />وصل شد به پرونده‌ی کارشناس دیگر</span><span>{chat.customer.name} <Cid id={chat.customer.id} toast={toast} />؛ مسئول پرونده: {chat.customer.expert}</span></div>);
    if (menu === m.id && !m.deleted) items.push(<div key={`mm${m.id}`} className="mmenu" role="menu" aria-label="کارهای پیام">
      {chat.canWrite ? <button type="button" role="menuitem" onClick={() => { setReply(m); setEdit(null); setMenu(null); }}><I n="reply" />پاسخ</button> : null}
      {m.text ? <button type="button" role="menuitem" onClick={() => { copyText(m.text!, toast); setMenu(null); }}><I n="copy" />کپی متن</button> : null}
      {m.canEdit ? <button type="button" role="menuitem" onClick={() => { setEdit(m); setReply(null); setMenu(null); }}><I n="pen" />ویرایش</button> : null}
      {m.canDelete ? <button type="button" role="menuitem" onClick={() => { setMenu(null); onDelete(m); }}><I n="trash" />حذف</button>
        : m.dir === 'out' && m.deleteExpired ? <><button type="button" role="menuitem" aria-disabled="true"><I n="trash" />حذف</button><span className="why">حذف فقط تا ۴۸ ساعت بعد از ارسال ممکن است.</span></> : null}
    </div>);
  }
  if (chat.contactFeature && chat.customer && (chat.linkSource === 'typed' || chat.linkSource === 'manual')) {
    const actor = chat.linkActor ?? chat.customer.expert ?? chat.expert.name;
    const fresh = !!chat.leadFromBale;
    items.push(<div key="link-chip" className="sys ok" role="status"><I n="check" /><span>{chat.linkSource === 'typed'
      ? <>وصل شد به {fresh ? 'لید تازه' : 'پرونده‌ی'} {chat.customer.name}<Cid id={chat.customer.id} toast={toast} /> پس از تأیید {actor}</>
      : <>وصل شد به {fresh ? 'لید تازه' : 'پرونده‌ی'} {chat.customer.name}<Cid id={chat.customer.id} toast={toast} /> با ورود دستی {actor}</>}</span></div>);
  }
  const sub = chat.contactFeature
    ? (chat.pendingTypedPhone ? <p className="bc-un">در انتظار تأیید کارشناس</p> : chat.waitingNumber ? <p className="bc-un">هنوز به مشتری وصل نشده</p> : <p className="bc-un">{chat.username ? <Uname u={chat.username} /> : 'بدون نام کاربری'}{me.view === 'all' && chat.expert.name ? `، کارشناس: ${chat.expert.name}` : ''}</p>)
    : <p>{chat.username ? <Uname u={chat.username} /> : 'بدون نام کاربری'}{me.view === 'all' && chat.expert.name ? `، کارشناس: ${chat.expert.name}` : ''}</p>;
  return <section className="pane ch" aria-label={`گفتگو با ${chat.name}`}>
    <div className="chh"><button className="ib bkb" type="button" onClick={back} aria-label="برگشت به گفتگوها"><I n="next" /></button><Ava name={chat.name} seed={chat.id} />
      <div className="t"><div className="nmr"><Nm name={chat.name} />{chat.customer && !chat.pendingTypedPhone ? <Cid id={chat.customer.id} toast={toast} /> : null}</div>{sub}</div></div>
    {(() => { const cb = chat.customerBot; const hasCb = !!(cb && !cb.restricted && (cb.handoff || cb.filing || (cb.tasks && cb.tasks.length)));
      if (hasCb) return <CustomerBotBits chat={chat} toast={toast} refresh={refresh} err={err} where="meta" />;
      return chat.contactFeature
        ? <ContactMeta chat={chat} toast={toast} err={err} refresh={refresh} onAsk={onAsk} onManual={() => setWiz(true)} wiz={wiz} />
        : <CStrip chat={chat} toast={toast} onAsk={onAsk} onSearch={onSearch} onLead={onLead} />;
    })()}
    {chat.contactFeature && wiz && chat.canManualEnter ? <ManualWiz chat={chat} toast={toast} err={err} refresh={refresh} close={() => setWiz(false)} /> : null}
    {chat.notices.map((n) => <div key={n.id} className="ntc" role="status"><I n="bell" /><span>{noticeText(n.kind, n.actor, n.at, chat)}</span><button className="btn lk sm" type="button" onClick={() => seen(n.id)}>باشه</button></div>)}
    <div className="th" role="log" aria-label="پیام‌ها">{items}<CustomerBotBits chat={chat} toast={toast} where="thread" /><div ref={thRef} /></div>
    <Composer me={me} chat={chat} reply={reply} edit={edit} clear={() => { setReply(null); setEdit(null); }} toast={toast} err={err} refresh={refresh} />
  </section>;
}

function Bubble({ m, chat, me, reply, sel, toast, onClick, onRetry }: { m: BbMessage; chat: BbChat; me: BbMe; reply?: BbMessage; sel: boolean; toast: (t: string) => void; onClick: () => void; onRetry: () => void }) {
  const out = m.dir === 'out';
  const mg = out && !!m.author && m.author !== me.name && me.view === 'own';
  const au = out && m.author && (me.view === 'all' || mg) ? m.author : null;
  const f = m.file; const url = f?.url ? bbUrl(f.url.replace(/^\/api/, '')) : null;
  let inner: React.ReactNode;
  if (m.deleted) inner = <span style={{ color: 'var(--nf-ink-muted)' }}>این پیام حذف شد.</span>;
  else if (f && f.state !== 'stored') inner = <div className="frow"><span className="fi"><I n={f.state === 'too_big' ? 'alert' : 'doc'} /></span><span className="tx"><b>{f.name ?? 'file'}</b><span>{f.state === 'too_big' ? `بیشتر از ۲۰ مگابایت؛ در CRM ذخیره نشد. ${bbSize(f.size)}` : f.state === 'pending' ? 'در حال دریافت…' : 'دریافت نشد'}</span></span></div>;
  else if (f && url && (m.kind === 'photo' || m.kind === 'sticker')) inner = m.kind === 'sticker' ? <img src={url} alt="استیکر، به‌صورت عکس" style={{ width: 120, height: 120 }} /> : <><a className="media" href={url} target="_blank" rel="noreferrer" aria-label="عکس، باز کردن"><img src={url} alt="عکس" onError={(e) => { const a = e.currentTarget.parentElement; if (a) a.classList.add('broken'); e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'nopv', textContent: 'پیش‌نمایش در دسترس نیست؛ برای دانلود بزنید' })); }} /></a>{m.text ? <span className="cap">{m.text}</span> : null}</>;
  else if (f && url && (m.kind === 'video' || m.kind === 'animation')) inner = <><span className="media vid"><video src={url} controls preload="metadata" />{f.duration != null ? <span className="bdx">{m.kind === 'animation' ? 'GIF' : bbDur(f.duration)}</span> : null}</span>{m.text ? <span className="cap">{m.text}</span> : null}</>;
  else if (f && url && (m.kind === 'voice' || m.kind === 'audio')) inner = <><div className="vc"><audio src={url} controls preload="none" /><span className="d">{bbDur(f.duration)}</span></div>{m.text ? <span className="cap">{m.text}</span> : null}</>;
  else if (f && url) inner = <><div className="frow"><span className="fi"><I n="doc" /></span><span className="tx"><b>{f.name ?? 'file'}</b><span>{bbSize(f.size)}</span></span><a className="ib" href={url} download aria-label={`دانلود ${f.name ?? ''}`} onClick={(e) => e.stopPropagation()}><I n="dl" /></a></div>{m.text ? <span className="cap">{m.text}</span> : null}</>;
  else if (m.kind === 'contact' && m.contact) {
    const hideNum = (!!chat.customer?.restricted && !chat.customer?.phone) || (!!m.contact.hidden && !chat.customer?.phone);
    inner = <div className="ctc"><div className="r"><span className="ava c2" aria-hidden="true">{(m.contact.name || '؟')[0]}</span><div><b>{m.contact.name || 'مخاطب'}</b>{hideNum || !m.contact.phone ? null : <Ph phone={m.contact.phone} toast={toast} />}</div></div>
    {hideNum ? <span className="chip s"><I n="lock" />شماره نمایش داده نمی‌شود</span> : m.contact.own ? <span className="chip s"><I n="check" />شماره‌ی خود مشتری</span> : <span className="chip"><I n="contact" />مخاطب فرستاده‌شده؛ شماره‌ی خود فرستنده نیست</span>}</div>;
  }
  else if (m.kind === 'location' && m.location) inner = <a className="media" href={`https://www.openstreetmap.org/?mlat=${m.location.lat}&mlon=${m.location.lng}#map=16/${m.location.lat}/${m.location.lng}`} target="_blank" rel="noreferrer" aria-label="موقعیت، باز کردن روی نقشه">
    <svg className="art" viewBox="0 0 260 170" aria-hidden="true"><rect width="260" height="170" fill="#E8F3EC" /><path d="M0 120 260 70M60 0 120 170M0 40 260 30M180 0 200 170" stroke="#fff" strokeWidth="12" /><path d="M130 52c-14 0-24 10-24 23 0 18 24 40 24 40s24-22 24-40c0-13-10-23-24-23z" fill="#D9483B" /><circle cx="130" cy="75" r="8" fill="#fff" /></svg><span className="bdx">{fd(m.location.lat.toFixed(4))}، {fd(m.location.lng.toFixed(4))}</span></a>;
  else if (m.askContact) inner = <>{m.text}<span className="kbd" aria-hidden="true"><I n="contact" />اشتراک شماره</span><span className="kbn">دکمه‌ای که مشتری در بله می‌بیند</span></>;
  else inner = <span style={{ whiteSpace: 'pre-wrap' }}>{chat.contactFeature && m.text ? <FaPhones text={m.text} /> : m.text}</span>;
  const st = out && m.status ? STATUS[m.status] : null;
  return <div className={`msg ${out ? 'out' : 'in'}${m.status === 'failed' ? ' failed' : ''}${sel ? ' sel' : ''}${au ? ' mg' : ''}`} data-st={m.status ?? undefined}>
    <div className={`bb${m.kind === 'sticker' ? ' stkw' : ''}`} onClick={onClick} role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={sel}>
      {au ? <span className="au"><I n="user" />{au}</span> : null}
      {reply ? <span className="rq"><b>{reply.dir === 'in' ? chat.name : 'شما'}</b>{(reply.text ?? 'پیوست').slice(0, 60)}</span> : null}{inner}</div>
    <div className="meta"><span>{bbTime(m.at)}</span>{m.editedAt ? <em className="ed">ویرایش شده</em> : null}
      {st ? <span className={`st ${m.status}`}><I n={st[0]} />{st[1]}</span> : null}
      {m.status === 'failed' && chat.canWrite ? <button className="btn lk sm rty" type="button" onClick={onRetry}><I n="refresh" />دوباره بفرست</button> : null}</div>
  </div>;
}

function Composer({ me, chat, reply, edit, clear, toast, err, refresh }: { me: BbMe; chat: BbChat; reply: BbMessage | null; edit: BbMessage | null; clear: () => void; toast: (t: string) => void; err: (e: unknown) => void; refresh: () => void }) {
  const L = me.limits; const warn = L.textWarn ?? 3800;
  const [text, setText] = useState('');
  const [pop, setPop] = useState<null | 'canned' | 'attach'>(null);
  const [cq, setCq] = useState('');
  const [file, setFile] = useState<{ f: File; kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState<{ r: MediaRecorder; start: number; chunks: Blob[] } | null>(null);
  const [recS, setRecS] = useState(0); const [recB, setRecB] = useState(0);
  const pick = useRef<HTMLInputElement>(null); const kindRef = useRef('document');
  useEffect(() => { setText(edit?.text ?? ''); }, [edit]);
  useEffect(() => { setText(''); setFile(null); setPop(null); }, [chat.id]);
  useEffect(() => { if (!rec) return; const h = setInterval(() => { setRecS(Math.floor((Date.now() - rec.start) / 1000)); setRecB(rec.chunks.reduce((a, c) => a + c.size, 0)); }, 250); return () => clearInterval(h); }, [rec]);
  // bot off/err: the design's disabled state. Read-only bot (server-enforced no_send): the design has no wording → disabled silently.
  if (!chat.canWrite && chat.sendBlocked !== 'no_send') return <div className="cz"><p className="czoff"><I n="alert" />ربات قطع است؛ تا وصل شدن دوباره پیامی فرستاده نمی‌شود.</p></div>;
  if (!chat.canWrite) return <div className="cz"><div className="row"><button className="ib" type="button" aria-label="پیوست" disabled><I n="clip" /></button><button className="ib" type="button" aria-label="پاسخ‌های آماده" disabled><I n="note" /></button>
    <textarea className="ta3" rows={1} aria-label={`پیام به ${chat.name}`} placeholder="پیام بنویسید" disabled /><button className="snd" type="button" aria-label="ارسال" aria-disabled="true"><I n="send" /></button></div></div>;
  const n = [...text].length;
  const limit = file ? (file.kind === 'photo' ? L.photoBytes : L.fileBytes) : 0;
  const tooBig = !!file && file.f.size > limit;
  const canSend = !busy && !tooBig && (file ? true : text.trim().length > 0 && n <= L.textMax);
  const send = async () => {
    if (!canSend) return; setBusy(true);
    try {
      if (edit) { await bbFetch(`/bale-bot/messages/${edit.id}/edit`, { body: { text } }); toast('پیام ویرایش شد'); }
      else if (file) await bbFetch(`/bale-bot/chats/${chat.id}/files`, { raw: file.f, headers: { 'Content-Type': file.f.type || 'application/octet-stream', 'x-kind': file.kind, 'x-file-name': encodeURIComponent(file.f.name), 'x-caption': encodeURIComponent(text) } });
      else await bbFetch(`/bale-bot/chats/${chat.id}/messages`, { body: { text, replyTo: reply?.id ?? null } });
      setText(''); setFile(null); clear(); refresh();
    } catch (e) { err(e); } finally { setBusy(false); }
  };
  const startRec = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '';
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined); const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data); r.start(250); setRec({ r, start: Date.now(), chunks });
    } catch { toast('دسترسی به میکروفون داده نشد.'); }
  };
  const stopRec = (keep: boolean) => {
    if (!rec) return; const { r, chunks } = rec;
    r.onstop = () => { r.stream.getTracks().forEach((t) => t.stop()); if (!keep) return; const type = r.mimeType || 'audio/webm'; const ext = /ogg/.test(type) ? 'ogg' : 'webm';
      setFile({ f: new File(chunks, `voice.${ext}`, { type }), kind: 'voice' }); };
    r.stop(); setRec(null); setRecS(0); setRecB(0);
  };
  const cn = canned(me).filter(([t, b]) => !cq || t.includes(cq) || b.includes(cq));
  const sizeMB = (b: number) => fa(Math.round(b / 1048576));
  let top: React.ReactNode = null;
  if (pop === 'canned') top = <div className="pop" role="dialog" aria-label="پاسخ‌های آماده"><h3><I n="note" />پاسخ‌های آماده<span className="sp" /><button className="ib" type="button" onClick={() => setPop(null)} aria-label="بستن"><I n="x" /></button></h3>
    <label className="srch"><I n="search" /><input type="search" aria-label="جستجوی پاسخ آماده" placeholder="جستجو در پاسخ‌های آماده" value={cq} onChange={(e) => setCq(e.target.value)} /></label>
    <ul className="cnl">{cn.map(([t, b]) => <li key={t}><button type="button" onClick={() => { setText(b); setPop(null); }}><b>{t}</b><span>{b}</span></button></li>)}</ul></div>;
  else if (pop === 'attach') top = <div className="pop" role="dialog" aria-label="پیوست"><h3><I n="clip" />پیوست<span className="sp" /><button className="ib" type="button" onClick={() => setPop(null)} aria-label="بستن"><I n="x" /></button></h3><div className="atm">
    <button type="button" onClick={() => { kindRef.current = 'photo'; pick.current!.accept = 'image/*'; pick.current!.click(); }}><span className="ic"><I n="img" /></span>عکس<small>تا {fa(L.photoBytes / 1048576)} مگابایت</small></button>
    <button type="button" onClick={() => { kindRef.current = 'video'; pick.current!.accept = 'video/*'; pick.current!.click(); }}><span className="ic" style={{ background: '#7B3FE4' }}><I n="video" /></span>ویدیو<small>تا {fa(L.fileBytes / 1048576)} مگابایت</small></button>
    <button type="button" onClick={() => { kindRef.current = 'document'; pick.current!.accept = ''; pick.current!.click(); }}><span className="ic" style={{ background: 'var(--nf-ink-soft)' }}><I n="file" /></span>فایل<small>تا {fa(L.fileBytes / 1048576)} مگابایت</small></button>
    <button type="button" onClick={async () => { setPop(null); try { await bbFetch(`/bale-bot/chats/${chat.id}/request-contact`, { body: {} }); toast('درخواست شماره فرستاده شد'); refresh(); } catch (e) { err(e); } }}><span className="ic" style={{ background: '#16A085' }}><I n="contact" /></span>درخواست شماره<small>دکمه‌ی اشتراک</small></button></div></div>;
  else if (file) top = <><div className={`apv${tooBig ? ' err' : ''}`}><span className="fi"><I n={file.kind === 'photo' ? 'img' : file.kind === 'video' ? 'video' : file.kind === 'voice' ? 'mic' : 'file'} /></span><span className="tx"><b>{file.f.name}</b><span>{({ photo: 'عکس', video: 'ویدیو', voice: 'پیام صوتی', document: 'فایل' } as Record<string, string>)[file.kind]}، {bbSize(file.f.size)}</span></span><button className="ib" type="button" aria-label="برداشتن فایل" onClick={() => setFile(null)}><I n="x" /></button></div>
    {tooBig ? <p className="aerr" role="alert"><I n="alert" />این فایل {sizeMB(file.f.size)} مگابایت است؛ بله {file.kind === 'photo' ? 'عکس' : 'فایل'} را تا {fa(limit / 1048576)} مگابایت می‌فرستد. فایل کوچک‌تری انتخاب کنید.</p> : null}</>;
  else if (reply) top = <div className="czs"><I n="reply" c="i0" /><span className="tx"><b>پاسخ به {reply.dir === 'in' ? chat.name : 'پیام خودتان'}</b><span>{reply.text ?? 'پیوست'}</span></span><button className="ib" type="button" aria-label="لغو پاسخ" onClick={clear}><I n="x" /></button></div>;
  else if (edit) top = <div className="czs"><I n="pen" c="i0" /><span className="tx"><b>ویرایش پیام</b><span>{edit.text}</span></span><button className="ib" type="button" aria-label="لغو ویرایش" onClick={clear}><I n="x" /></button></div>;
  const row = rec ? <><button className="ib" type="button" aria-label="لغو ضبط" onClick={() => stopRec(false)}><I n="trash" /></button><div className="rec" role="status" aria-label="در حال ضبط پیام صوتی"><span className="dot" /><b>{bbDur(recS)}</b><span className="wv" aria-hidden="true">{WV.map((v, i) => <i key={i} style={{ height: v }} className="on" />)}</span></div>
    <button className="snd" type="button" aria-label="پایان ضبط" onClick={() => stopRec(true)}><I n="check" /></button></>
    : <><button className="ib" type="button" aria-label="پیوست" aria-expanded={pop === 'attach'} onClick={() => setPop(pop === 'attach' ? null : 'attach')} disabled={!!edit}><I n="clip" /></button>
      <button className="ib" type="button" aria-label="پاسخ‌های آماده" aria-expanded={pop === 'canned'} onClick={() => setPop(pop === 'canned' ? null : 'canned')}><I n="note" /></button>
      <textarea className={`ta3${n > 600 ? ' lng' : ''}`} rows={1} aria-label={`پیام به ${chat.name}`} placeholder={file ? 'توضیح (اختیاری)' : 'پیام بنویسید'} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      {!n && !file && !edit && typeof MediaRecorder !== 'undefined' ? <button className="ib" type="button" aria-label="ضبط پیام صوتی" onClick={startRec}><I n="mic" /></button> : null}
      <button className="snd" type="button" aria-label={edit ? 'ذخیره‌ی ویرایش' : 'ارسال'} aria-disabled={!canSend} onClick={send}><I n={edit ? 'check' : 'send'} /></button></>;
  return <div className="cz">{top}<div className="row">{row}</div>
    <input ref={pick} type="file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const k = kindRef.current === 'document' && /^video\//.test(f.type) ? 'video' : kindRef.current === 'document' && /^image\//.test(f.type) ? 'photo' : kindRef.current; setFile({ f, kind: k }); setPop(null); } }} />
    {rec ? <p className="recm"><b>{fd((recB / 1048576).toFixed(1)).replace('.', '٫')} از {fa(L.voiceBytes / 1048576)} مگابایت</b>؛ اگر بیشتر شود، به‌صورت فایل صوتی فرستاده می‌شود.</p>
      : n >= warn ? <p className="cnt" role="status">{fd(n)} از {fd(L.textMax)} نویسه</p>
      : me.view === 'all' ? <p className="czh"><I n="lock" />مشتری پیام را از ربات {chat.expert.name} می‌بیند؛ برچسب نام شما فقط در CRM است.</p> : null}
  </div>;
}

function SearchModal({ chat, toast, close, onAsk, onLead, done }: { chat: BbChat; toast: (t: string) => void; close: () => void; onAsk: () => void; onLead: () => void; done: (name: string) => void }) {
  const [q, setQ] = useState(''); const [pickId, setPick] = useState<number | null>(null); const [busy, setBusy] = useState(false);
  const term = q.trim();
  const rq = useQuery<{ results: { id: number; name: string; phone: string | null; status: string | null }[] }>({ queryKey: ['bb-search', chat.id, term], enabled: term.length >= 2, queryFn: () => bbFetch(`/bale-bot/chats/${chat.id}/search?q=${encodeURIComponent(toLatin(term))}`) });
  const R = rq.data?.results ?? []; const picked = R.find((r) => r.id === pickId);
  const link = async () => { if (!picked) return; setBusy(true); try { await bbFetch(`/bale-bot/chats/${chat.id}/link`, { body: { customerId: picked.id } }); done(picked.name); } catch (e) { toast(e instanceof BbError ? e.message : 'وصل نشد.'); } finally { setBusy(false); } };
  return <Modal cls="cf2" title="وصل کردن گفتگو به مشتری" sub={<>گفتگوی بله با {chat.name}{chat.username ? <>، <Uname u={chat.username} /></> : null}</>} onClose={close}
    foot={<><button className="btn pri" type="button" aria-disabled={!picked || busy} onClick={link}><I n="link" />{picked ? `وصل به ${picked.name}` : 'وصل'}</button><button className="btn gh" type="button" onClick={close}>انصراف</button></>}>
    <label className="srch" style={{ maxWidth: 'none' }}><I n="search" /><input type="search" aria-label="جستجوی مشتری" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} autoFocus /></label>
    <p className="hint">فقط در مشتری‌های خود شما؛ با نام، شماره یا شناسه.</p>
    {term.length >= 2 && rq.isSuccess ? R.length ? <ul className="opl" role="radiogroup" aria-label="نتیجه‌ها" style={{ marginTop: 12 }}>{R.map((r) => <li key={r.id}><button className="opo" type="button" role="radio" aria-checked={pickId === r.id} onClick={() => setPick(r.id)}><span className="rd" aria-hidden="true" /><span className="tx"><b>{r.name}<Cid id={r.id} toast={toast} /></b>{r.phone ? <Ph phone={r.phone} toast={toast} /> : null} {r.status ? CUST_STATUS[r.status] ?? r.status : ''}</span></button></li>)}</ul>
      : <div className="nores" role="status"><b>در مشتری‌های شما پیدا نشد.</b><p className="oth"><I n="lock" /><span>{OTHER_HINT}</span></p>{chat.canWrite ? <button className="btn pri sm" type="button" onClick={onAsk}><I n="contact" />درخواست شماره</button> : null}</div> : null}
    <p className="hint" style={{ marginTop: 12 }}>پیدا نشد؟ <button className="btn lk sm" type="button" onClick={onLead}><I n="plus" />ثبت سرنخ جدید</button></p>
  </Modal>;
}

function LeadModal({ me, chat, toast, close, onAsk, done }: { me: BbMe; chat: BbChat; toast: (t: string) => void; close: () => void; onAsk: () => void; done: (name: string) => void }) {
  const [s, setS] = useState(1);
  const [first, setFirst] = useState(chat.firstName ?? ''); const [last, setLast] = useState(chat.lastName ?? '');
  const [phone, setPhone] = useState(chat.verifiedPhone ? fd(chat.verifiedPhone) : ''); const [note, setNote] = useState('');
  const [state, setState] = useState<null | 'err' | 'dup' | 'ask'>(null); const [busy, setBusy] = useState(false);
  const [chk, setChk] = useState<{ phone: string; state: 'own' | 'free'; verified: boolean; customer?: { id: number; name: string } } | null>(null);
  const auto = !!chat.verifiedPhone && toLatin(phone) === chat.verifiedPhone;
  useEffect(() => { if (state === 'ask' && chat.verifiedPhone) { setPhone(fd(chat.verifiedPhone)); setState(null); } }, [chat.verifiedPhone, state]);
  const ok = PHONE_OK(phone) && first.trim().length > 0;
  const next = async () => {
    if (!PHONE_OK(phone)) { setState('err'); return; } if (!first.trim()) return; setBusy(true);
    try { const r = await bbFetch<typeof chk>(`/bale-bot/chats/${chat.id}/lead/check`, { body: { phone: toLatin(phone).replace(/[\s-]/g, '') } }); setChk(r); setState(null); setS(2); }
    catch (e) { if (e instanceof BbError && e.code === 'phone_other') setState('dup'); else if (e instanceof BbError && (e.code === 'bad_phone' || e.code === 'no_phone')) setState('err'); else toast(e instanceof BbError ? e.message : 'انجام نشد.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await bbFetch(`/bale-bot/chats/${chat.id}/lead`, { body: { phone: toLatin(phone).replace(/[\s-]/g, ''), firstName: first.trim(), lastName: last.trim(), note: note.trim() } }); done(chk?.customer?.name ?? `${first} ${last}`.trim()); }
    catch (e) { if (e instanceof BbError && e.code === 'phone_other') { setS(1); setState('dup'); } else toast(e instanceof BbError ? e.message : 'انجام نشد.'); } finally { setBusy(false); }
  };
  const sub = state === 'err' ? <p className="ferr" id="lme" role="alert"><I n="alert" />شماره‌ی موبایل لازم است؛ ۱۱ رقم که با ۰۹ شروع شود.</p>
    : state === 'dup' ? <div className="ferr dup" id="lme" role="alert"><I n="alert" /><span>این شماره قبلاً برای مشتری یک کارشناس دیگر ثبت شده است؛ سرنخ تکراری ساخته نمی‌شود. برای اتصال، از مشتری «درخواست شماره» بزنید؛ با اشتراک شماره‌ی خودش، گفتگو به همان پرونده وصل می‌شود.</span></div>
    : state === 'ask' ? <p className="lmw" id="lme" role="status"><I n="clock" />درخواست شماره فرستاده شد؛ وقتی مشتری دکمه‌ی اشتراک را بزند، همین‌جا پر می‌شود.</p>
    : auto ? <p className="lmw ok" id="lme" role="status"><I n="check" />از اشتراک شماره‌ی خود مشتری در بله پر شد.</p>
    : phone && PHONE_OK(phone) ? <p className="hint" id="lme">شماره‌ی تایپ‌شده با برچسب «تأییدنشده» ذخیره می‌شود؛ بهتر است مشتری خودش با «درخواست شماره» بفرستد.</p> : null;
  const body = s === 1 ? <>
    <div className="fld"><label className="flab" htmlFor="lf">نام</label><input id="lf" className="inp tx" value={first} onChange={(e) => setFirst(e.target.value)} />{chat.firstName ? <p className="hint">از پروفایل بله پر شد؛ می‌شود عوضش کرد.</p> : null}</div>
    <div className="fld"><label className="flab" htmlFor="ll">نام خانوادگی</label><input id="ll" className="inp tx" value={last} onChange={(e) => setLast(e.target.value)} /></div>
    <div className="fld"><label className="flab" htmlFor="lm">موبایل <span className="req">الزامی</span></label><div className="lmr">
      <input id="lm" className={`inp lt${phone ? ' phi' : ''}`} dir="ltr" inputMode="tel" required aria-required="true" value={phone} onChange={(e) => { setPhone(fd(e.target.value)); if (state !== 'ask') setState(null); }} placeholder={state === 'ask' ? 'منتظر شماره‌ی مشتری' : 'با ۰۹ شروع شود'} aria-invalid={state === 'err' || state === 'dup' ? true : undefined} aria-describedby={sub ? 'lme' : undefined} />
      {state === 'ask' || auto || !chat.canWrite ? null : <button className="btn gh sm lmq" type="button" onClick={() => { onAsk(); setState('ask'); }}><I n="contact" />درخواست شماره</button>}</div>{sub}</div>
    <div className="fld"><label className="flab" htmlFor="ln">یادداشت</label><textarea id="ln" className="ta2" value={note} onChange={(e) => setNote(e.target.value)} /></div></>
    : <><div className="rvw"><div className="r"><span className="k">نام</span><span className="v">{chk?.state === 'own' ? chk.customer?.name : `${first} ${last}`.trim()}</span></div>
      <div className="r"><span className="k">موبایل</span><span className="v"><Ph phone={chk?.phone ?? toLatin(phone)} toast={toast} />{chk && !chk.verified ? <Unverified /> : null}</span></div>
      {chat.username ? <div className="r"><span className="k">بله</span><span className="v"><Uname u={chat.username} /></span></div> : null}
      <div className="r"><span className="k">منبع</span><span className="v"><span className="chip b"><I n="bale" />بله</span></span></div>
      <div className="r"><span className="k">کارشناس</span><span className="v"><I n="lock" />{chat.expert.name}{chat.expert.id && me.view === 'own' ? '، خود شما' : ''}</span></div>
      {note.trim() ? <div className="r"><span className="k">یادداشت</span><span className="v">{note}</span></div> : null}</div>
      <p className="hint">{chk?.state === 'own' ? `این شماره مال مشتری خود شما ${chk.customer?.name} است؛ سرنخ تازه ساخته نمی‌شود و گفتگو به همان پرونده وصل می‌شود.` : 'بعد از ثبت، این گفتگو به پرونده‌ی تازه وصل می‌شود.'}</p></>;
  const foot = s === 1 ? <><button className="btn pri" type="button" aria-disabled={!ok || busy || state === 'dup'} aria-describedby={sub ? 'lme' : undefined} onClick={next}>بعدی: بررسی<I n="arrow" /></button><button className="btn gh" type="button" onClick={close}>انصراف</button></>
    : <><button className="btn pri" type="button" aria-disabled={busy} onClick={save}><I n="check" />{chk?.state === 'own' ? 'وصل به پرونده' : 'ثبت سرنخ'}</button><button className="btn gh" type="button" onClick={() => setS(1)}><I n="back" />قبلی</button></>;
  return <Modal cls="wz" title="ثبت سرنخ جدید از بله" sub={`مرحله ${fa(s)} از ۲: ${s === 1 ? 'مشخصات' : 'بررسی و ثبت'}`} onClose={close}
    steps={<Steps labels={['مشخصات', 'بررسی و ثبت']} s={s} err={s === 1 && (state === 'err' || state === 'dup')} onBack={() => setS(1)} />} foot={foot}>{body}</Modal>;
}

function ContactMeta({ chat, toast, err, refresh, onAsk, onManual, wiz }: { chat: BbChat; toast: (t: string) => void; err: (e: unknown) => void; refresh: () => void; onAsk: () => void; onManual: () => void; wiz: boolean }) {
  const c = chat.customer;
  const approve = async () => { try { await bbFetch(`/bale-bot/chats/${chat.id}/typed/approve`, { body: {} }); toast('شماره تأیید شد و گفتگو وصل شد'); refresh(); } catch (e) { err(e); } };
  const reject = async () => { try { await bbFetch(`/bale-bot/chats/${chat.id}/typed/reject`, { body: {} }); toast('شماره‌ی تایپی رد شد'); refresh(); } catch (e) { err(e); } };
  if (c && c.restricted && (c.phone || c.canOpen)) return <div className="bc-meta"><span className="chip s"><I n="link" />پرونده‌ی کارشناس دیگر</span>{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}<span className="kv">مسئول پرونده <b>{c.expert}</b></span>{c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}<p className="bc-perm">تأیید شماره فقط با کارشناس مشتری یا ادمین</p></div>;
  if (c && c.restricted) return <div className="bc-meta"><span className="chip s"><I n="link" />پرونده‌ی کارشناس دیگر</span><span className="kv">مسئول پرونده <b>{c.expert}</b></span><p className="bc-lock"><I n="lock" />شماره و جزئیات پرونده نمایش داده نمی‌شود؛ جزئیات با مسئول پرونده است.</p></div>;
  if (chat.pendingTypedPhone) return <div className="bc-meta typ"><span className="chip g"><I n="clock" />شمارهٔ تایپی، در انتظار تأیید</span><Ph phone={chat.pendingTypedPhone} toast={toast} />
    {chat.typedMatch
      ? <div className="bc-match" role="status"><div className="bc-match-id"><Ava name={chat.typedMatch.name} seed={chat.typedMatch.id} /><div className="bc-match-bd"><div className="nmr">{chat.typedMatch.name}<Cid id={chat.typedMatch.id} toast={toast} /></div>{chat.typedMatch.status ? <span className="kv">وضعیت <b>{CUST_STATUS[chat.typedMatch.status] ?? chat.typedMatch.status}</b></span> : null}</div></div><p className="bc-note">این شماره با مشتری موجود یکی است. قبل از تأیید، پرونده را ببینید.</p></div>
      : <p className="bc-note">این شماره در CRM نیست. با تأیید، لید تازه ساخته می‌شود و طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد.</p>}
    {chat.canApproveTyped ? <div className="bc-acts"><button className="btn pri sm" type="button" onClick={approve}><I n="check" />تأیید شماره</button><button className="btn gh sm" type="button" onClick={reject}>رد</button></div> : null}
  </div>;
  if (chat.waitingNumber) return <div className="bc-meta"><span className="chip mut"><I n="clock" />در انتظار اشتراک شماره</span>
    {wiz ? null : <div className="bc-acts">{chat.canResendAsk ? <button className="btn pri sm" type="button" onClick={onAsk}><I n="contact" />ارسال دوباره‌ی درخواست شماره</button> : null}
      {chat.canManualEnter ? <button className="btn gh sm" type="button" onClick={onManual}><I n="pen" />ورود دستی شماره</button> : null}</div>}
  </div>;
  if (c) return <div className="bc-meta">{chat.sourceChip ? <span className="chip src"><I n="bot" />{chat.sourceChip}</span> : chat.leadFromBale ? <span className="chip ld"><I n="plus" />لید جدید از بله</span> : null}{c.phone ? <Ph phone={c.phone} toast={toast} /> : null}
    {chat.waitingAssignment ? <span className="chip mut"><I n="clock" />در انتظار کارشناس</span> : null}
    {c.status && !chat.sharedCustomerBot ? <span className="kv">وضعیت <b>{CUST_STATUS[c.status] ?? c.status}</b></span> : null}
    {!chat.waitingAssignment ? <span className="kv">کارشناس <b>{c.expert ?? chat.assignedExpertName ?? chat.expert.name}</b></span> : null}
    {!chat.waitingAssignment && c.canOpen ? <Link className="btn gh sm" href={`/customers/${c.id}`}><I n="file" />مشاهده‌ی پرونده</Link> : null}
    {chat.sourceLine && !chat.sharedCustomerBot ? <p className="bc-src">{chat.sourceLine}</p> : null}
  </div>;
  return null;
}

function ManualWiz({ chat, toast, err, refresh, close }: { chat: BbChat; toast: (t: string) => void; err: (e: unknown) => void; refresh: () => void; close: () => void }) {
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [ferr, setFerr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ phone: string; state: string; customer: { id: number; name: string; status: string | null; expert: string | null } | null } | null>(null);
  const steps = (cur: number) => <ol className="wst" aria-label="مرحله‌های ورود دستی شماره">{['شماره', 'بررسی', 'تأیید'].map((lb, i) => {
    const n = i + 1; return <li key={lb} className={n < cur ? 'dn' : ''} aria-current={n === cur ? 'step' : undefined}><b>{n < cur ? <I n="check" /> : fa(n)}</b>{lb}{n < 3 ? <span className={`bar${n < cur ? ' on' : ''}`} aria-hidden="true" /> : null}</li>;
  })}</ol>;
  const check = async () => {
    if (!PHONE_OK(phone)) { setFerr(true); return; }
    setBusy(true);
    try { const r = await bbFetch<typeof preview & { phone: string }>(`/bale-bot/chats/${chat.id}/manual/preview`, { body: { phone: toLatin(phone).replace(/[\s-]/g, '') } }); setPreview(r); setFerr(false); setStep(3); }
    catch (e) { if (e instanceof BbError && (e.code === 'bad_phone' || e.code === 'no_phone')) setFerr(true); else err(e); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview) return; setBusy(true);
    try { await bbFetch(`/bale-bot/chats/${chat.id}/manual`, { body: { phone: preview.phone } }); toast('گفتگو وصل شد'); close(); refresh(); }
    catch (e) { err(e); } finally { setBusy(false); }
  };
  return <form className="bc-wiz" onSubmit={(e) => { e.preventDefault(); if (step === 1) void check(); else void save(); }}>
    <h3>ورود دستی شماره</h3>
    {steps(step)}
    {step === 1 ? <div className="fld">
      <label className="flab" htmlFor="bc-mn">شماره موبایل</label>
      <input className="inp lt" id="bc-mn" type="tel" inputMode="numeric" dir="ltr" autoComplete="off" aria-invalid={ferr || undefined} aria-describedby={ferr ? 'bc-mn-err bc-mn-hint' : 'bc-mn-hint'} value={phone} onChange={(e) => { setPhone(fd(e.target.value)); setFerr(false); }} />
      {ferr ? <p className="ferr" id="bc-mn-err"><I n="alert" />این شماره کامل نیست. یک شماره‌ی موبایل ۱۱ رقمی با ۰۹ بنویسید.</p> : null}
      <p className="hint" id="bc-mn-hint">شماره باید ۱۱ رقم باشد و با ۰۹ شروع شود.</p>
    </div> : <div className="fld"><span className="flab">شماره واردشده</span>{preview ? <Ph phone={preview.phone} toast={toast} /> : null}
      {preview?.customer
        ? <div className="bc-match" role="status"><div className="bc-match-id"><Ava name={preview.customer.name} seed={preview.customer.id} /><div className="bc-match-bd"><div className="nmr">{preview.customer.name}<Cid id={preview.customer.id} toast={toast} /></div>{preview.customer.status ? <span className="kv">وضعیت <b>{CUST_STATUS[preview.customer.status] ?? preview.customer.status}</b></span> : null}</div></div><p className="bc-note">این شماره با مشتری موجود یکی است. با تأیید، این گفتگو به همان پرونده وصل می‌شود.</p></div>
        : <p className="bc-note">این شماره در CRM نیست. با تأیید، لید تازه ساخته می‌شود و طبق قاعده‌ی توزیع فعلی به کارشناس می‌رسد.</p>}
    </div>}
    <div className="bc-acts">
      {step === 1 ? <><button className="btn pri sm" type="submit" disabled={busy}>بررسی شماره</button><button className="btn gh sm" type="button" onClick={close}>انصراف</button></>
        : <><button className="btn pri sm" type="submit" disabled={busy}><I n="check" />تأیید و وصل</button><button className="btn gh sm" type="button" onClick={() => setStep(1)}>برگشت</button></>}
    </div>
  </form>;
}
