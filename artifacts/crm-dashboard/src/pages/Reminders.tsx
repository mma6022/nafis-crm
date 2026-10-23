import { BellRing, Check, Clock3, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTableState } from '@/hooks/use-table-state';
import { useQueryClient } from '@tanstack/react-query';
import { getListRemindersQueryKey, useListReminders, useUpdateReminder, type Reminder } from '@workspace/api-client-react';
import { ErrorState, formatDateTime, SkeletonPanel } from '@/components/CrmShell';
import { ReminderDetailsDialog } from '@/components/reminders/ReminderDetailsDialog';

export default function Reminders() {
  const [tab, setTab] = useTableState<'open' | 'done'>('reminders.tab', 'open');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const closeDetails = useCallback(() => setSelectedId(null), []);
  const queryClient = useQueryClient();
  const params = useMemo(() => ({ done: tab === 'done' }), [tab]);
  const reminders = useListReminders(params, { query: { queryKey: getListRemindersQueryKey(params), refetchInterval: 15_000 } });
  const update = useUpdateReminder();
  const toggle = (reminder: Reminder) => update.mutate({ data: { id: reminder.id, done: !reminder.done } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey({ done: false }) }); queryClient.invalidateQueries({ queryKey: getListRemindersQueryKey({ done: true }) }); } });
  const list = reminders.data ?? [];
  const selected = list.find(reminder => reminder.id === selectedId);
  return <section>
    <div className="page-intro"><div><div className="eyebrow">پیگیری‌های شخصی تیم</div><h2>یادآورها</h2><p>قرار نیست هیچ تماس مهمی از قلم بیفتد.</p></div><div className="metric-icon gold" style={{ width: 42, height: 42 }}><BellRing size={20} /></div></div>
    <div className="toolbar" style={{ justifyContent: 'space-between' }}><div style={{ display: 'flex', gap: 6 }}><button className={`btn ${tab === 'open' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('open')} data-testid="button-open-reminders"><Clock3 size={15} /> باز</button><button className={`btn ${tab === 'done' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('done')} data-testid="button-done-reminders"><Check size={15} /> انجام‌شده</button></div><span style={{ color: '#8d97a6', fontSize: 11 }}>{list.length.toLocaleString('fa-IR')} یادآور در این نما</span></div>
    {reminders.isLoading ? <SkeletonPanel rows={4} /> : reminders.isError ? <ErrorState onRetry={() => reminders.refetch()} /> : list.length ? <div className="reminder-grid"><div className="reminder-list">{list.map((reminder) => <ReminderItem key={reminder.id} reminder={reminder} pending={update.isPending} onToggle={() => toggle(reminder)} onOpen={() => setSelectedId(reminder.id)} />)}</div><div className="panel" style={{ background: '#f7f8fa' }}><div className="panel-head"><div><h3>ریتم پیگیری</h3><p>یادآورها را بعد از هر تماس به‌روز کنید.</p></div><RotateCcw size={18} color="#9aa4b3" /></div><div style={{ display: 'grid', gap: 12 }}><div style={{ borderRight: '3px solid #e9b84d', paddingRight: 12 }}><strong style={{ color: '#23375e', fontSize: 12 }}>اولویت با نزدیک‌ترین موعد</strong><p style={{ color: '#7a8595', fontSize: 11, lineHeight: 1.8, margin: '5px 0 0' }}>موعدها را به ترتیب زمان ببینید تا جریان کار روزانه روشن بماند.</p></div><div style={{ borderRight: '3px solid #3f918a', paddingRight: 12 }}><strong style={{ color: '#23375e', fontSize: 12 }}>ثبت نتیجه تماس</strong><p style={{ color: '#7a8595', fontSize: 11, lineHeight: 1.8, margin: '5px 0 0' }}>در پرونده مشتری، زمینه و نتیجه هر مکالمه را ثبت کنید.</p></div></div></div></div> : <div className="panel"><div className="empty-state"><BellRing /><strong>{tab === 'open' ? 'یادآور بازی ندارید' : 'هنوز موردی تکمیل نشده'}</strong><p>{tab === 'open' ? 'صف شما خلوت است؛ زمان خوبی برای رسیدگی به پرونده‌های مهم.' : 'با انجام یادآورها، تاریخچه پیگیری اینجا جمع می‌شود.'}</p></div></div>}
    {selected && <ReminderDetailsDialog reminder={selected} onClose={closeDetails} />}
  </section>;
}

function ReminderItem({ reminder, pending, onToggle, onOpen }: { reminder: Reminder; pending: boolean; onToggle: () => void; onOpen: () => void }) {
  return <div className="reminder-item" data-testid={`reminder-${reminder.id}`} onClick={onOpen}><button type="button" className={`reminder-check ${reminder.done ? 'done' : ''}`} onClick={event => { event.stopPropagation(); onToggle(); }} disabled={pending} aria-label={reminder.done ? 'بازگرداندن یادآور' : 'تکمیل یادآور'} data-testid={`button-toggle-reminder-${reminder.id}`}>{reminder.done ? <Check size={16} /> : <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d5dce4' }} />}</button><button type="button" className="reminder-details-trigger" aria-haspopup="dialog" aria-label={`مشاهده جزئیات یادآور: ${reminder.subject}`} data-testid={`button-reminder-details-${reminder.id}`} onClick={event => { event.stopPropagation(); onOpen(); }}><strong style={{ textDecoration: reminder.done ? 'line-through' : 'none', opacity: reminder.done ? .65 : 1 }}>{reminder.subject}</strong>{reminder.customerName ? <><span className="secondary-cell">مشتری: {reminder.customerName}</span><span className="secondary-cell">کارشناس پرونده: {reminder.customerSalespersonName || 'بدون تخصیص'}</span></> : null}<span style={{ display: 'block', color: '#64748b', fontSize: 11, lineHeight: 1.8, margin: '5px 0 0' }}>{reminder.message}</span><time>{formatDateTime(reminder.remindAt)} · ایجاد شده در {formatDateTime(reminder.createdAt)}</time><span className="secondary-cell">مشاهده جزئیات</span></button></div>;
}
