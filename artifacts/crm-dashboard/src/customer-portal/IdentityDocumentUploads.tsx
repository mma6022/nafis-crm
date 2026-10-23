import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portalApi, type PortalDocument } from './api';
import { documentFileAccept } from '@/lib/document-upload-type';

const labels: Record<string, string> = {
  national_card_front: 'روی کارت ملی', national_card_back: 'پشت کارت ملی',
  birth_certificate_first_page: 'صفحه اول شناسنامه',
  birth_certificate_second_page: 'صفحه دوم شناسنامه',
  birth_certificate_last_page: 'صفحه آخر شناسنامه',
};
const previewUrl = (id: number) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/customer-portal/identity-documents/${id}/preview`;

function DocumentCard({ type, document, needed, busy, onUpload }: {
  type: string; document?: PortalDocument; needed: boolean; busy: string;
  onUpload: (type: string, file?: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [failedImage, setFailedImage] = useState(false);
  const label = labels[type];
  const image = document && ['image/jpeg', 'image/png'].includes(document.mimeType || '');
  return <section style={{ border: '1px solid #dbe5e2', borderRadius: 14, padding: 16, background: '#fff', minWidth: 0 }}
    data-testid={`card-identity-document-${type}`}>
    <strong style={{ display: 'block', marginBottom: 10 }}>{label}</strong>
    {document && <div style={{ marginBottom: 12 }}>
      {image && !failedImage
        ? <a href={previewUrl(document.id)} target="_blank" rel="noopener noreferrer" aria-label={`مشاهده ${label}`}>
          <img src={previewUrl(document.id)} alt={`تصویر بارگذاری‌شدهٔ ${label}`} onError={() => setFailedImage(true)}
            style={{ width: '100%', height: 150, objectFit: 'contain', borderRadius: 9, background: '#f4f7f6', border: '1px solid #e5ece9' }}
            data-testid={`preview-identity-document-${type}`} />
        </a>
        : <a className="cp-link" href={previewUrl(document.id)} target="_blank" rel="noopener noreferrer"
          data-testid={`link-identity-document-${type}`}>{document.mimeType === 'application/pdf' ? 'مشاهده فایل PDF بارگذاری‌شده' : 'مشاهده فایل بارگذاری‌شده'}</a>}
      <small style={{ display: 'block', color: document.status === 'rejected' ? '#b42318' : '#176d59', marginTop: 6, overflowWrap: 'anywhere' }}
        data-testid={`status-identity-document-${type}`}>
        {document.status === 'rejected' ? 'نیاز به اصلاح' : document.status === 'approved' ? 'تأیید شده' : 'با موفقیت بارگذاری شد؛ در انتظار بررسی کارشناس'}
      </small>
      {document.reviewReason && <small style={{ display: 'block' }}>{document.reviewReason}</small>}
    </div>}
    {needed && <>
      <input ref={input} type="file" accept={documentFileAccept} disabled={!!busy} style={{ display: 'none' }}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; onUpload(type, file); }}
        data-testid={`input-identity-document-${type}`} aria-label={`انتخاب فایل ${label}`} />
      <button type="button" className="cp-btn cp-btn-primary" disabled={!!busy} onClick={() => input.current?.click()}
        style={{ width: '100%', borderRadius: 10, gap: 8 }} data-testid={`button-upload-identity-${type}`}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
        </svg>
        {busy === type ? 'در حال بارگذاری…' : document ? 'انتخاب فایل اصلاح‌شده' : 'انتخاب تصویر یا فایل'}
      </button>
      <small style={{ display: 'block', color: '#66756e', marginTop: 8, lineHeight: 1.8 }}>تصویر JPG، PNG یا JFIF و فایل PDF · حداکثر ۱۰ مگابایت</small>
    </>}
  </section>;
}

export function IdentityDocumentUploads({ missing, onUploaded }: { missing: string[]; onUploaded?: () => void }) {
  const queryClient = useQueryClient();
  const docs = useQuery({ queryKey: ['customer', 'identity-docs'], queryFn: portalApi.identityDocuments });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const upload = async (type: string, file?: File) => {
    if (!file || busy) return;
    setError('');
    if (file.size > 10 * 1024 * 1024) { setError('حجم فایل بیشتر از ۱۰ مگابایت است. تصویر کم‌حجم‌تری انتخاب کنید.'); return; }
    setBusy(type);
    try {
      const saved = await portalApi.uploadIdentityDocument(type, file);
      queryClient.setQueryData<PortalDocument[]>(['customer', 'identity-docs'], current =>
        [...(current ?? []).filter(item => item.documentType !== saved.documentType), saved]);
      await queryClient.invalidateQueries({ queryKey: ['customer', 'identity-docs'] });
      onUploaded?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'مدرک ذخیره نشد. دوباره تلاش کنید.'); }
    finally { setBusy(''); }
  };
  return <div style={{ marginTop: 17 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,230px),1fr))', gap: 12 }}>
      {Object.keys(labels).filter(type => missing.includes(type) || docs.data?.some(item => item.documentType === type)).map(type => {
        const document = docs.data?.find(item => item.documentType === type);
        return <DocumentCard key={`${type}:${document?.id ?? 'new'}`} type={type} document={document}
          needed={missing.includes(type)} busy={busy} onUpload={(type, file) => { void upload(type, file); }} />;
      })}
    </div>
    {error && <div className="cp-alert" role="alert" style={{ marginTop: 12 }} data-testid="error-identity-upload">{error}</div>}
  </div>;
}
