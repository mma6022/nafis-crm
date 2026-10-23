import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, RefreshCw } from 'lucide-react';
import {
  useGetVoipRecordingTranscript, getGetVoipRecordingTranscriptQueryKey, useCreateVoipRecordingTranscript,
  type VoipRecordingTranscript,
} from '@workspace/api-client-react';
import { Modal } from '@/components/DataTools';
import { SkeletonPanel } from '@/components/CrmShell';
import { TranscriptSummary } from './TranscriptSummary';

const fa = (n: number) => n.toLocaleString('fa-IR');
const mmss = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${fa(Math.floor(t / 60)).padStart(2, '۰')}:${fa(t % 60).padStart(2, '۰')}`; };
const phaseLabels: Record<string, string> = {
  downloading: 'دریافت فایل', cleaning: 'نویزگیری و بررسی کانال‌ها', transcribing: 'تفکیک گویندگان و تبدیل گفتار',
};
const badgeColors = [['#e0ecff', '#1d4ed8'], ['#fde7d6', '#b45309'], ['#dcf5e7', '#047857'], ['#f3e1fb', '#7e22ce'], ['#fde2e4', '#be123c']];

function msg(err: unknown, fallback: string): { status?: number; text: string } {
  const e = err as { status?: number; data?: { error?: unknown } | null } | null;
  const server = typeof e?.data?.error === 'string' && e.data.error.trim() ? e.data.error : null;
  const labels: Record<number, string> = {
    401: 'نشست شما پایان یافته؛ دوباره وارد شوید.', 403: 'اجازه مشاهده یا ایجاد متن مکالمه را ندارید.', 404: 'فایل ضبط‌شده پیدا نشد.',
  };
  return { status: e?.status, text: server || (e?.status && labels[e.status]) || fallback };
}

export function TranscriptDialog({ recordingId, from, to, onClose }: { recordingId: string; from: string; to: string; onClose: () => void }) {
  const qc = useQueryClient();
  const params = { from, to };
  const key = getGetVoipRecordingTranscriptQueryKey(recordingId, params);
  const q = useGetVoipRecordingTranscript(recordingId, params, {
    query: {
      queryKey: key, retry: false, gcTime: 0,
      refetchInterval: (query) => { const t = query.state.data; return t?.state === 'queued' || t?.state === 'processing'
        || t?.summaryState === 'queued' || t?.summaryState === 'processing' ? 2500 : false; },
    },
  });
  const create = useCreateVoipRecordingTranscript();
  const [postErr, setPostErr] = useState<string | null>(null);
  const [showTurns, setShowTurns] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const autoStarted = useRef(false);
  const t: VoipRecordingTranscript | undefined = q.isError ? undefined : q.data;

  const generate = async (regenerate = false) => {
    setPostErr(null);
    try {
      await qc.cancelQueries({ queryKey: key });
      const res = await create.mutateAsync({ id: recordingId, data: { from, to, regenerate } });
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData(key, res);
    } catch (e) { setPostErr(msg(e, 'شروع تبدیل مکالمه به متن ناموفق بود؛ دوباره تلاش کنید.').text); }
  };
  const generateRef = useRef(generate);
  generateRef.current = generate;

  useEffect(() => {
    if (t && t.state === 'not_started' && t.canGenerate && !autoStarted.current) {
      autoStarted.current = true;
      void generateRef.current();
    }
  }, [t]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(t?.text ?? ''); setCopyMsg({ ok: true, text: 'متن کپی شد.' }); }
    catch { setCopyMsg({ ok: false, text: 'کپی انجام نشد؛ مرورگر اجازه دسترسی به کلیپ‌بورد را نداد. متن را دستی انتخاب کنید.' }); }
  };

  const err = q.isError ? msg(q.error, 'دریافت متن مکالمه ناموفق بود.') : null;
  const speakerIdx = (id: string) => Math.max(0, t?.speakers.findIndex((s) => s.id === id) ?? 0);
  const label = (id: string) => t?.speakers.find((s) => s.id === id)?.label ?? 'گوینده';
  const active = t && (t.state === 'queued' || t.state === 'processing');

  return <Modal title="متن مکالمه" eyebrow="تبدیل مکالمه به متن" onClose={onClose} testId="call-transcript" wide>
    <div data-testid="transcript-state" data-state={t?.state ?? (err ? 'error' : 'loading')} style={{ display: 'grid', gap: 12 }}>
      {q.isLoading ? <SkeletonPanel rows={4} /> : null}

      {err ? <div className="error-state" role="alert" data-testid="transcript-error"><span>{err.text}</span>
        <button className="btn btn-ghost" onClick={() => q.refetch()} data-testid="button-transcript-retry"><RefreshCw size={14} /> تلاش دوباره</button></div> : null}

      {postErr ? <div className="error-state" role="alert" data-testid="transcript-error"><span>{postErr}</span>
        {t?.canGenerate ? <button className="btn btn-ghost" disabled={create.isPending} onClick={() => void generate()} data-testid="button-transcript-retry"><RefreshCw size={14} /> تلاش دوباره</button> : null}</div> : null}

      {t && t.state === 'not_started' ? (t.canGenerate
        ? <p className="subtle-note">{postErr ? 'درخواست تبدیل هنوز ثبت نشده است.' : 'در حال ارسال درخواست تبدیل...'}</p>
        : <p className="subtle-note">برای این تماس هنوز متنی ساخته نشده و شما اجازه ایجاد آن را ندارید.</p>) : null}

      {(create.isPending || active || (t && t.state === 'not_started' && t.canGenerate && !postErr)) ? <div className="subtle-note" role="status">
        <strong>{active && t.phase ? phaseLabels[t.phase] : t?.state === 'queued' ? 'در صف پردازش' : 'در حال آماده‌سازی'}</strong>
        <div>{t?.notice ?? 'تبدیل مکالمه ممکن است چند دقیقه طول بکشد. می‌توانید پنجره را ببندید؛ پردازش ادامه می‌یابد و با باز کردن دوباره ادامه همین کار نمایش داده می‌شود.'}</div>
        <div>این تبدیل با OpenAI و از طریق حساب موجود شرکت انجام می‌شود (نه اعتبار Replit) و فایل ضبط‌شده برای تبدیل ارسال می‌شود.</div>
      </div> : null}

      {t && t.state === 'failed' ? <div className="error-state" role="alert" data-testid="transcript-error">
        <span>{t.error || 'تبدیل مکالمه به متن ناموفق بود.'}</span>
        {t.canGenerate ? <button className="btn btn-primary" disabled={create.isPending} onClick={() => void generate()} data-testid="button-transcript-retry"><RefreshCw size={14} /> تلاش دوباره برای تبدیل</button> : null}
      </div> : null}

      {t && t.state === 'completed' ? <>
        <div className="subtle-note" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {t.audioSeparation === 'stereo_channels' ? <span>کانال‌های صوتی به‌صورت جداگانه تفکیک شد.</span> : null}
          {t.audioSeparation === 'diarization' ? <span>صدای تک‌کاناله؛ تفکیک زمانی گویندگان تقریبی است.</span> : null}
          {t.durationSeconds != null ? <span>مدت: {mmss(t.durationSeconds)}</span> : null}
        </div>
        {t.notice ? <p className="subtle-note">{t.notice}</p> : null}
        <p className="subtle-note" role="note">این متن توسط ماشین تولید شده است؛ نام‌ها و اعداد را با فایل ضبط‌شده مطابقت دهید. در صدای تک‌کاناله، تفکیک گفتار هم‌زمان تضمین نمی‌شود.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={copy} disabled={!t.text} data-testid="button-transcript-copy"><Copy size={14} /> کپی متن کامل</button>
          {t.canGenerate ? <button className="btn btn-ghost" disabled={create.isPending} data-testid="button-transcript-regenerate"
            onClick={() => { if (window.confirm('این تماس با مدل جدید دوباره تبدیل و متن قبلی جایگزین می‌شود. تبدیل مجدد هزینهٔ سرویس OpenAI دارد؛ ادامه می‌دهید؟')) void generate(true); }}>
            <RefreshCw size={14} /> تبدیل مجدد با مدل جدید
          </button> : null}
          {copyMsg ? <span role={copyMsg.ok ? 'status' : 'alert'} className={copyMsg.ok ? 'subtle-note' : 'form-error'}>{copyMsg.text}</span> : null}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn ${!showTurns ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowTurns(false)}>متن کامل</button>
          <button className={`btn ${showTurns ? 'btn-primary' : 'btn-ghost'}`} disabled={!t.segments.length} onClick={() => setShowTurns(true)}>زمان‌بندی و گویندگان (تقریبی)</button>
        </div>
        {!showTurns ? <div data-testid="transcript-full-text" style={{ whiteSpace: 'pre-wrap', lineHeight: 2, maxHeight: '55dvh', overflowY: 'auto' }}>
          {t.text || 'گفتار قابل تشخیصی پیدا نشد.'}
        </div> : <div style={{ display: 'grid', gap: 8, maxHeight: '55dvh', overflowY: 'auto' }}>
            {t.segments.map((s, i) => { const [bg, fg] = badgeColors[speakerIdx(s.speakerId) % badgeColors.length];
              return <div key={i} data-testid={`transcript-segment-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={{ background: bg, color: fg, borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{label(s.speakerId)}</span>
                <span dir="ltr" className="secondary-cell" style={{ fontSize: 12 }}>{mmss(s.startSeconds)}</span>
                <p style={{ margin: 0, flex: '1 1 220px', lineHeight: 1.9 }}>{s.text}</p>
              </div>; })}
          </div>}
        <TranscriptSummary transcript={t} recordingId={recordingId} from={from} to={to} />
      </> : null}
    </div>
  </Modal>;
}
