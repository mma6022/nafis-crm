import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { receiveSimotelCallEvent } from "../lib/simotel-call-events";
import { syncAfterCalls } from "../lib/voip-after-call";
import { invalidateSimotelCallCache } from "../lib/simotel";
const router=Router();
// SIMOTEL-WEBHOOK: dedicated webhook secret (SIMOTEL_WEBHOOK_PASSWORD, from the root-only EnvironmentFile
// /etc/nafisvam/simotel-webhook.env); falls back to SIMOTEL_API_KEY when unset so existing behaviour is unchanged.
// Accepts POST / and POST /:event (Simotel appends the event name, e.g. /NewState). This router is mounted before
// requireApiAuth, so it always enforces its own constant-time Basic auth before reading the body.
export function webhookSecret(env:NodeJS.ProcessEnv=process.env):string|undefined {
  const own=env.SIMOTEL_WEBHOOK_PASSWORD;
  return own ? own : (env.SIMOTEL_API_KEY || undefined);
}
router.post(["/","/:event"],(req,res)=>{
  res.setHeader("Cache-Control","no-store");
  const key=webhookSecret();
  if(!key){res.status(503).json({error:"سرویس رویداد سیموتل تنظیم نشده است."});return;}
  const header=req.get("authorization")??"";
  const expected=Buffer.from(`crm-events:${key}`).toString("base64");
  const digest=(value:string)=>createHash("sha256").update(value).digest();
  if(header.length>1024 || !timingSafeEqual(digest(header),digest(`Basic ${expected}`))) {
    res.setHeader("WWW-Authenticate",'Basic realm="Simotel events"');
    res.status(401).json({error:"احراز هویت رویداد تماس نامعتبر است."});return;
  }
  const pathEvent=typeof req.params.event==="string"?req.params.event:"";
  if(pathEvent && !/^[A-Za-z][A-Za-z _-]{0,39}$/.test(pathEvent)){res.status(404).json({error:"رویداد تماس ناشناخته است."});return;}
  if(!req.is("application/json")){res.status(415).json({error:"رویداد باید با G4 و POST JSON ارسال شود."});return;}
  try {
    let body:unknown=req.body;
    if(pathEvent && body && typeof body==="object" && !Array.isArray(body)) {
      const given=(body as Record<string,unknown>).event_name;
      if(given===undefined || given===null || (typeof given==="string" && !given.trim()))body={...(body as Record<string,unknown>),event_name:pathEvent};
    }
    const result=receiveSimotelCallEvent(body);
    if(result.cdr){invalidateSimotelCallCache();void syncAfterCalls().catch(()=>{});}
    res.json({ok:true,handled:result.handled});
  } catch {res.status(400).json({error:"ساختار رویداد تماس معتبر نیست."});}
});
export default router;
