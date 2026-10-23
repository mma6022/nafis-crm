import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyProviderStatus, classifySignatureVerificationError, providerReportsSigned } from "../src/lib/loan-signature-verification-errors.mjs";

const source = await readFile(new URL("../src/pages/LoanApplicationDetail.tsx", import.meta.url), "utf8");
const contractsSource = await readFile(new URL("../src/pages/Contracts.tsx", import.meta.url), "utf8");
assert.equal(classifySignatureVerificationError({
  status: 500, data: { error: "signature_processing_failed" },
}).kind, "processing_error", "CRM processing errors are not reported as provider failures");
const customerSectionStart = source.indexOf("{activeStepId === 'customer'");
const guarantorSectionStart = source.indexOf("{['guarantor', 'guarantor_registration', 'guarantor_docs'].includes(activeStepId)", customerSectionStart);
assert.ok(customerSectionStart >= 0 && guarantorSectionStart > customerSectionStart, "customer document section is present");
const customerSection = source.slice(customerSectionStart, guarantorSectionStart);

assert.ok(customerSection.includes("<ContractSection"), "customer document section renders the linked primary contract");
assert.ok(customerSection.includes("docs={generatedDocs.filter((doc: any) => doc.kind === 'primary')}"),
  "customer document section limits contract review to primary contracts");
assert.ok(customerSection.includes("canReview={Boolean(canReview && canRegistrarAct && app.stage === 'customer_documents_review')}"),
  "contract review remains limited to authorized registrar/admin reviewers at the review stage");
assert.ok(customerSection.includes("canUpload={Boolean(canUpdate && canSalespersonAct && app.stage === 'customer_documents_upload')}"),
  "contract upload/replacement remains limited to salesperson/admin during customer document upload");

assert.ok(source.includes("const hasFile = (doc: any) => doc.fileAvailable === true;"),
  "uploaded-document actions use server-confirmed file availability");
assert.ok(source.includes("c.fileAvailable && c.downloadUrl"),
  "generated contract download requires an actual generated PDF");
assert.ok(source.includes("hasFile(c) && <a data-testid={`link-download-collateral-"),
  "collateral download requires an actual uploaded file");
assert.ok(source.includes("{hasFile(doc) ? 'جایگزینی' : 'آپلود'}"),
  "placeholder and uploaded rows use upload/replacement labels");
assert.ok(source.includes("{c.fileAvailable ? 'جایگزینی' : 'آپلود'}"),
  "generated contract rows use upload/replacement labels for authorized uploaders");
assert.ok(source.includes("disabled={!c.signed || !c.fileAvailable || reviewMut.isPending}"),
  "registrar cannot approve an inaccessible or unsigned contract");

const verifyMutationStart = source.indexOf("const verifyMut =");
const reviewMutationStart = source.indexOf("const reviewMut =", verifyMutationStart);
assert.ok(verifyMutationStart >= 0 && reviewMutationStart > verifyMutationStart, "signature verification mutation is present");
const verifyMutation = source.slice(verifyMutationStart, reviewMutationStart);
assert.ok(verifyMutation.includes("setSignatureResult(null);") && verifyMutation.includes("setSignatureError('');"),
  "each fresh inquiry clears the previous result and error");
assert.ok(source.includes("mayConfirmSignedPrimary && primaryDoc?.signed")
  && source.includes("const mayConfirmSignedPrimary = canConfirmSigned && !authorizedLegacySourcePending;"),
  "confirming the workflow signature requires a signed primary and cannot reuse the authorized legacy source");
assert.ok(source.includes("disabled={!c.signed || !c.fileAvailable || reviewMut.isPending}")
  && source.includes("disabled={!c.signed || !c.fileAvailable}"),
  "approve and reject workflow actions still require c.signed and an available file");
assert.equal((source.match(/canVerify=\{true\}/g) ?? []).length, 3,
  "all three view-authorized contract sections permit status inquiry regardless of stage");
