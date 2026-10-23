import { useRef, useState, useSyncExternalStore } from 'react';
import { Camera, Trash2 } from 'lucide-react';

const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
let versions: Record<string, number> = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function refreshAvatars(): Promise<void> {
  loading = fetch(`${base}api/avatars`, { credentials: 'include', cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { versions?: Record<string, number> } | null) => {
      if (body?.versions) { versions = body.versions; emit(); }
    })
    .catch(() => undefined)
    .finally(() => { loaded = true; loading = null; });
  return loading;
}

function useVersions(): Record<string, number> {
  if (!loaded && !loading) void refreshAvatars();
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => versions,
  );
}

const letters = (name?: string | null) => (name || '؟').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');

export function UserAvatar({ userId, name, size = 30, className = '' }: { userId?: number | null; name?: string | null; size?: number; className?: string }) {
  const all = useVersions();
  const version = userId != null ? all[String(userId)] : undefined;
  const [failed, setFailed] = useState<number | null>(null);
  const showImage = version != null && failed !== version;
  return (
    <span className={`avatar user-avatar ${className}`} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size / 3)), flex: '0 0 auto', overflow: 'hidden' }} aria-hidden="true">
      {showImage
        ? <img src={`${base}api/avatars/${userId}?v=${version}`} alt="" onError={() => setFailed(version)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : letters(name)}
    </span>
  );
}

async function resizeToDataUrl(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('فقط تصویر JPG، PNG یا WebP انتخاب کنید.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('پردازش تصویر ممکن نیست.');
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if ((url.length - url.indexOf(',') - 1) * 0.75 <= 60 * 1024) return url;
  }
  throw new Error('حجم تصویر پس از کوچک‌سازی زیاد است؛ تصویر دیگری انتخاب کنید.');
}

export function AvatarPicker({ userId, name, endpoint, testId = 'avatar-picker' }: { userId: number; name?: string | null; endpoint: string; testId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const has = useVersions()[String(userId)] != null;
  const call = async (init: RequestInit) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${base}api/${endpoint}`, { credentials: 'include', ...init });
      if (!response.ok) throw new Error('ذخیره عکس انجام نشد؛ دوباره تلاش کنید.');
      await refreshAvatars();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ذخیره عکس انجام نشد.'); }
    finally { setBusy(false); }
  };
  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const image = await resizeToDataUrl(file);
      await call({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تصویر نامعتبر است.'); }
    if (input.current) input.current.value = '';
  };
  return (
    <div className="field full" data-testid={testId} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <UserAvatar userId={userId} name={name} size={56} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>عکس پروفایل</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => input.current?.click()} data-testid={`${testId}-choose`}><Camera size={14} />{has ? 'تغییر عکس' : 'انتخاب عکس'}</button>
          {has && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void call({ method: 'DELETE' })} data-testid={`${testId}-remove`}><Trash2 size={14} />حذف عکس</button>}
        </div>
        {error && <span role="alert" style={{ color: '#b91c1c', fontSize: 11 }}>{error}</span>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => void onFile(event.target.files?.[0])} />
    </div>
  );
}
