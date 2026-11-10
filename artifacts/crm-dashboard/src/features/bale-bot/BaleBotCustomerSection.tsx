/* bale v1.1: «بله» section inside the customer file (design scene file_tl / file_other). Renders nothing while the flag is OFF
   or when the customer has no Bale chat the viewer may see. */
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import './bale-bot.css';
import { bbFetch, useBaleBotMe, bbListTime, bbDur, type BbChat, type BbMessage } from './api';
import { I, Uname } from './ui';

type C = BbChat & { canOpen: boolean; timeline: BbMessage[] };
const IC: Record<string, string> = { text: 'chat', photo: 'img', video: 'video', animation: 'video', document: 'doc', voice: 'play', audio: 'play', sticker: 'img', contact: 'contact', location: 'pin' };
const line = (m: BbMessage) => m.deleted ? 'پیام حذف شد' : m.kind === 'text' ? (m.text?.trim() === '/start' ? 'شروع گفتگو' : (m.text ?? '').slice(0, 90))
  : m.kind === 'photo' ? `عکس${m.text ? `: ${m.text}` : ''}` : m.kind === 'voice' ? `پیام صوتی، ${bbDur(m.file?.duration)}` : m.kind === 'contact' ? 'اشتراک شماره' : m.kind === 'location' ? 'موقعیت'
  : `${m.file?.name ?? 'فایل'}${m.file?.state === 'stored' ? '، در پرونده ذخیره شد' : ''}`;

export default function BaleBotCustomerSection({ customerId }: { customerId: number }) {
  const me = useBaleBotMe().data;
  const q = useQuery<{ chats: C[] }>({ queryKey: ['bb-cust', customerId], enabled: !!me && customerId > 0, queryFn: () => bbFetch(`/bale-bot/customers/${customerId}`), retry: false });
  if (!me || !q.data?.chats.length) return null;
  return <div className="bbt" dir="rtl" id="sec-bale" data-testid="bale-bot-customer">{q.data.chats.map((c) => { const mine = c.notices.some((n) => n.kind === 'file_other'); return <section key={c.id} className="card" aria-label="گفتگوی بله" style={{ marginTop: 14 }}>
    {c.notices.filter((n) => n.kind === 'linked_other' || n.kind === 'file_other').map((n) => <div key={n.id} className="ntc" role="status"><I n="bell" /><span>{n.actor ?? 'کارشناس دیگر'} گفتگوی بله‌ی {c.name} را به این پرونده وصل کرد؛ مسئول پرونده همچنان شما هستید.</span></div>)}
    <div className="fbar"><b>گفتگوی بله با {c.username ? <Uname u={c.username} /> : c.name}</b>{c.canOpen ? <Link className="btn pri sm" href={`/bale-bot/${c.id}`}><I n="chat" />باز کردن گفتگو</Link> : <span className="chip b"><I n="bot" />ربات {c.expert.name}</span>}</div>
    {mine ? <div style={{ margin: '0 0 10px' }}><span className="chip">مسئول: {me.name} (شما)</span></div> : null}
    <ul className="ftl">{c.timeline.map((m) => <li key={m.id}><span className={`ic${m.dir === 'out' ? ' o' : ''}`}><I n={IC[m.kind] ?? 'chat'} /></span><span className="tx">{line(m)}<small>{m.dir === 'out' ? m.author ?? c.expert.name : 'مشتری'}</small></span><span className="tm">{bbListTime(m.at)}</span></li>)}</ul>
  </section>; })}</div>;
}
