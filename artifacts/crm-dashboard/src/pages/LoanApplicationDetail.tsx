import { useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useGetLoanApplication,
  useExpertApproveLoanApplication,
  useExpertRejectLoanApplication,
  useAdminRejectLoanApplication,
  useApproveLoanApplicationAsAdmin,
  useCompleteLoanApplication,
  useUploadLoanApplicationDocument,
  useAddLoanApplicationManualRequirement,
  useDeleteLoanApplicationManualRequirement,
  useReviewLoanApplicationDocument,
  useDeleteLoanApplicationDocument,
  useDeleteLoanApplicationGuarantorDocument,
  useRegisterLoanApplicationGuarantor,
  useUploadLoanApplicationGuarantorDocument,
  useReviewLoanApplicationGuarantorDocument,
  useSubmitLoanApplicationCollateral,
  useReviewLoanApplicationCollateral,
  useSubmitPrimaryContractLoanApplication,
  useLinkLoanApplicationGeneratedDocument,
  useVerifyLoanApplicationGeneratedDocumentSignature,
  useSubmitCustomerDocumentsLoanApplication,
  useReviewCustomerDocumentsLoanApplication,
  useStartGuarantorDocumentsLoanApplication,
  useSubmitGuarantorDocumentsLoanApplication,
  useReviewGuarantorDocumentsLoanApplication,
  useSubmitCollateralLoanApplication,
  useReviewCollateralLoanApplication as useReviewCollateralStage,
  getGetLoanApplicationQueryKey,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
} from '@workspace/api-client-react';
import { 
  CheckCircle2, XCircle, Clock, UploadCloud, ShieldCheck, 
  FileText, Landmark, UserPlus, CreditCard, Play, FileSignature, 
  Trash2, Search, Plus
} from 'lucide-react';
import { SkeletonPanel, ErrorState, formatDate } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';

const STAGE_LABELS: Record<string, string> = {
  draft: 'پیش‌نویس',
  primary_contract_pending_signature: 'امضای قرارداد اصلی',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  collateral_review: 'بررسی وثیقه',
  expert_approval: 'تأیید کارشناس',
  admin_approval: 'تأیید مدیریت',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل شده',
};

const STATUS_LABELS: Record<string, string> = {
  requested: 'درخواست شده',
  reviewing: 'در حال بررسی',
  approved: 'تأیید شده',
  rejected: 'رد شده',
};

