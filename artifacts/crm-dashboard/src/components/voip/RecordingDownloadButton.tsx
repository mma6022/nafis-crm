import { useState } from 'react';
import { Download } from 'lucide-react';
import './RecordingDownloadButton.css';

export function simotelRecordingDownloadUrl(id: string, from: string, to: string) {
  const q = new URLSearchParams({ from, to });
  return `/api/voip/recordings/${encodeURIComponent(id)}/download?${q}`;
}

export function voipCallRecordingDownloadUrl(eventId: number) {
  return `/api/voip-call/calls/${eventId}/download`;
}

async function saveRecording(href: string) {
  const res = await fetch(href, { credentials: 'include' });
  if (!res.ok) {
    let msg = 'دریافت فایل صوتی ناموفق بود.';
    try {
      const j = await res.clone().json();
      if (typeof j?.error === 'string' && j.error && !/^[a-z0-9_]+$/i.test(j.error)) msg = j.error;
      else if (typeof j?.message === 'string' && j.message) msg = j.message;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const quoted = /filename="([^"]+)"/.exec(disp)?.[1];
  const name = quoted && /^call-[A-Za-z0-9_.-]+-\d{4}-\d{2}-\d{2}\.[A-Za-z0-9]{1,8}$/.test(quoted)
    ? quoted
    : 'call-recording.mp3';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function RecordingDownloadButton({ href, missing, testId = 'button-recording-download' }: {
  href?: string | null;
  missing?: boolean;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (missing || !href) {
    return <p className="rec-dl-missing" role="status" data-testid={`${testId}-missing`}>فایل صوتی این تماس ذخیره نشده است.</p>;
  }
  return (
    <div className="rec-dl">
      <button
        type="button"
        className="btn btn-ghost rec-dl-btn"
        data-testid={testId}
        aria-label="دانلود فایل صوتی"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void saveRecording(href)
            .catch((e) => setError(e instanceof Error ? e.message : 'دریافت فایل صوتی ناموفق بود.'))
            .finally(() => setBusy(false));
        }}
      >
        <Download size={16} aria-hidden />
        {busy ? 'در حال دریافت…' : 'دانلود فایل صوتی'}
      </button>
      {error ? <span className="form-error rec-dl-err" role="alert">{error}</span> : null}
    </div>
  );
}