const statusButtonStart = source.indexOf("{canVerify && (", verifyMutationStart);
const statusButtonEnd = source.indexOf("</button>", statusButtonStart);
assert.ok(statusButtonStart > verifyMutationStart && statusButtonEnd > statusButtonStart,
  "status inquiry action is rendered");
const statusButton = source.slice(statusButtonStart, statusButtonEnd);
assert.ok(!statusButton.includes("historicalPrimary") && !statusButton.includes("!c.signed"),
  "status inquiry remains available for signed and historical documents");
assert.ok(statusButton.includes("بررسی وضعیت امضا"),
  "the action is labeled as a status inquiry");

for (const [input, expectedKind] of [
  [{ data: { error: "provider_status_failed" } }, "provider_error"],
  [{ response: { status: 403, data: { error: "action_forbidden" } } }, "access_error"],
  [{ response: { status: 404, data: { error: "generated_document_not_found" } } }, "missing_document"],
  [{ message: "Network Error" }, "network_error"],
  [{ response: { status: 500, data: { error: "unexpected" } } }, "unexpected_error"],
]) {
  const result = classifySignatureVerificationError(input);
  assert.equal(result.kind, expectedKind, `signature verification error classifies as ${expectedKind}`);
  assert.match(result.message, /امضامی|امضا|سند|مجوز|ارتباط/, `${expectedKind} has localized, meaningful help`);
}
assert.ok(providerReportsSigned("accept"), "the provider's accepted observation can be displayed separately");
assert.ok(providerReportsSigned("SIGNED"), "provider status matching is case-insensitive");
for (const status of ["unaccepted", "not_signed", "declined", "cancelled"]) {
  assert.equal(classifyProviderStatus(status), "negative", `${status} is classified negative before signed-state matching`);
  assert.equal(providerReportsSigned(status), false, `${status} is not treated as a provider signature`);
}
assert.equal(classifyProviderStatus("pending"), "pending", "pending is kept distinct from signed and negative states");
for (const status of ["accept", "signed"]) {
  assert.equal(classifyProviderStatus(status), "signed", `${status} is a signed provider state`);
  assert.equal(providerReportsSigned(status), true, `${status} reports a signed provider state`);
}
assert.ok(source.includes("status-emzame-${c.id}") && source.includes("<bdi dir=\"auto\">{c.provider_status}</bdi>"),
  "the persistent status row displays the raw provider_status field directly");
const providerRowStart = source.indexOf("data-testid={`status-emzame-");
const providerRowEnd = source.indexOf("</div>}", providerRowStart);
assert.ok(providerRowStart >= 0 && providerRowEnd > providerRowStart
  && !source.slice(providerRowStart, providerRowEnd).includes("c.signed"),
  "provider status row is independent of locally linked workflow signing");
assert.ok(source.includes("title=\"وضعیت امضا در امضامی\"")
  && source.includes("signatureResult.providerStatus ?? 'در پاسخ گزارش نشده'"),
  "the inquiry result always displays raw providerStatus or explicitly states it was omitted");
const inquiryModalStart = source.indexOf('<Modal title="وضعیت امضا در امضامی"');
const inquiryModalEnd = source.indexOf("</Modal>", inquiryModalStart);
const inquiryModal = source.slice(inquiryModalStart, inquiryModalEnd);
assert.ok(!/PDF|ریال|تومان|راستی‌آزمایی|مقایسه/.test(inquiryModal)
  && inquiryModal.includes("به‌تنهایی به معنای تصویب مبلغ یا تأمین مالی نیست"),
  "status inquiry contains no terms diagnostics and does not equate signing with financial approval");
assert.ok(inquiryModal.includes("signatureResult.workflowAdvanced")
  && inquiryModal.includes("signatureResult.nextStage")
  && inquiryModal.includes("امضامی امضا را گزارش کرده است؛ در این استعلام گذار تازه‌ای در مرحلهٔ پرونده ثبت نشد."),
  "the result confirms only a server-reported transition and truthfully distinguishes no new transition");
