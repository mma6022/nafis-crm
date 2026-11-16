import {Router}from"express";
import {GetCallReportResponse,UpdateCallReportBody}from"@workspace/api-zod";
import {requirePermission}from"../lib/access-control";
import type {AuthUser}from"../lib/auth";
import {callReport,eventCallReport,saveCallReport,CallReportError}from"../lib/call-reports";
const router=Router();
for(const [path,byEvent]of[["/calls/:id/report",false],["/voip/after-call/:id/report",true]]as const){
  router.get(path,requirePermission("calls.view"),(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||!id||(byEvent&&id<0)){res.status(400).json({error:"شناسهٔ تماس معتبر نیست."});return;}
    try{res.json(GetCallReportResponse.parse(byEvent?eventCallReport(id,res.locals.authUser as AuthUser):callReport(id,res.locals.authUser as AuthUser)));}
    catch(e){res.status(e instanceof CallReportError?e.status:503).json({error:e instanceof CallReportError?e.message:"دریافت گزارش تماس انجام نشد."});}
  });
  router.patch(path,requirePermission("calls.view"),requirePermission("calls.create"),(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    const id=Number(req.params.id),parsed=UpdateCallReportBody.safeParse(req.body);
    if(!Number.isSafeInteger(id)||!id||(byEvent&&id<0)||!parsed.success||Object.keys(req.body).some(x=>!["subject","expertNotes","expectedRevision"].includes(x))){
      res.status(400).json({error:"اطلاعات گزارش تماس معتبر نیست."});return;}
    try{res.json(GetCallReportResponse.parse(saveCallReport(id,byEvent,res.locals.authUser as AuthUser,parsed.data)));}
    catch(e){res.status(e instanceof CallReportError?e.status:503).json({error:e instanceof CallReportError?e.message:"ذخیرهٔ گزارش تماس انجام نشد؛ دوباره تلاش کنید."});}
  });
}
export default router;
