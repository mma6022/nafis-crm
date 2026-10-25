import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Mic, MicOff, Square, AlertCircle, Check, X } from 'lucide-react';
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
  /** The note <textarea>. It is wrapped in a positioned box so the mic sits INSIDE its bottom corner. */
  children?: ReactNode;
  /** Keep the wrapper but show no mic (e.g. a read-only report). */
  off?: boolean;
};
type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading';
/** Keep recording this long after «پایان ضبط» so the last syllable is not cut off. */
const STOP_TAIL_MS = 350;
/** Speech gate: 100 ms frames louder than this RMS (≈ −38 dBFS after browser AGC) count as "voiced". */
const VOICED_RMS = 0.012;
/** Fewer voiced frames than this (≈ 0.3 s) = nothing was said → do not upload (gpt-4o-transcribe invents a greeting on silence). */
const MIN_VOICED_FRAMES = 3;
const NO_SPEECH = 'صدایی ضبط نشد. نزدیک‌تر به گوشی و در جای آرام‌تر صحبت کنید. دوباره امتحان کنید؛ متن قبلی سر جایش است.';
/** Recorder settings: mono, browser echo cancel + noise suppression + auto gain; Opus 64 kb/s (32 kb/s lost words in noise). */
const AUDIO: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const BITRATE = 64000;
type Meter = { ctx: AudioContext; timer: number; voiced: number };
/** Count voiced 100 ms frames on the live stream; null when Web Audio is unavailable (then no gate). */
function startMeter(stream: MediaStream): Meter | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const m: Meter = { ctx, timer: 0, voiced: 0 };
    m.timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      if (Math.sqrt(sum / buf.length) > VOICED_RMS) m.voiced++;
    }, 100);
    void ctx.resume?.();
    return m;
  } catch { return null; }
}
const DENIED = 'اجازهٔ میکروفون داده نشد. از نماد قفل کنار نشانی مرورگر، «میکروفون» را روی «اجازه» بگذارید و دوباره دکمهٔ میکروفون را بزنید. متن یادداشت سر جایش است و می‌توانید تایپ کنید.';

/**
 * Note field + mic. The textarea (children) is wrapped in `.vn-field`; when the server says the feature is on for this
 * user a small round mic button sits inside the box's bottom inline-end corner (bottom-left in RTL) and the textarea
 * gets an inline-end gutter, so text, caret and the counter below never run under it. Status (recording timer + stop,
 * transcribing, inserted + undo, error, permission denied) is a single line UNDER the box, never over it.
 * Click to start, click again (or «پایان ضبط») to stop; auto-stop at 2:00. The transcript is APPENDED and stays
 * editable; on any error the text is untouched. Audio is only held in memory until the upload finishes.
 */
