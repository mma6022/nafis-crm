import { useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import { documentFileAccept, supportedDocumentFile } from '@/lib/document-upload-type';
import { useQueryClient } from '@tanstack/react-query';
import {
  useUploadPhysicalLoanDocument,
  useDeletePhysicalLoanDocument,
  useSubmitPhysicalLoanDocuments,
  getGetLoanApplicationQueryKey,
  getListLoanApplicationsQueryKey,
  type PhysicalLoanDocument,
} from '@workspace/api-client-react';

export function PhysicalSubmission({ appId, documents, canSubmit, previouslySubmitted = false, returnReason }: {
  appId: number;
  documents: PhysicalLoanDocument[];
  canSubmit: boolean;
  previouslySubmitted?: boolean;
  returnReason?: string;
}) {
  const queryClient = useQueryClient();
  const [noDocuments, setNoDocuments] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useUploadPhysicalLoanDocument();
  const remove = useDeletePhysicalLoanDocument();
  const submit = useSubmitPhysicalLoanDocuments({
    mutation: {
      onSuccess: () => {
        setError('');
        void queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
        void queryClient.invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() });
      },
      onError: () => setError('ثبت مرحله انجام نشد. فایل‌ها و وضعیت پرونده را بررسی کنید و دوباره تلاش کنید.'),
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) });
  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    setNoDocuments(false);
    setError('');
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024 || !/\.(pdf|jpe?g|jfif|png)$/i.test(file.name) ||
          !supportedDocumentFile(file)) {
          throw new Error('فقط PDF، JPG، JFIF یا PNG تا ۱۰ مگابایت برای هر فایل مجاز است.');
        }
        await upload.mutateAsync({ id: appId, data: { file } });
      }
    } catch (failure) {
      setError(failure instanceof Error && /فقط PDF/.test(failure.message)
        ? failure.message
        : 'بارگذاری یکی از فایل‌ها انجام نشد. فایل‌های ثبت‌شده را بررسی کنید و دوباره تلاش کنید.');
    } finally {
      await refresh();
      setUploading(false);
    }
  };
  const busy = uploading || remove.isPending || submit.isPending;
  return <div className="panel" data-testid="physical-submission">
    <div className="panel-head"><div><h3>ارسال مدارک فیزیکی</h3><p>کارشناس ثبت می‌تواند هر تعداد تصویر یا PDF از مدارک ارسالی را بارگذاری کند.</p></div></div>
    {returnReason && <p className="form-error" role="status">علت بازگشت برای اصلاح مدارک: {returnReason}</p>}
    {canSubmit && <div className="field">
      <label htmlFor="physical-document-files">بارگذاری مدارک فیزیکی</label>
      <input ref={fileInput} id="physical-document-files" type="file" accept={documentFileAccept} multiple
        className="sr-only" tabIndex={-1}
        disabled={busy} onChange={(event) => void onFiles(event)} data-testid="input-physical-documents" />
      <button type="button" className="btn btn-primary" disabled={busy}
        onClick={() => fileInput.current?.click()} data-testid="upload-physical-documents">
        <Upload size={16} aria-hidden="true" />
        {uploading ? 'در حال بارگذاری…' : 'آپلود مدارک فیزیکی'}
      </button>
      <small>امکان انتخاب چند فایل PDF، JPG، JFIF یا PNG؛ حداکثر ۱۰ مگابایت برای هر فایل.</small>
      {uploading && <small role="status">در حال بارگذاری فایل‌ها…</small>}
    </div>}
    {documents.length > 0 && <ul style={{ display: 'grid', gap: 8, paddingInlineStart: 20 }}>
      {documents.map((document) => <li key={document.id}>
        <a href={`/api/loan-applications/${appId}/physical-documents/${document.id}/download`}
          style={{ marginLeft: 12 }}>{document.originalName}</a>
        {!document.fileAvailable && <span role="alert">فایل در دسترس نیست</span>}
        {canSubmit && <button type="button" className="btn btn-ghost" disabled={busy}
          onClick={() => { setError(''); remove.mutate({ id: appId, documentId: document.id }, {
            onSuccess: () => void refresh(),
            onError: () => setError('حذف فایل انجام نشد. دوباره تلاش کنید.'),
          }); }} data-testid={`delete-physical-document-${document.id}`}>حذف</button>}
      </li>)}
    </ul>}
    {canSubmit && <>
      {!documents.length && !previouslySubmitted && <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={noDocuments} disabled={busy}
          onChange={(event) => setNoDocuments(event.target.checked)} data-testid="checkbox-no-physical-documents" />
        مدرک فیزیکی ندارد
      </label>}
      <p className="funding-guidance">{noDocuments
        ? 'با تأیید این گزینه، مرحلهٔ بررسی مدارک فیزیکی به‌صورت خودکار تأیید و رد می‌شود.'
        : 'پس از بارگذاری همه مدارک، پرونده برای بررسی مدارک فیزیکی ارسال می‌شود.'}</p>
      <button type="button" className="btn btn-primary" data-testid="submit-physical-documents"
        disabled={busy || (!noDocuments && (!documents.length || documents.some((document) => !document.fileAvailable)))}
        onClick={() => submit.mutate({ id: appId, data: { noPhysicalDocuments: noDocuments } })}>
        {submit.isPending ? 'در حال ثبت…' : 'تأیید و مرحله بعدی'}
      </button>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}