export default function LoanApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const appId = Number(id);
  const queryClient = useQueryClient();

  const { data: session } = useGetAuthSession({
    query: { queryKey: getGetAuthSessionQueryKey(), retry: false },
  });
  const user = session?.user;
  const canUpdate = user?.role === 'admin' || user?.permissions?.includes('loan_applications.update');
  const canReview = user?.role === 'admin' || user?.permissions?.includes('loan_applications.review');
  const canApprove = user?.role === 'admin' || user?.permissions?.includes('loan_applications.approve');

  const { data: app, isLoading, isError, refetch } = useGetLoanApplication(appId, {
    query: { queryKey: getGetLoanApplicationQueryKey(appId), enabled: !isNaN(appId) }
  });

  const [reviewModal, setReviewModal] = useState<'expert_approve' | 'expert_reject' | 'admin_approve' | 'admin_reject' | 'complete' | 'review_cust_docs' | 'review_guar_docs' | 'review_collateral' | null>(null);
  const [reviewReason, setReviewReason] = useState('');

  const expertApprove = useExpertApproveLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const expertReject = useExpertRejectLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const adminApprove = useApproveLoanApplicationAsAdmin({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const adminReject = useAdminRejectLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const completeLoan = useCompleteLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });

  const submitCustDocs = useSubmitCustomerDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCustDocs = useReviewCustomerDocumentsLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const startGuarDocs = useStartGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const submitGuarDocs = useSubmitGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewGuarDocs = useReviewGuarantorDocumentsLoanApplication({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });
  const submitCollateral = useSubmitCollateralLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCollateral = useReviewCollateralStage({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewModal(null); } } });

  const handleReviewAction = () => {
    const data = { reason: reviewReason };
    switch (reviewModal) {
      case 'expert_approve': expertApprove.mutate({ id: appId, data }); break;
      case 'expert_reject': expertReject.mutate({ id: appId, data }); break;
      case 'admin_approve': adminApprove.mutate({ id: appId, data }); break;
      case 'admin_reject': adminReject.mutate({ id: appId, data }); break;
      case 'complete': completeLoan.mutate({ id: appId }); break;
      case 'review_cust_docs': reviewCustDocs.mutate({ id: appId, data }); break;
      case 'review_guar_docs': reviewGuarDocs.mutate({ id: appId, data }); break;
      case 'review_collateral': reviewCollateral.mutate({ id: appId, data }); break;
    }
  };

  if (isLoading) return <section className="data-page"><SkeletonPanel rows={8} /></section>;
  if (isError || !app) return <section className="data-page"><ErrorState onRetry={() => refetch()} /></section>;

  const customerDocs = app.documents || [];
  const guarantor = app.guarantor as any;
  const guarantorDocs = (guarantor?.documents || []) as any[];
  const collaterals = (app.collateral || []) as any[];
  const generatedDocs = (app.generatedDocuments || []) as any[];

  return (
    <section className="data-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">پرونده تسهیلات #{app.id}</div>
          <h2>{app.customerName || 'مشتری'}</h2>
          <p>ثبت شده در {formatDate(app.createdAt)} · طرح {app.planName || 'ناشناس'}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className={`status-pill ${app.status === 'approved' ? 'status-active' : app.status === 'rejected' ? 'status-failed' : 'status-new'}`} style={{ fontSize: 13, padding: '8px 14px' }}>
            {STATUS_LABELS[app.status] || app.status}
          </div>
          {app.stage && (
            <div className="status-pill status-muted" style={{ fontSize: 13, padding: '8px 14px' }}>
              مرحله: {STAGE_LABELS[app.stage] || app.stage}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>اطلاعات پایه</h3>
                <p>مبالغ و زمان‌بندی درخواست</p>
              </div>
              <Landmark size={20} color="#94a3b8" />
            </div>
            <div className="metric-grid">
              <div>
                <span className="metric-label">مبلغ درخواستی</span>
                <strong className="metric-value" style={{ fontSize: 20 }}>{Number(app.requestedAmount).toLocaleString('fa-IR')} <span style={{fontSize: 12, color: '#94a3b8'}}>ریال</span></strong>
              </div>
              <div>
                <span className="metric-label">مبلغ مصوب</span>
                <strong className="metric-value" style={{ fontSize: 20, color: app.approvedAmount ? '#0f766e' : '#94a3b8' }}>
                  {app.approvedAmount ? Number(app.approvedAmount).toLocaleString('fa-IR') : 'در انتظار تأیید'} <span style={{fontSize: 12, color: '#94a3b8'}}>{app.approvedAmount ? 'ریال' : ''}</span>
                </strong>
              </div>
              <div>
                <span className="metric-label">مدت اقساط</span>
                <strong className="metric-value" style={{ fontSize: 20 }}>{app.durationMonths || '—'} <span style={{fontSize: 12, color: '#94a3b8'}}>ماهه</span></strong>
              </div>
              <div>
                <span className="metric-label">مبلغ خالص (پس از کسورات)</span>
                <strong className="metric-value" style={{ fontSize: 20, color: app.netAmount ? '#0f766e' : '#94a3b8' }}>
                  {app.netAmount ? Number(app.netAmount).toLocaleString('fa-IR') : '—'} <span style={{fontSize: 12, color: '#94a3b8'}}>{app.netAmount ? 'ریال' : ''}</span>
                </strong>
              </div>
            </div>
            {app.notes && (
              <div style={{ marginTop: 20, padding: 14, background: '#f8fafc', borderRadius: 10, fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
                <strong>توضیحات:</strong> {app.notes}
              </div>
            )}
          </div>

          <DocumentSection 
            appId={appId} 
            docs={customerDocs} 
            title="مدارک مشتری" 
            type="customer" 
            canUpload={Boolean(canUpdate && app.stage === 'customer_documents_upload')} 
            canReview={Boolean(canReview && app.stage === 'customer_documents_review')} 
            canAddRequirement={Boolean(canReview && app.stage === 'customer_documents_review')}
          />
          
          <GuarantorSection 
            appId={appId} 
            docs={guarantorDocs} 
            guarantor={guarantor} 
            canRegister={Boolean(canUpdate && app.stage === 'guarantor_registration')} 
            canUpload={Boolean(canUpdate && app.stage === 'guarantor_documents_upload')} 
            canReview={Boolean(canReview && app.stage === 'guarantor_documents_review')} 
          />
          
          <CollateralSection 
            appId={appId} 
            collaterals={collaterals} 
            canUpload={Boolean(canUpdate && app.stage === 'collateral_upload')} 
            canReview={Boolean(canReview && app.stage === 'collateral_review')} 
          />

          <ContractSection 
            appId={appId} 
            docs={generatedDocs} 
            canSubmit={Boolean(canUpdate && app.stage === 'draft')} 
            canVerify={Boolean(canUpdate && ['primary_contract_pending_signature', 'final_invoice_pending_signature'].includes(app.stage || ''))} 
            canUpload={Boolean(canUpdate)} 
          />

        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>تصمیم‌گیری</h3>
                <p>تغییر وضعیت و ثبت نتیجه پرونده</p>
              </div>
              <ShieldCheck size={20} color="#94a3b8" />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {canUpdate && app.stage === 'customer_documents_upload' && (
                <button className="btn btn-primary" onClick={() => submitCustDocs.mutate({ id: appId })} disabled={submitCustDocs.isPending}>
                  ارسال مدارک مشتری جهت بررسی
                </button>
              )}
              {canReview && app.stage === 'customer_documents_review' && (
                <button className="btn btn-primary" onClick={() => setReviewModal('review_cust_docs')}>
                  ثبت نتیجه بررسی مدارک مشتری
                </button>
              )}
              
              {canUpdate && app.stage === 'guarantor_registration' && (
                <button className="btn btn-primary" onClick={() => startGuarDocs.mutate({ id: appId })} disabled={startGuarDocs.isPending}>
                  شروع بارگذاری مدارک ضامن
                </button>
              )}
              {canUpdate && app.stage === 'guarantor_documents_upload' && (
                <button className="btn btn-primary" onClick={() => submitGuarDocs.mutate({ id: appId })} disabled={submitGuarDocs.isPending}>
                  ارسال مدارک ضامن جهت بررسی
                </button>
              )}
              {canReview && app.stage === 'guarantor_documents_review' && (
                <button className="btn btn-primary" onClick={() => setReviewModal('review_guar_docs')}>
                  ثبت نتیجه بررسی مدارک ضامن
                </button>
              )}

              {canUpdate && app.stage === 'collateral_upload' && (
                <button className="btn btn-primary" onClick={() => submitCollateral.mutate({ id: appId })} disabled={submitCollateral.isPending}>
                  ارسال وثایق جهت بررسی
                </button>
              )}
              {canReview && app.stage === 'collateral_review' && (
                <button className="btn btn-primary" onClick={() => setReviewModal('review_collateral')}>
                  ثبت نتیجه بررسی وثایق
                </button>
              )}

              {canReview && app.stage === 'expert_approval' && (
                <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 4 }}>
                  <strong style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 8 }}>تأیید کارشناس</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button className="btn" style={{ background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0' }} onClick={() => setReviewModal('expert_approve')}>
                      <CheckCircle2 size={16} /> تأیید
                    </button>
                    <button className="btn" style={{ background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} onClick={() => setReviewModal('expert_reject')}>
                      <XCircle size={16} /> رد پرونده
                    </button>
                  </div>
                </div>
              )}

              {canApprove && app.stage === 'admin_approval' && (
                <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 4 }}>
                  <strong style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 8 }}>تأیید مدیریت</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button className="btn" style={{ background: '#f0f9ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }} onClick={() => setReviewModal('admin_approve')}>
                      <CheckCircle2 size={16} /> تأیید نهایی
                    </button>
                    <button className="btn" style={{ background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3' }} onClick={() => setReviewModal('admin_reject')}>
                      <XCircle size={16} /> رد پرونده
                    </button>
                  </div>
                </div>
              )}

              {canUpdate && app.stage === 'final_invoice_pending_signature' && generatedDocs.some(d => d.kind === 'invoice') && generatedDocs.some(d => d.kind === 'acknowledgement') && (
                 <button className="btn btn-primary" onClick={() => setReviewModal('complete')} style={{ width: '100%' }}>
                  <Play size={16} /> خاتمه و پرداخت
                </button>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h3>تاریخچه</h3>
                <p>گردش کار پرونده</p>
              </div>
              <Clock size={20} color="#94a3b8" />
            </div>
            <div className="timeline">
              {(app.history || []).map((h: any, i) => (
                <div className="timeline-item" key={i}>
                  <h4>{h.action || h.status}</h4>
                  <p>{h.reason || h.note || h.description}</p>
                  <time>{formatDate(h.createdAt || h.date)}</time>
                </div>
              ))}
              {(!app.history || app.history.length === 0) && (
                <div className="empty-state compact-empty">
                  <p>هیچ سابقه عملیاتی ثبت نشده است.</p>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {reviewModal && (
        <Modal 
          title={
            reviewModal === 'expert_approve' ? 'تأیید کارشناسی' :
            reviewModal === 'expert_reject' ? 'رد توسط کارشناس' :
            reviewModal === 'admin_approve' ? 'تأیید نهایی مدیر' :
            reviewModal === 'admin_reject' ? 'رد توسط مدیر' :
            reviewModal === 'review_cust_docs' ? 'تأیید/رد/نقص مدارک مشتری' :
            reviewModal === 'review_guar_docs' ? 'تأیید/رد/نقص مدارک ضامن' :
            reviewModal === 'review_collateral' ? 'تأیید/رد/نقص وثایق' :
            'خاتمه پرونده و پرداخت'
          } 
          onClose={() => setReviewModal(null)}
          testId="review-modal"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>توضیحات / دلایل (اختیاری)</label>
              <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} placeholder="دلیل این تصمیم..." rows={4} />
            </div>
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setReviewModal(null)}>انصراف</button>
              <button className="btn btn-primary" onClick={handleReviewAction} disabled={expertApprove.isPending || expertReject.isPending || adminApprove.isPending || adminReject.isPending || completeLoan.isPending}>
                ثبت تصمیم
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function DocumentSection({ appId, docs, title, type, canUpload, canReview, canAddRequirement }: { appId: number, docs: any[], title: string, type: 'customer' | 'guarantor', canUpload: boolean, canReview: boolean, canAddRequirement?: boolean }) {
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState<{ id: number, decision: 'incomplete' | 'rejected' } | null>(null);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reqLabel, setReqLabel] = useState('');

  const uploadCustomer = useUploadLoanApplicationDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setUploadOpen(false); setLabel(''); setFile(null); } } });
  const uploadGuarantor = useUploadLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setUploadOpen(false); setLabel(''); setFile(null); } } });
  const delCustomer = useDeleteLoanApplicationDocument({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const delGuarantor = useDeleteLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const reviewCustomer = useReviewLoanApplicationDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  const reviewGuarantor = useReviewLoanApplicationGuarantorDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  
  const addReq = useAddLoanApplicationManualRequirement({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReqOpen(false); setReqLabel(''); } } });
  const delReq = useDeleteLoanApplicationManualRequirement({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });

  const isPending = uploadCustomer.isPending || uploadGuarantor.isPending;

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const req = { id: appId, data: { file, label: label || undefined } };
    if (type === 'customer') uploadCustomer.mutate(req);
    else uploadGuarantor.mutate(req);
  };

  const handleAddReq = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqLabel.trim()) return;
    addReq.mutate({ id: appId, data: { label: reqLabel.trim() } });
  };

  const handleDel = (doc: any) => {
    // Determine if it's a requirement placeholder without file or normal doc
    if (type === 'customer' && !doc.filename && doc.requirementKey?.startsWith('manual_')) {
      delReq.mutate({ id: appId, documentId: doc.id });
    } else {
      if (type === 'customer') delCustomer.mutate({ id: appId, documentId: doc.id });
      else delGuarantor.mutate({ id: appId, documentId: doc.id });
    }
  };

  const handleReview = (docId: number, decision: 'approved' | 'incomplete' | 'rejected', reason?: string) => {
    if (decision !== 'approved' && !reason) {
      setReviewOpen({ id: docId, decision });
      return;
    }
    if (type === 'customer') reviewCustomer.mutate({ id: appId, documentId: docId, data: { decision, reason } });
    else reviewGuarantor.mutate({ id: appId, documentId: docId, data: { decision, reason } });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          <p>بارگذاری و بررسی مدارک</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {canAddRequirement && (
            <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setReqOpen(true)}>
              <Plus size={14} /> درخواست مدرک جدید
            </button>
          )}
          {canUpload && (
            <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setUploadOpen(true)}>
              <UploadCloud size={14} /> بارگذاری
            </button>
          )}
        </div>
      </div>
      
      <div className="docs-list" style={{ display: 'grid', gap: 10 }}>
        {docs.length > 0 ? docs.map(doc => (
          <div key={doc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f1f5f9', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <FileText size={18} />
              </div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>{doc.label || doc.filename || 'سند بدون نام'}</strong>
                <span style={{ fontSize: 11, color: doc.status === 'approved' ? '#0f766e' : (doc.status === 'rejected' || doc.status === 'incomplete') ? '#be123c' : '#94a3b8' }}>
                  {doc.status === 'approved' ? 'تأیید شده' : doc.status === 'incomplete' ? 'نقص مدرک' : doc.status === 'rejected' ? 'رد شده' : 'در انتظار بررسی'}
                </span>
                {doc.reviewReason && <div style={{ fontSize: 10, color: '#be123c', marginTop: 2 }}>{doc.reviewReason}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {canReview && doc.status !== 'approved' && <button className="icon-button" style={{ width: 32, height: 32, color: '#047857', borderColor: '#a7f3d0', background: '#ecfdf5' }} onClick={() => handleReview(doc.id, 'approved')} title="تأیید"><CheckCircle2 size={14} /></button>}
              {canReview && doc.status !== 'incomplete' && <button className="icon-button" style={{ width: 32, height: 32, color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }} onClick={() => handleReview(doc.id, 'incomplete')} title="نقص مدرک"><XCircle size={14} /></button>}
              {canReview && doc.status !== 'rejected' && <button className="icon-button" style={{ width: 32, height: 32, color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }} onClick={() => handleReview(doc.id, 'rejected')} title="رد"><XCircle size={14} /></button>}
              {canUpload && <button className="icon-button" style={{ width: 32, height: 32 }} onClick={() => handleDel(doc)} title="حذف"><Trash2 size={14} /></button>}
            </div>
          </div>
        )) : (
          <div className="empty-state compact-empty"><p>مدرکی بارگذاری نشده است.</p></div>
        )}
      </div>

      {reqOpen && (
        <Modal title="درخواست مدرک جدید" onClose={() => setReqOpen(false)} testId="add-requirement-modal">
          <form onSubmit={handleAddReq} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>عنوان مدرک مورد نیاز</label>
              <input type="text" value={reqLabel} onChange={e => setReqLabel(e.target.value)} placeholder="مثال: گواهی کسر از حقوق" required />
            </div>
            {addReq.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت درخواست مدرک. دوباره تلاش کنید.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReqOpen(false)} disabled={addReq.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={addReq.isPending || !reqLabel.trim()}>
                {addReq.isPending ? 'در حال ثبت...' : 'ثبت درخواست مدرک'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {uploadOpen && (
        <Modal title="بارگذاری مدرک" onClose={() => setUploadOpen(false)} testId="upload-document-modal">
          <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>عنوان مدرک (اختیاری)</label>
              <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="مثال: تصویر کارت ملی" />
            </div>
            <div className="field">
              <label>انتخاب فایل</label>
              <input type="file" onChange={e => setFile(e.target.files?.[0] || null)} required style={{ padding: '8px 10px', background: '#fff' }} />
            </div>
            {uploadCustomer.isError || uploadGuarantor.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در بارگذاری مدرک. دوباره تلاش کنید.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setUploadOpen(false)} disabled={isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={isPending || !file}>
                {isPending ? 'در حال بارگذاری...' : 'بارگذاری'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {reviewOpen && (
        <Modal title={reviewOpen.decision === 'incomplete' ? 'ثبت نقص مدرک' : 'رد مدرک'} onClose={() => setReviewOpen(null)} testId="review-document-modal">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>دلیل</label>
              <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} required rows={3} placeholder="علت نقص یا رد مدرک را بنویسید..." />
            </div>
            {reviewCustomer.isError || reviewGuarantor.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت نتیجه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReviewOpen(null)}>انصراف</button>
              <button type="button" className="btn btn-primary" disabled={!reviewReason.trim()} onClick={() => handleReview(reviewOpen.id, reviewOpen.decision, reviewReason)}>
                ثبت نتیجه
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GuarantorSection({ appId, docs, guarantor, canRegister, canUpload, canReview }: { appId: number, docs: any[], guarantor: any, canRegister: boolean, canUpload: boolean, canReview: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', nationalCode: '', mobile: '' });
  
  const reg = useRegisterLoanApplicationGuarantor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setOpen(false);
      }
    }
  });

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>ضامن‌ها</h3>
          <p>ثبت ضامن و مدارک مرتبط</p>
        </div>
        {canRegister && (
          <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setOpen(true)}>
            <UserPlus size={14} /> ثبت ضامن
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: 10, marginBottom: docs.length ? 20 : 0 }}>
        {guarantor && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--nafiss-light)', color: 'var(--nafiss-blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <UserPlus size={18} />
            </div>
            <div>
              <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>{guarantor.fullName || 'ضامن'}</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>کدملی: {guarantor.nationalCode || '—'} · موبایل: <span dir="ltr">{guarantor.mobile || '—'}</span></span>
            </div>
          </div>
        )}
      </div>

      {docs.length > 0 || guarantor ? (
        <DocumentSection appId={appId} docs={docs} title="مدارک ضامن" type="guarantor" canUpload={canUpload} canReview={canReview} />
      ) : (
        <div className="empty-state compact-empty"><p>ضامنی ثبت نشده است.</p></div>
      )}

      {open && (
        <Modal title="ثبت ضامن جدید" onClose={() => setOpen(false)} testId="register-guarantor-modal">
          <form onSubmit={e => { e.preventDefault(); reg.mutate({ id: appId, data: form }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>نام و نام خانوادگی ضامن</label>
              <input type="text" value={form.fullName} onChange={e => setForm({...form, fullName: e.target.value})} required />
            </div>
            <div className="field">
              <label>کد ملی</label>
              <input type="text" value={form.nationalCode} onChange={e => setForm({...form, nationalCode: e.target.value})} dir="ltr" />
            </div>
            <div className="field">
              <label>شماره موبایل</label>
              <input type="text" value={form.mobile} onChange={e => setForm({...form, mobile: e.target.value})} dir="ltr" />
            </div>
            {reg.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت ضامن.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={reg.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={reg.isPending}>
                {reg.isPending ? 'در حال ثبت...' : 'ثبت ضامن'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function CollateralSection({ appId, collaterals, canUpload, canReview }: { appId: number, collaterals: any[], canUpload: boolean, canReview: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ type: 'promissory', file: null as File | null });
  const [reviewOpen, setReviewOpen] = useState<{ id: number, decision: 'incomplete' | 'rejected' } | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  
  const submitMut = useSubmitLoanApplicationCollateral({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setOpen(false); } } });
  const reviewMut = useReviewLoanApplicationCollateral({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setReviewOpen(null); setReviewReason(''); } } });
  
  const handleReview = (id: number, decision: 'approved' | 'incomplete' | 'rejected', reason?: string) => {
    if (decision !== 'approved' && !reason) {
      setReviewOpen({ id, decision });
      return;
    }
    reviewMut.mutate({ id: appId, collateralId: id, data: { decision, reason } });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>وثایق و تضامین</h3>
          <p>سفته، چک و گواهی کسر از حقوق</p>
        </div>
        {canUpload && (
          <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => setOpen(true)}>
            <CreditCard size={14} /> بارگذاری وثیقه
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {collaterals.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CreditCard size={18} />
              </div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>نوع: {c.collateralType || 'نامشخص'}</strong>
                <span style={{ fontSize: 11, color: c.status === 'approved' ? '#0f766e' : (c.status === 'rejected' || c.status === 'incomplete') ? '#be123c' : '#94a3b8' }}>
                  {c.status === 'approved' ? 'تأیید شده' : c.status === 'incomplete' ? 'نقص مدرک' : c.status === 'rejected' ? 'رد شده' : 'در انتظار بررسی'}
                </span>
                {c.reviewReason && <div style={{ fontSize: 10, color: '#be123c', marginTop: 2 }}>{c.reviewReason}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {canReview && c.status !== 'approved' && <button className="icon-button" style={{ width: 32, height: 32, color: '#047857', borderColor: '#a7f3d0', background: '#ecfdf5' }} onClick={() => handleReview(c.id, 'approved')}><CheckCircle2 size={14} /></button>}
              {canReview && c.status !== 'incomplete' && <button className="icon-button" style={{ width: 32, height: 32, color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }} onClick={() => handleReview(c.id, 'incomplete')}><XCircle size={14} /></button>}
              {canReview && c.status !== 'rejected' && <button className="icon-button" style={{ width: 32, height: 32, color: '#be123c', borderColor: '#fecdd3', background: '#fff1f2' }} onClick={() => handleReview(c.id, 'rejected')}><XCircle size={14} /></button>}
            </div>
          </div>
        ))}
        {collaterals.length === 0 && <div className="empty-state compact-empty"><p>وثیقه‌ای ثبت نشده است.</p></div>}
      </div>

      {open && (
        <Modal title="بارگذاری وثیقه" onClose={() => setOpen(false)} testId="upload-collateral-modal">
          <form onSubmit={e => { e.preventDefault(); if (form.file) submitMut.mutate({ id: appId, data: { collateralType: form.type, file: form.file } }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>نوع وثیقه</label>
              <select value={form.type} onChange={e => setForm({...form, type: e.target.value})}>
                <option value="promissory">سفته</option>
                <option value="digital_check">چک دیجیتال</option>
                <option value="physical_check">چک فیزیکی</option>
                <option value="salary_deduction">کسر از حقوق</option>
              </select>
            </div>
            <div className="field">
              <label>فایل وثیقه</label>
              <input type="file" required onChange={e => setForm({...form, file: e.target.files?.[0] || null})} style={{ padding: '8px 10px', background: '#fff' }} />
            </div>
            {submitMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت وثیقه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={submitMut.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={submitMut.isPending || !form.file}>
                {submitMut.isPending ? 'در حال بارگذاری...' : 'ثبت وثیقه'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {reviewOpen && (
        <Modal title={reviewOpen.decision === 'incomplete' ? 'ثبت نقص وثیقه' : 'رد وثیقه'} onClose={() => setReviewOpen(null)} testId="review-collateral-modal">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>دلیل</label>
              <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} required rows={3} placeholder="علت نقص یا رد را بنویسید..." />
            </div>
            {reviewMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در ثبت نتیجه.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setReviewOpen(null)}>انصراف</button>
              <button type="button" className="btn btn-primary" disabled={!reviewReason.trim()} onClick={() => handleReview(reviewOpen.id, reviewOpen.decision, reviewReason)}>
                ثبت نتیجه
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ContractSection({ appId, docs = [], canSubmit, canVerify, canUpload }: { appId: number, docs: any[], canSubmit: boolean, canVerify: boolean, canUpload: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: 'primary', contractGenerationId: '' });
  
  const submitMut = useSubmitPrimaryContractLoanApplication({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });
  const linkMut = useLinkLoanApplicationGeneratedDocument({ mutation: { onSuccess: () => { queryClient.invalidateQueries(); setOpen(false); } } });
  const verifyMut = useVerifyLoanApplicationGeneratedDocumentSignature({ mutation: { onSuccess: () => queryClient.invalidateQueries() } });

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>قراردادها</h3>
          <p>امضای دیجیتال و صدور قرارداد</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {canSubmit && (
            <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => submitMut.mutate({ id: appId })}>
              <Play size={14} /> شروع فرآیند قرارداد
            </button>
          )}
          {canUpload && (
            <button className="btn btn-primary" style={{ padding: '0 10px', height: 32 }} onClick={() => setOpen(true)}>
              <FileSignature size={14} /> پیوست قرارداد صادرشده
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {docs.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, border: '1px solid #e2e8f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <FileSignature size={18} />
              </div>
              <div>
                <strong style={{ display: 'block', fontSize: 13, color: '#334155' }}>نوع: {c.kind === 'primary' ? 'قرارداد اصلی' : c.kind === 'invoice' ? 'صورت‌حساب' : 'رسید'}</strong>
                <span style={{ fontSize: 11, color: c.signed ? '#0f766e' : '#94a3b8' }}>
                  {c.signed ? 'امضا شده' : 'در انتظار امضا'} (شناسه صدور: {c.contractGenerationId})
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {!c.signed && canVerify && (
                <button className="btn btn-ghost" style={{ padding: '0 10px', height: 32 }} onClick={() => verifyMut.mutate({ id: appId, documentId: c.id })}>
                  بررسی امضا
                </button>
              )}
            </div>
          </div>
        ))}
        {docs.length === 0 && <div className="empty-state compact-empty"><p>قراردادی پیوست نشده است.</p></div>}
      </div>

      {open && (
        <Modal title="پیوست قرارداد صادرشده" onClose={() => setOpen(false)} testId="link-contract-modal">
          <form onSubmit={e => { e.preventDefault(); if (form.contractGenerationId) linkMut.mutate({ id: appId, data: { kind: form.kind as 'primary' | 'invoice' | 'acknowledgement', contractGenerationId: Number(form.contractGenerationId) } }); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field">
              <label>نوع سند</label>
              <select value={form.kind} onChange={e => setForm({...form, kind: e.target.value})}>
                <option value="primary">قرارداد اصلی</option>
                <option value="invoice">صورت‌حساب (Invoice)</option>
                <option value="acknowledgement">رسید تسویه</option>
              </select>
            </div>
            <div className="field">
              <label>شناسه صدور قرارداد (از بخش مدیریت قراردادها)</label>
              <input type="number" required value={form.contractGenerationId} onChange={e => setForm({...form, contractGenerationId: e.target.value})} dir="ltr" min="1" />
            </div>
            {linkMut.isError ? <div style={{color: '#be123c', fontSize: 12}}>خطا در پیوست قرارداد.</div> : null}
            <div className="form-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={linkMut.isPending}>انصراف</button>
              <button type="submit" className="btn btn-primary" disabled={linkMut.isPending || !form.contractGenerationId}>
                {linkMut.isPending ? 'در حال پیوست...' : 'پیوست قرارداد'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