export function VoiceNoteButton({ value, onChange, field, maxLength, testId = 'voice-note', children, off = false }: Props) {
  const config = useVoiceNotesConfig();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [done, setDone] = useState<{ before: string; after: string } | null>(null);
  const valueRef = useRef(value); valueRef.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const boxRef = useRef<HTMLDivElement>(null);
  const doneTimer = useRef(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; timer: number; cancelled: boolean; meter: Meter | null } | null>(null);
  const max = Math.min(MAX_RECORD_SECONDS, config.data?.maxSeconds ?? MAX_RECORD_SECONDS);

  const release = () => {
    const r = rec.current; if (!r) return;
    window.clearInterval(r.timer);
    if (r.meter) { window.clearInterval(r.meter.timer); void r.meter.ctx.close().catch(() => undefined); }
    r.stream.getTracks().forEach((t) => t.stop());
  };
  useEffect(() => () => { window.clearTimeout(doneTimer.current); if (rec.current) { rec.current.cancelled = true; try { rec.current.recorder.stop(); } catch { /* */ } release(); rec.current = null; } }, []);

  const enabled = Boolean(config.data?.enabled) && !off;
  // The wrapper is always rendered (even while the config loads or when the feature is off) so the textarea is never
  // re-mounted and never loses focus/caret when the mic appears.
  if (!enabled) return <div className="vn-field" ref={boxRef}>{children}</div>;
  const remaining = config.data?.remainingSeconds;

  const stop = () => {
    const r = rec.current; if (!r || r.recorder.state === 'inactive') return;
    setPhase('stopping');
    window.setTimeout(() => { try { if (r.recorder.state !== 'inactive') { r.recorder.requestData(); r.recorder.stop(); } } catch { /* */ } }, STOP_TAIL_MS);
  };

  const start = async () => {
    setError(null); setDone(null); setDenied(false); window.clearTimeout(doneTimer.current);
    if (remaining !== undefined && remaining <= 0) { setError('سقف روزانهٔ تبدیل صدا پر شده است؛ متن را تایپ کنید.'); return; }
    if (typeof window.MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { setError(micErrorMessage({ name: 'Unsupported' })); return; }
    setPhase('starting');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }); }
    catch (e) {
      setPhase('idle');
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') { setDenied(true); setError(DENIED); } else setError(micErrorMessage(e));
      return;
    }
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: BITRATE } : { audioBitsPerSecond: BITRATE }); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); setPhase('idle'); setError(micErrorMessage(e)); return; }
    const chunks: Blob[] = [];
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const s = (performance.now() - startedAt) / 1000;
      setElapsed(s);
      if (s >= max && rec.current?.recorder.state === 'recording') { try { rec.current.recorder.stop(); } catch { /* */ } }
    }, 250);
    rec.current = { recorder, stream, chunks, startedAt, timer, cancelled: false, meter: startMeter(stream) };
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      const r = rec.current; release(); rec.current = null;
      if (!r || r.cancelled) { setPhase('idle'); return; }
      const seconds = Math.min(max, (performance.now() - r.startedAt) / 1000);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      chunks.length = 0;
      if (seconds < 0.8 || blob.size < 200) { setPhase('idle'); setError('ضبط خیلی کوتاه بود؛ دکمه را بزنید، صحبت کنید و دوباره بزنید.'); return; }
      if (r.meter && r.meter.voiced < MIN_VOICED_FRAMES) { setPhase('idle'); setError(NO_SPEECH); return; }
      setPhase('uploading');
      try {
        const out = await transcribeVoiceNote(blob, seconds, field);
        const before = valueRef.current;
        const after = appendTranscript(before, out.text, maxLength);
        onChangeRef.current(after);
        // Show the newly appended text: scroll the wrapped textarea to its end.
        window.setTimeout(() => {
          const ta = boxRef.current?.querySelector('textarea');
          if (ta) ta.scrollTop = ta.scrollHeight;
        }, 0);
        setDone({ before, after });
        doneTimer.current = window.setTimeout(() => setDone(null), 12000);
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

  const recording = phase === 'recording' || phase === 'stopping';
  const busy = phase === 'starting' || phase === 'uploading' || phase === 'stopping';
  const left = Math.max(0, max - elapsed);
  const undo = () => { if (done && valueRef.current === done.after) onChangeRef.current(done.before); setDone(null); window.clearTimeout(doneTimer.current); };
  const micLabel = recording ? 'پایان ضبط و تبدیل به متن' : phase === 'uploading' ? 'در حال تبدیل صدا به متن' : denied ? 'میکروفون مسدود است؛ دوباره امتحان کنید' : 'ضبط صدا و تبدیل به متن';
  return (
    <>
      <div ref={boxRef} className={`vn-field vn-on${recording ? ' rec' : ''}`} data-testid={testId} data-phase={phase}>
        {children}
        <button type="button" className={`vn-mic${recording ? ' rec' : ''}${denied && phase === 'idle' ? ' off' : ''}`}
          onClick={phase === 'recording' ? stop : () => void start()} disabled={busy} title={micLabel}
          aria-pressed={recording} aria-label={micLabel} data-testid={`${testId}-btn`}>
          {phase === 'uploading' || phase === 'starting' || phase === 'stopping' ? <Loader2 size={16} className="vn-spin" />
            : recording ? <Square size={12} fill="currentColor" /> : denied ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
      </div>
      {recording ? (
        <div className="vn-bar rec" data-testid={`${testId}-bar`}>
          <span className="vn-timer" aria-live="off" data-testid={`${testId}-timer`}><span className="vn-dot" aria-hidden="true" />{formatTimer(elapsed)}<span className="vn-max"> / {formatTimer(max)}</span></span>
          <span className="vn-msg">{left <= 15 ? <span className="vn-warn">{formatTimer(left)} مانده</span> : 'در حال ضبط… حرف بزنید'}</span>
          <button type="button" className="vn-stop" onClick={stop} disabled={phase === 'stopping'} data-testid={`${testId}-stop`}><Square size={11} fill="currentColor" /> پایان ضبط</button>
        </div>
      ) : phase === 'starting' ? (
        <div className="vn-bar" data-testid={`${testId}-bar`}><span className="vn-msg">در انتظار اجازهٔ میکروفون…</span></div>
      ) : phase === 'uploading' ? (
        <div className="vn-bar busy" data-testid={`${testId}-bar`} aria-live="polite"><Loader2 size={14} className="vn-spin" /><span className="vn-msg">در حال تبدیل صدا به متن… <span className="vn-sub">می‌توانید تایپ را ادامه دهید.</span></span></div>
      ) : error ? (
        <div className={`vn-bar err${denied ? ' denied' : ''}`} data-testid={`${testId}-bar`}>
          <span className="vn-error" role="alert" data-testid={`${testId}-error`}>{denied ? <MicOff size={14} /> : <AlertCircle size={14} />}<span>{error}</span></span>
          <button type="button" className="vn-x" onClick={() => setError(null)} aria-label="بستن" data-testid={`${testId}-dismiss`}><X size={14} /></button>
        </div>
      ) : done ? (
        <div className="vn-bar ok" data-testid={`${testId}-bar`} aria-live="polite">
          <Check size={14} /><span className="vn-msg">متن به انتهای یادداشت اضافه شد؛ قبل از ثبت بازبینی کنید.</span>
          <button type="button" className="vn-undo" onClick={undo} data-testid={`${testId}-undo`}>برگرداندن</button>
        </div>
      ) : null}
    </>
  );
}