assert.ok(verifyMutation.includes("getGetLoanApplicationQueryKey(appId)")
  && verifyMutation.includes("getListLoanApplicationsQueryKey()"),
  "the loan detail and list are refreshed after a provider result");

assert.ok(contractsSource.includes("const formatStatus = (status?: string, providerStatus?: string | null) => {")
  && contractsSource.indexOf("classifyProviderStatus(providerStatus)", contractsSource.indexOf("const formatStatus"))
    < contractsSource.indexOf("if (status === 'signed')", contractsSource.indexOf("const formatStatus")),
  "Contracts status label prefers provider status over historical generation status");
assert.ok(contractsSource.includes("generation.status === 'signed' || providerStatusIsSigned(generation.providerStatus)")
  && contractsSource.includes("const isSendingOrSent = isSigned || generation.status === 'sent' || generation.status === 'sending';"),
  "send gating retains its workflow status checks while using strict provider classification");
const contractsStatusModalStart = contractsSource.indexOf('<Modal title="وضعیت امضای قرارداد"');
const contractsStatusModalEnd = contractsSource.indexOf("</Modal>", contractsStatusModalStart);
const contractsStatusModal = contractsSource.slice(contractsStatusModalStart, contractsStatusModalEnd);
assert.ok(contractsStatusModal.includes("signatureStatusDialog.signed ?")
  && contractsStatusModal.includes("signatureStatusDialog.providerStatus ?? 'در پاسخ گزارش نشده'")
  && !contractsStatusModal.includes("providerStatusTitle || formatProviderStatus"),
  "Contracts status modal shows the returned signed boolean and raw provider status without a generic completion fallback");
assert.ok(contractsStatusModal.includes("signatureStatusDialog.workflowAdvanced")
  && contractsStatusModal.includes("signatureStatusDialog.nextStage")
  && contractsStatusModal.includes("در این استعلام گذار تازه‌ای در مرحلهٔ پرونده ثبت نشد."),
  "Contracts status modal reflects an actual server-reported transition or no new transition");
const contractsStatusHandlerStart = contractsSource.indexOf("function CheckSignatureStatusButton");
const contractsStatusHandler = contractsSource.slice(contractsStatusHandlerStart);
assert.ok(contractsStatusHandler.includes("if (workflowResult.workflowAdvanced)")
  && contractsStatusHandler.includes("getListLoanApplicationsQueryKey()")
  && contractsStatusHandler.includes("getGetLoanApplicationQueryKey(applicationId)"),
  "Contracts status inquiry refreshes the linked loan detail and list only when workflowAdvanced is returned");
assert.ok(contractsSource.includes("applicationId={gen.loanApplicationId}"),
  "Contracts status inquiry carries the linked application id for targeted refresh");

const legacyReplacementStart = source.indexOf("function LegacyTomanReplacementPanel");
const nextComponent = source.slice(legacyReplacementStart + 1).search(/\n(?:export default )?function /);
const legacyReplacementEnd = nextComponent < 0 ? source.length : legacyReplacementStart + 1 + nextComponent;
assert.ok(legacyReplacementStart >= 0 && legacyReplacementEnd > legacyReplacementStart,
  "legacy toman replacement UI is isolated in its own panel");
const legacyReplacementPanel = source.slice(legacyReplacementStart, legacyReplacementEnd);
assert.ok(source.includes("eligibility={app.tomanReplacementEligibility}")
  && source.includes("authorization={app.tomanReplacement}")
  && source.includes("type TomanReplacementEligibility")
  && source.includes("type TomanReplacementState"),
  "replacement eligibility and authorization use the generated API DTO types without any casts");
assert.ok(legacyReplacementPanel.includes("if (!authorization && (!isAdmin || !isCandidate || !eligibility)) return null;")
  && legacyReplacementPanel.includes("eligibility?.candidate || eligibility?.eligible")
  && legacyReplacementPanel.includes("{eligibility.eligible"),
  "unrelated applications stay hidden, only an administrator sees a candidate panel, and the server controls eligibility");
