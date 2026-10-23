import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { receiveSimotelCallEvent } from "../lib/simotel-call-events";
import { syncAfterCalls } from "../lib/voip-after-call";
import { invalidateSimotelCallCache } from "../lib/simotel";
const router=Router();
router.post("/",(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  const key=process.env.SIMOTEL_API_KEY;
  if(!key){res.status(503).json({error:"سرویس رویداد سیموتل تنظیم نشده است."});return;}
  const header=req.get("authorization")??"";
  const expected=Buffer.from(`crm-events:${key}`).toString("base64");
  const digest=(value:string)=>createHash("sha256").update(value).digest();
  if(header.length>1024 || !timingSafeEqual(digest(header),digest(`Basic ${expected}`))) {
    res.setHeader("WWW-Authenticate",'Basic realm="Simotel events"');
    res.status(401).json({error:"احراز هویت رویداد تماس نامعتبر است."});return;
  }
  if(!req.is("application/json")){res.status(415).json({error:"رویداد باید با G4 و POST JSON ارسال شود."});return;}
  try {
    const result=receiveSimotelCallEvent(req.body);
    if(result.cdr){invalidateSimotelCallCache();void syncAfterCalls().catch(()=>{});}
    res.json({ok:true,handled:result.handled});
  } catch {res.status(400).json({error:"ساختار رویداد تماس معتبر نیست."});}
});
export default router;
