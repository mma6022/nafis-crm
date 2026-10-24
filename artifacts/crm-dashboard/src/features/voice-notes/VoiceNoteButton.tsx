import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Mic, Square, AlertCircle } from 'lucide-react';
import { transcribeVoiceNote, useVoiceNotesConfig, VOICE_CONFIG_KEY, type VoiceField } from './api';
import { MAX_RECORD_SECONDS, appendTranscript, formatTimer, micErrorMessage, pickRecorderType } from './voice-note-text';
import './voice-notes.css';

type Props = {
  /** Current field text; the transcript is appended to the latest value (typing while it uploads is kept). */
  value: string;
  onChange: (next: string) => void;
  field: VoiceField;
  maxLength?: number;
  testId?: string;
};
type Phase = 'idle' | 'starting' | 'recording' | 'uploading';

/**
 * Mic button for a note field: click to start, click to stop (auto-stop at 2:00). Hidden unless the server says the
 * feature is on for this user. The transcript is APPENDED and stays editable; on any error the text is untouched.
 * Audio is only held in memory until the upload finishes.
 */
export function VoiceNoteButton({ value, onChange, field, maxLength, testId = 'voice-note' }: Props) {
  const config = useVoiceNotesConfig();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const valueRef = useRef(value); valueRef.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const barRef = useRef<HTMLDivElement>(null);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; timer: number; cancelled: boolean } | null>(null);
  const max = Math.min(MAX_RECORD_SECONDS, config.data?.maxSeconds ?? MAX_RECORD_SECONDS);

  const release = () => {
    const r = rec.current; if (!r) return;
    window.clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
  };
  useEffect(() => () => { if (rec.current) { rec.current.cancelled = true; try { rec.current.recorder.stop(); } catch { /* */ } release(); rec.current = null; } }, []);

  if (!config.data?.enabled) return null;
  const remaining = config.data.remainingSeconds;

  const stop = () => { const r = rec.current; if (r && r.recorder.state !== 'inactive') r.recorder.stop(); };

  const start = async () => {
    setError(null); setDone(false);
    if (remaining !== undefined && remaining <= 0) { setError('سقف روزانهٔ تبدیل صدا پر شده است؛ متن را تایپ کنید.'); return; }
    if (typeof window.MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { setError(micErrorMessage({ name: 'Unsupported' })); return; }
    setPhase('starting');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { setPhase('idle'); setError(micErrorMessage(e)); return; }
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); setPhase('idle'); setError(micErrorMessage(e)); return; }
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const s = (performance.now() - startedAt) / 1000;
      setElapsed(s);
      if (s >= max) stop();
    }, 250);
    rec.current = { recorder, stream, chunks, startedAt, timer, cancelled: false };
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      const r = rec.current; release(); rec.current = null;
      if (!r || r.cancelled) return;
      const seconds = Math.min(max, (performance.now() - r.startedAt) / 1000);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      chunks.length = 0;
      if (seconds < 0.8 || blob.size < 200) { setPhase('idle'); setError('ضبط خیلی کوتاه بود؛ دکمه را بزنید، صحبت کنید و دوباره بزنید.'); return; }
      setPhase('uploading');
      try {
        const out = await transcribeVoiceNote(blob, seconds, field);
        onChangeRef.current(appendTranscript(valueRef.current, out.text, maxLength));
        // Show the newly appended text: scroll the field's textarea (same wrapper) to its end.
        window.setTimeout(() => {
          const ta = barRef.current?.parentElement?.querySelector('textarea');
          if (ta) ta.scrollTop = ta.scrollHeight;
        }, 0);
        setDone(true);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'تبدیل صدا به متن انجام نشد؛ متن قبلی سر جایش است.');
      } finally {
        setPhase('idle');
        void qc.invalidateQueries({ queryKey: VOICE_CONFIG_KEY });
      }
    };
    recorder.onerror = () => { if (rec.current) rec.current.cancelled = true; release(); rec.current = null; setPhase('idle'); setError('ضبط صدا قطع شد؛ متن قبلی سر جایش است. دوباره امتحان کنید.'); };
    setElapsed(0);
    recorder.start(1000);
    setPhase('recording');
  };

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'uploading';
  const left = Math.max(0, max - elapsed);
  return (
    <div ref={barRef} className={`vn-bar${recording ? ' rec' : ''}`} data-testid={testId} data-phase={phase}>
      <button type="button" className={`vn-btn${recording ? ' rec' : ''}`} onClick={recording ? stop : () => void start()} disabled={busy}
        aria-pressed={recording} aria-label={recording ? 'پایان ضبط و تبدیل به متن' : 'ضبط صدا و تبدیل به متن'} data-testid={`${testId}-btn`}>
        {phase === 'uploading' ? <Loader2 size={16} className="vn-spin" /> : recording ? <Square size={14} fill="currentColor" /> : <Mic size={16} />}
        <span>{phase === 'uploading' ? 'در حال تبدیل…' : recording ? 'پایان ضبط' : phase === 'starting' ? 'اجازهٔ میکروفون…' : 'ضبط صدا'}</span>
      </button>
      {recording ? <span className="vn-timer" aria-live="off" data-testid={`${testId}-timer`}><span className="vn-dot" aria-hidden="true" />{formatTimer(elapsed)}<span className="vn-max"> / {formatTimer(max)}</span>{left <= 15 ? <span className="vn-warn"> · {formatTimer(left)} مانده</span> : null}</span>
        : phase === 'idle' && !error ? <span className="vn-hint">{done ? 'متن به انتهای یادداشت اضافه شد؛ قبل از ثبت بازبینی کنید.' : `حداکثر ${formatTimer(max)} دقیقه؛ متن به انتهای یادداشت اضافه می‌شود.`}</span> : null}
      {error ? <span className="vn-error" role="alert" data-testid={`${testId}-error`}><AlertCircle size={14} /> {error}</span> : null}
    </div>
  );
}
