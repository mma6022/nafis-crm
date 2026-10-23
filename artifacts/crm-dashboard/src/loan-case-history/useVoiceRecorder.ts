import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_FILE_BYTES, MAX_RECORD_SECONDS } from './api';

export function useVoiceRecorder(onFile: (file: File) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const discard = useRef(false);
  const alive = useRef(true);
  const starting = useRef(false);
  const generation = useRef(0);
  const cb = useRef({ onFile, onError }); cb.current = { onFile, onError };
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const release = useCallback(() => {
    if (timer.current != null) { window.clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    discard.current = true;
    const r = rec.current; rec.current = null;
    if (r && r.state !== 'inactive') { r.onstop = null; r.ondataavailable = null; try { r.stop(); } catch { /* already stopped */ } }
    release();
    if (alive.current) { setRecording(false); setSeconds(0); }
  }, [release]);

  const stop = useCallback(() => { const r = rec.current; if (r && r.state === 'recording') r.stop(); }, []);

  const start = useCallback(async () => {
    if (rec.current || starting.current) return;
    if (!supported) { cb.current.onError('ضبط صدا در این مرورگر پشتیبانی نمی‌شود؛ می‌توانید فایل صوتی پیوست کنید.'); return; }
    starting.current = true;
    const current = generation.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current || current !== generation.current) { s.getTracks().forEach(t => t.stop()); return; }
      stream.current = s; discard.current = false;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = []; let bytes = 0;
      r.ondataavailable = e => {
        if (!e.data.size) return;
        chunks.push(e.data); bytes += e.data.size;
        if (bytes >= MAX_FILE_BYTES && r.state === 'recording') r.stop();
      };
      r.onstop = () => {
        release(); rec.current = null;
        if (alive.current) { setRecording(false); setSeconds(0); }
        if (discard.current || !alive.current) return;
        const type = (r.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) { cb.current.onError('صدایی ضبط نشد.'); return; }
        if (blob.size > MAX_FILE_BYTES) { cb.current.onError('حجم پیام صوتی نباید بیشتر از ۱۶ مگابایت باشد.'); return; }
        cb.current.onFile(new File([blob], `voice-${Date.now()}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`, { type }));
      };
      rec.current = r; r.start(1000); setRecording(true); setSeconds(0);
      const t0 = Date.now();
      timer.current = window.setInterval(() => {
        const sec = Math.floor((Date.now() - t0) / 1000);
        setSeconds(sec);
        if (sec >= MAX_RECORD_SECONDS) stop();
      }, 250);
    } catch (e) {
      release();
      cb.current.onError(e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        ? 'اجازه دسترسی به میکروفون داده نشد. از تنظیمات مرورگر مجاز کنید یا فایل صوتی پیوست کنید.'
        : e instanceof DOMException && e.name === 'NotFoundError' ? 'میکروفونی پیدا نشد؛ فایل صوتی پیوست کنید.'
        : 'میکروفون در دسترس نیست؛ فایل صوتی پیوست کنید.');
    } finally { starting.current = false; }
  }, [supported, release, stop]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; cancel(); }; }, [cancel]);
  return { recording, seconds, supported, start, stop, cancel };
}
