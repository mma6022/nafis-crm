import { Router, type Response } from "express";
import { createHash } from "node:crypto";
import { portalDocumentsState } from "../lib/portal-intake-documents";
import { customerPortalSession,requireCustomerPortal } from "../lib/customer-portal-auth";
import { execute,executeChanges,queryRow,queryRows,runTransaction } from "../lib/crm-db";
import { customerPortalIdentityReady } from "../lib/customer-portal-identity";
import { normalizePostal } from "../lib/customer-portal-validation";
import { normalizeDigits } from "../lib/ics24";
import { freshSuccessfulCredit,payablePlan,planAcceptsCustomerCredit,reusableFilingFeeCharge } from "./loan-applications";
import { verifyPortalCustomer } from "./customer-portal-profile";
import { consultationFields,consultationQuestionnaireOptions,getConsultation,computeConsultationPlanMatches } from "./crm";
import { finderQuote } from "../lib/plan-quote-math";
import { questionnaireError } from "../lib/consultation-questionnaire";
import { CreateConsultationBody } from "@workspace/api-zod";
const router=Router();router.use(requireCustomerPortal);
function ownCustomer(res:Response) {
  const id=customerPortalSession(res)?.customerId;
  const c=id?queryRow<any>("SELECT * FROM customers WHERE id=? AND merged_into_customer_id IS NULL",[id]):null;
  if(!c||!customerPortalIdentityReady(c)){res.status(403).json({error:"identity_verification_required"});return null;}
  return c;
}
const answered=(status:unknown) => typeof status==="string" && ["success","failed","manual_approved","manual_rejected"].includes(status);
export function portalIntakeState(customerId:number,planId:number) {
  const c=queryRow<any>("SELECT * FROM customers WHERE id=?",[customerId]);
  const plan=payablePlan(planId),credit=freshSuccessfulCredit(customerId);
  const fee=reusableFilingFeeCharge(customerId,planId);
  const documents=portalDocumentsState(customerId,fee?.created_at??null);
  const key=createHash("sha256").update(JSON.stringify({nationalCode:c.national_code,mobile:c.phone,
    birthDateJalali:c.birth_date_jalali,postalCode:c.postal_code,name:c.name,fatherName:c.father_name})).digest("hex");
  // Older fully verified profiles predate individual inquiry metadata. Respect
  // that existing aggregate approval, but never override an explicit negative.
  const legacyVerified=c.verification_status==="verified"&&c.postal_code_info_ok==null&&c.sana_ok==null&&
    c.postal_code_info_status==null&&c.sana_status==null;
  const verification={postalOk:legacyVerified||c.postal_code_info_ok===1,sanaOk:legacyVerified||c.sana_ok===1,
    postalAnswered:legacyVerified||answered(c.postal_code_info_status),sanaAnswered:legacyVerified||answered(c.sana_status),postalCode:c.postal_code??null,
    inquiryAttempted:!!queryRow("SELECT 1 FROM customer_portal_inquiry_claims WHERE customer_id=? AND identity_key=?",[customerId,key])};
  const planEligible=!!plan&&!!credit&&planAcceptsCustomerCredit(planId,customerId);
  return {creditValid:!!credit,creditRank:credit?.score_label??null,planEligible,
    feeChargeId:fee?Number(fee.id):null,existingApplicationId:fee?.active_application_id==null?null:Number(fee.active_application_id),
    filingFeeToman:String(plan?.filing_fee_toman??"0"),verification,...documents,
    canSubmit:!!plan&&!!credit&&planEligible&&!!fee&&verification.postalOk&&verification.sanaOk&&
      c.verification_status==="verified"&&documents.documentsComplete};
}
router.get("/intake/status",(req,res)=>{
  const c=ownCustomer(res);if(!c)return;
  const planId=Number(req.query.planId);
  if(!Number.isSafeInteger(planId)||planId<=0||!payablePlan(planId)){res.status(404).json({error:"loan_plan_not_found"});return;}
  res.setHeader("Cache-Control","no-store");res.json(portalIntakeState(c.id,planId));
});
router.post("/intake/verify",async(req,res):Promise<void>=>{
  const c=ownCustomer(res);if(!c)return;
  const planId=Number(req.body?.planId);
  const postal=normalizePostal(typeof req.body?.postalCode==="string"?normalizeDigits(req.body.postalCode):null);
  if(!Number.isSafeInteger(planId)||!postal||Object.keys(req.body??{}).some(k=>!["planId","postalCode"].includes(k))){
    res.status(400).json({error:"invalid_postal_code",message:"کد پستی ده‌رقمی معتبر وارد کنید."});return;
  }
  const state=portalIntakeState(c.id,planId);
  if(!state.creditValid||!state.planEligible||!state.feeChargeId){
    res.status(422).json({error:"filing_fee_required",message:"ابتدا اعتبارسنجی و هزینهٔ ثابت طرح انتخاب‌شده را تکمیل کنید."});return;
  }
  // A paid receipt doesn't permit arbitrary repeated postal inquiries.
  if(c.postal_code!==postal){
    const attempts=queryRow<{n:number}>(`SELECT COUNT(*) n FROM customer_portal_inquiry_claims WHERE customer_id=? AND updated_at>?`,
      [c.id,new Date(Date.now()-24*3600_000).toISOString()]);
    if(Number(attempts?.n??0)>=3){res.status(429).json({error:"inquiry_input_limit",message:"برای اصلاح اطلاعات استعلام با کارشناس تماس بگیرید."});return;}
    runTransaction(()=>{
      executeChanges("UPDATE customers SET postal_code=?,postal_code_info_ok=NULL,postal_code_info_status=NULL,verification_status='unverified' WHERE id=?",[postal,c.id]);
      execute("INSERT INTO customer_portal_profile_audit(customer_id,actor_mobile,old_values_json,new_values_json,created_at) VALUES(?,?,?,?,?)",
        [c.id,customerPortalSession(res)!.mobile,JSON.stringify({postalCode:c.postal_code}),JSON.stringify({postalCode:postal}),new Date().toISOString()]);
    });
  }
  await verifyPortalCustomer(req,res);
});
router.get("/plan-finder/options",(_req,res)=>{
  if(!ownCustomer(res))return;
  res.json({options:consultationQuestionnaireOptions().map(o=>({...o,label:o.labelFa}))});
});
router.post("/plan-finder",(req,res)=>{
  const c=ownCustomer(res);if(!c)return;
  const allowed=["questionnaireVersion","creditRank","customerCheckStatus","hasCustomerSalaryDeduct","jobType","hasGuarantor",
    "guarantorCreditRank","guarantorCheckType","hasGuarantorSalaryDeduct","requestedAmount"];
  if(req.body?.questionnaireVersion!==2||Object.keys(req.body??{}).some(k=>!allowed.includes(k))){
    res.status(400).json({error:"invalid_questionnaire"});return;
  }
  const parsed=CreateConsultationBody.safeParse({...req.body,customerId:Number(c.id)});
  if(!parsed.success){res.status(400).json({error:"invalid_questionnaire",message:"پاسخ‌های پرسشنامه کامل نیست."});return;}
  const body=parsed.data as Record<string,unknown>,issue=questionnaireError(body,consultationQuestionnaireOptions());
  if(issue){res.status(400).json({error:issue});return;}
  const recent=queryRow<{n:number}>("SELECT COUNT(*) n FROM consultation_forms WHERE customer_id=? AND created_at>?",[c.id,new Date(Date.now()-3600_000).toISOString()]);
  if(Number(recent?.n??0)>=20){res.status(429).json({error:"consultation_rate_limit"});return;}
  Object.assign(body,{hasCheck:body.customerCheckStatus!=="none",hasGuarantorCheck:!!body.hasGuarantor&&body.guarantorCheckType!=="none",
    hasPromissory:true,hasGuarantorPromissory:!!body.hasGuarantor});
  if(!body.hasGuarantor)Object.assign(body,{guarantorCreditRank:null,guarantorCheckType:"none",hasGuarantorSalaryDeduct:false});
  const response=runTransaction(()=>{
    const values=consultationFields(body),at=new Date().toISOString();
    values.push(["created_at",at],["updated_at",at]);
    const id=execute(`INSERT INTO consultation_forms(${values.map(([key])=>key).join(",")}) VALUES(${values.map(()=>"?").join(",")})`,values.map(([,v])=>v));
    const saved=getConsultation(id)!;
    const matches=computeConsultationPlanMatches(saved);
    executeChanges("UPDATE consultation_forms SET plan_matches_snapshot=? WHERE id=?",[JSON.stringify({capturedAt:at,requestedAmount:saved.requestedAmount,matches}),id]);
    return {consultationId:id,matches};
  });
  // Customer view: no plan internals (principal/rates/percents) — only names, status and server-computed payout/installment.
  res.status(201).json({consultationId:response.consultationId,matches:response.matches.map(m=>({
    plan:{id:m.plan.id,name:m.plan.name,bankName:m.plan.bankName,filingFeeToman:m.plan.filingFeeToman},
    status:m.status,failedRequirements:m.failedRequirements,missingInformation:m.missingInformation,
    quote:finderQuote(m.plan,m.customerMaximumAmount),
  }))});
});
export default router;
