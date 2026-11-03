/** FILES-LOCK stage 2 (today-split-files-board v1.0.4 §2, screens 12-files_lock / 13-new_file): while «مشتریان بالفعل» tasks remain today,
 *  «پرونده‌های من» shows this page instead of the list. Only with the user's own flag.files_lock (server-checked, OFF by default).
 *  The server blocks writes on other own files (423 files_lock); reads stay open; «ثبت پرونده جدید» (the existing wizard) is always open. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ClipboardCheck, Lock, Plus } from 'lucide-react';
import { faNum } from '@/features/call-queue/api';
import { CreateWizard } from '@/components/loan-applications/CreateWizard';
import { fcApi, type FcView } from '@/features/files-carousel/api';
import FilesCarousel from '@/features/files-carousel/FilesCarousel';
import '@/features/daily-plan/daily-plan.css';
import './today-split.css';

/** Locked = tasks remain and the list has not opened today (unlock never re-locks: list_opened_at stays set). */
import FilesBoard from './FilesBoard';
export const flLocked = (v: FcView | undefined) => {
  if (!v) return null;
  const remaining = v.cards.filter((c) => c.state !== 'done').length;
  return remaining > 0 && !v.split?.unlocked && v.mode !== 'list' ? { remaining, total: v.cards.length, done: v.cards.length - remaining } : null;
};

export default function FilesLockGate({ board = false }: { board?: boolean }) {
  const q = useQuery({ queryKey: ['files-carousel', 'today'], queryFn: fcApi.today, refetchInterval: 60_000, retry: false });
  if (q.isLoading) return <div className="dp-page"><div className="dp-skel" role="status">در حال بارگذاری پرونده‌ها…</div></div>;
  const l = flLocked(q.data);
  if (!l) return board ? <FilesBoard /> : <FilesCarousel />; // FILES-BOARD (stage 3): own flag; else the stage-2 carousel/list
  return <FilesLock {...l} />;
}

function FilesLock({ remaining, total, done }: { remaining: number; total: number; done: number }) {
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  return <div className="ts-page fl-page" data-testid="fl-page">
    <section className="dp-box fl-card" aria-labelledby="fl-t" data-testid="fl-lock">
      <span className="fl-ic" aria-hidden="true"><Lock size={24} /></span>
      <h1 id="fl-t">اول تسک‌های مشتریان بالفعل رو تموم کن، بعد پرونده‌ها باز می‌شه</h1>
      <p className="fl-n" data-testid="fl-left">{faNum(remaining)} تسک مانده</p>
      <small className="fl-of">از {faNum(total)} تسک امروز</small>
      <div className="dp-bar ts-bar fl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="پیشرفت تسک‌های بالفعل"><i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
      <Link href="/today" className="btn btn-primary fl-go" data-testid="fl-go"><ClipboardCheck size={18} aria-hidden="true" /> برو به مشتریان بالفعل</Link>
      <hr className="fl-sep" />
      <p className="fl-new-t">پرونده‌ی تازه داری؟ ثبت پرونده همیشه باز است.</p>
      <button type="button" className="btn btn-ghost fl-new" onClick={() => setWizard(true)} data-testid="fl-new"><Plus size={16} aria-hidden="true" /> ثبت پرونده جدید</button>
    </section>
    {wizard ? <CreateWizard onClose={() => { setWizard(false); void qc.invalidateQueries({ queryKey: ['files-carousel', 'today'] }); }} /> : null}
  </div>;
}