assert.ok(source.includes("useAuthorizeLoanApplicationTomanReplacement")
  && legacyReplacementPanel.includes("authorize.mutate({ id: appId, data: {")
  && legacyReplacementPanel.includes("consent: true")
  && legacyReplacementPanel.includes("reason: reason.trim()")
  && legacyReplacementPanel.includes("expectedGenerationId: consentTerms.sourceGenerationId")
  && legacyReplacementPanel.includes("expectedApprovedAmount: consentTerms.approvedAmount")
  && legacyReplacementPanel.includes("expectedDurationMonths: consentTerms.durationMonths"),
  "the generated mutation submits the generation, amount, and duration from the opened dialog's immutable snapshot");
assert.ok(legacyReplacementPanel.includes("setConsentTerms({ ...eligibility })")
  && legacyReplacementPanel.includes("sameTomanReplacementTerms(consentTerms, eligibility)")
  && legacyReplacementPanel.includes("setTermsChanged(true)")
  && legacyReplacementPanel.includes("formatTomanAmount(consentTerms.approvedAmount)"),
  "polling closes and clears consent if pinned terms or template change and never renders live terms inside the open dialog");
assert.ok(legacyReplacementPanel.includes("reason.trim().length < 8")
  && legacyReplacementPanel.includes("minLength={8}")
  && legacyReplacementPanel.includes("maxLength={1000}")
  && legacyReplacementPanel.includes("reason.trim().length < 8 || !consent"),
  "the trimmed reason honors the API minimum and maximum and requires affirmative consent");
assert.ok(legacyReplacementPanel.includes("sourceGenerationId")
  && legacyReplacementPanel.includes("formatTomanAmount(consentTerms.approvedAmount)} تومان")
  && legacyReplacementPanel.includes("eligibility.durationMonths).toLocaleString"),
  "the dialog displays the historic generation and the approved toman amount and duration");
assert.ok(legacyReplacementPanel.includes("PDF و امضای قبلی، سوابق و مبالغ ذخیره‌شده حفظ می‌شوند.")
  && legacyReplacementPanel.includes("مبلغ‌ها تبدیل، ضرب یا تقسیم نمی‌شوند"),
  "the dialog explicitly preserves prior evidence and forbids amount conversion");
assert.ok(legacyReplacementPanel.includes("قرارداد را صادر یا ارسال نمی‌کند")
  && legacyReplacementPanel.includes("invalidateQueries({ queryKey: getGetLoanApplicationQueryKey(appId) })")
  && legacyReplacementPanel.includes("invalidateQueries({ queryKey: getListLoanApplicationsQueryKey() })"),
  "authorization is not issuance and success refreshes detail and list state");

assert.ok(legacyReplacementPanel.includes("authorization.completedAt")
  && legacyReplacementPanel.includes("authorization?.resumeStage")
  && legacyReplacementPanel.includes("امضای قرارداد جایگزین تومانی تأیید و پرونده از توقف خارج شد")
  && legacyReplacementPanel.includes("هنوز در انتظار است"),
  "authorization status distinguishes waiting for signature from verified completion and displays the resumed stage");
assert.ok(source.includes("app.tomanReplacement?.authorized")
  && source.includes("اختلاف فقط در واحدِ نسخهٔ قدیمی است")
  && source.includes("هیچ تغییری در مبلغ یا مدت مصوب ثبت نشده"),
  "the generic changed-terms guidance is replaced by same-terms unit-mismatch guidance after authorization");
for (const [code, label] of [
  ["application_not_eligible", "این پرونده ردشده یا تکمیل‌شده است"],
  ["approved_terms_missing", "مبلغ یا مدت مصوب معتبر"],
  ["application_already_credited", "پرونده قبلاً اعتبار دریافت کرده"],
  ["replacement_already_authorized", "برای این پرونده پیش‌تر اجازهٔ جایگزینی"],
  ["accepted_current_primary_required", "نسل جاری قرارداد اصلی"],
  ["attested_active_toman_template_required", "قالب فعال و تأییدشدهٔ تومانی"],
  ["toman_template_terms_mapping_invalid", "نگاشت مبلغ یا مدت"],
  ["legacy_rial_principal_not_proven", "بند اصل مبلغ با واحد ریال"],
]) {
  assert.ok(legacyReplacementPanel.includes(`${code}: '${label}`),
    `blocked reason ${code} has a friendly localized label`);
}
assert.ok(legacyReplacementPanel.includes("messages[code]") && legacyReplacementPanel.includes("ثبت اجازه انجام نشد"),
  "unknown backend error codes are never displayed raw");

const contractSectionStart = source.indexOf("function isCurrentAuthorizedTomanReplacementSource");
assert.ok(contractSectionStart >= 0 && source.includes("tomanReplacement={app.tomanReplacement}"),
  "the generated authorization state is passed into the contract section");
const contractSection = source.slice(contractSectionStart);
const authorizationPredicateEnd = contractSection.search(/\n}\n\s*function ContractSection/);
const authorizationPredicateBodyStart = contractSection.indexOf("{");
assert.ok(authorizationPredicateEnd > authorizationPredicateBodyStart,
  "the replacement-source issuance predicate is present");
const canIssueAuthorizedSource = new Function(
  "authorization",
  "currentPrimaryGenerationId",
  "primaryDoc",
  "isReplacement",
  contractSection.slice(authorizationPredicateBodyStart + 1, authorizationPredicateEnd),
);
const legacySourceAuthorization = {
  authorized: true,
  sourceGenerationId: 41,
  completedAt: null,
  replacementGenerationId: null,
};
const providerAcceptedUnverifiedSource = {
  kind: "primary",
  contractGenerationId: 41,
  signed: false,
  generation_status: "signed",
  provider_status: "accept",
  current: true,
  isCurrentPrimary: true,
};
assert.equal(canIssueAuthorizedSource(legacySourceAuthorization, 41, providerAcceptedUnverifiedSource, true), true,
  "the authorized legacy source can be replaced when provider accepted it, even though workflow signed is false");
assert.equal(canIssueAuthorizedSource({ ...legacySourceAuthorization, replacementGenerationId: 42 }, 41, providerAcceptedUnverifiedSource, true), false,
  "an existing replacement generation blocks another issuance");
assert.equal(canIssueAuthorizedSource(legacySourceAuthorization, 43, providerAcceptedUnverifiedSource, true), false,
  "an authorization whose source is no longer current cannot issue a replacement");
assert.equal(canIssueAuthorizedSource(legacySourceAuthorization, 41, providerAcceptedUnverifiedSource, false), false,
  "the special issuance path is limited to the replacement-consent stage");
assert.ok(contractSection.includes("authorization?.authorized")
  && contractSection.includes("authorization.completedAt === null")
  && contractSection.includes("authorization.replacementGenerationId === null")
  && contractSection.includes("authorization.sourceGenerationId === currentPrimaryGenerationId")
  && !contractSection.includes("primaryDoc.signed === true")
  && contractSection.includes("primaryDoc.current !== false")
  && contractSection.includes("primaryDoc.isCurrentPrimary !== false"),
  "replacement issuance requires the authorized, incomplete source generation to remain the current primary, not workflow signed proof");
assert.ok(contractSection.includes("canIssuePrimary && (tomanReplacement?.authorized")
  && contractSection.includes(": !primaryDoc")
  && contractSection.includes("if (!mayIssuePrimary || issuingPrimary)")
  && contractSection.includes("{mayIssuePrimary && <button"),
  "both the issue handler and button allow retaining the old primary only for the exact pending authorization and block an existing replacement");
assert.ok(contractSection.includes("mayConfirmSignedPrimary = canConfirmSigned && !authorizedLegacySourcePending")
  && contractSection.includes("{mayConfirmSignedPrimary && primaryDoc?.signed"),
  "the preserved old signed source cannot be confirmed as the replacement contract or advanced");

console.log("Loan document review UI fixture passed: signature review guards and explicit legacy-toman replacement consent are enforced.");
