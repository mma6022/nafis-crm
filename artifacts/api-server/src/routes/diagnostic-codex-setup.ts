import { Router, type RequestHandler } from "express";
import { randomBytes } from "node:crypto";

type Login = { start(origin: string): Promise<string>; status(): string | Promise<string> };
export function createCodexOAuthSetup(options: {
  requireAuth: RequestHandler; enabled(): boolean; origin(): string; login: Login;
  persistentConnection?: boolean;
}) {
  const router = Router(), base = "/diagnostics/setup/replit";
  const messages: Record<string, string> = {
    authorized: options.persistentConnection
      ? "دسترسی واقعی به ابزارهای Replit تأیید شد. اتصال گزارش‌ها به عامل هنوز باید تکمیل شود."
      : "ورود توسط کلاینت رسمی تأیید شد. دسترسی ابزارها و اتصال گزارش‌ها هنوز باید بررسی شود.",
    idle: "ورود این سرویس هنوز شروع نشده است.",
    awaiting_authorization: "در انتظار پایان ورود و زدن Allow در صفحهٔ رسمی Replit هستیم.",
    authorization_received: "پاسخ ورود دریافت شد؛ دسترسی واقعی به ابزارها در حال بررسی است.",
    verification_failed: "پاسخ ورود دریافت شد، اما دسترسی واقعی به ابزارهای Replit تأیید نشد.",
    failed: "ورود قبلی تکمیل نشد یا منقضی شد. با دکمهٔ زیر ورود تازه را شروع کنید.",
    unavailable: "سرویس اتصال در دسترس نیست؛ ورود یا اتصال عامل تأیید نشده است.",
  };
  const state = async () => {
    try {
      const received = await options.login.status();
      return typeof received === "string" && received in messages ? received : "unavailable";
    } catch { return "unavailable"; }
  };
  const nonces = new Map<number, { value: string; until: number }>();
  router.use(base, (req, res, next) => {
    res.set({
      // Same-origin form POSTs need a real Origin for the global CSRF guard.
      // Cross-origin OAuth navigation still receives no Referer.
      "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    if (!options.enabled()) { res.status(404).end(); return; }
    options.requireAuth(req, res, () => {
      if (res.locals.authUser?.role !== "admin") { res.status(403).end(); return; }
      next();
    });
  });
  router.get(`${base}/status`, async (_req, res) => {
    const phase = await state();
    res.json({ phase, connected: phase === "authorized", message: messages[phase], repairRunnerConnected: false });
  });
  // Reloading/bookmarking the POST destination must not start OAuth or 404.
  router.get(`${base}/login`, (_req, res) => {
    res.redirect(303, `/api${base}`);
  });
  router.get(base, async (_req, res) => {
    for (const [id, nonce] of nonces) if (nonce.until < Date.now()) nonces.delete(id);
    if (nonces.size >= 100) nonces.clear();
    const nonce = randomBytes(24).toString("base64url");
    const scriptNonce = randomBytes(24).toString("base64url");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
    nonces.set(Number(res.locals.authUser.id), { value: nonce, until: Date.now() + 15 * 60_000 });
    const phase = await state(), authorized = phase === "authorized";
    res.type("html").send(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>اتصال رسمی Replit</title>
<style>body{font-family:Tahoma,sans-serif;background:#f5f6fa;color:#17294f;line-height:2;margin:0;padding:24px;box-sizing:border-box}main{max-width:560px;margin:48px auto;padding:24px;background:white;border:1px solid #dce1ec;border-radius:16px}button{font:inherit;color:white;background:#17294f;border:0;border-radius:8px;padding:10px 20px;cursor:pointer}</style>
<main><h1>اتصال رسمی Replit</h1><p id="connection-status" role="status" aria-live="polite">${messages[phase]}</p>
<p>دکمهٔ ورود، صفحهٔ رسمی Replit را در برگهٔ دیگری باز می‌کند. فضای کاری همین پروژه را انتخاب و Allow را تأیید کنید؛ این برگه نتیجهٔ واقعی اتصال را خودکار بررسی می‌کند.</p>
${options.persistentConnection ? "<p>این اتصال در سرویس مستقل روی VPS نگهداری می‌شود، نه در محیط موقت توسعه. برای انتقال اتصال به این سرویس، تأیید ورود باید برای همین کلاینت انجام شود.</p>" : ""}
<p>مجوز شامل خواندن و تغییر برنامه‌های فضای کاری انتخاب‌شده و حفظ اتصال برای کار خودکار است. این مرحله چیزی روی سرور اصلی منتشر نمی‌کند.</p>
<form id="connection-form" method="post" action="/api${base}/login" target="_blank" rel="noopener"><input type="hidden" name="nonce" value="${nonce}"><button id="connection-login" type="submit">${authorized ? "ورود دوباره به Replit" : "ورود به Replit"}</button></form>
<p><button id="connection-check" type="button">بررسی وضعیت اتصال</button></p>
<p>فقط پیام «دسترسی واقعی به ابزارهای Replit تأیید شد» نشانهٔ موفقیت اتصال VPS است؛ ثبت گزارش یا زدن Allow به‌تنهایی کافی نیست. هیچ رمز یا توکنی را در گفتگو ارسال نکنید.</p></main>
<script nonce="${scriptNonce}">
let busy=false,checks=0;
document.getElementById("connection-form").addEventListener("submit",async(event)=>{
 event.preventDefault();
 const button=document.getElementById("connection-login");
 if(button.disabled)return;
 const destination=window.open("about:blank","_blank");
 if(destination)destination.opener=null;
 button.disabled=true;
 try{
  const response=await fetch("/api${base}/login",{
   method:"POST",credentials:"same-origin",redirect:"error",
   headers:{"Content-Type":"application/json","Accept":"application/json"},
   body:JSON.stringify({nonce:document.querySelector('input[name="nonce"]').value}),
   signal:AbortSignal.timeout(55000)
  });
  if(!response.ok)throw new Error("login_failed");
  const result=await response.json(),target=new URL(result.authorization);
  if(target.origin!=="https://replit.com"||target.pathname!=="/oidc/auth")throw new Error("invalid_target");
  if(destination&&!destination.closed)destination.location.replace(target.href);
  else window.location.assign(target.href);
  document.getElementById("connection-status").textContent="صفحهٔ ورود باز شد؛ پس از تأیید Allow، نتیجهٔ اتصال اینجا بررسی می‌شود.";
 }catch{
  if(destination&&!destination.closed)destination.close();
  document.getElementById("connection-status").textContent="شروع ورود انجام نشد؛ این صفحه را تازه‌سازی کنید و دوباره دکمهٔ ورود را بزنید.";
 }finally{button.disabled=false;}
});
async function checkConnection(){
 if(busy||checks>=80)return;
 busy=true;checks++;
 try{
  const response=await fetch("/api${base}/status",{credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(50000)});
  if(!response.ok)throw new Error("unavailable");
  const result=await response.json();
  document.getElementById("connection-status").textContent=result.message;
  document.getElementById("connection-login").textContent=result.connected?"ورود دوباره به Replit":"ورود به Replit";
 }catch{document.getElementById("connection-status").textContent="دریافت وضعیت انجام نشد؛ اتصال موفق تأیید نشده است. اگر جلسه منقضی شده، دوباره وارد CRM شوید.";}
 finally{busy=false;}
}
document.getElementById("connection-check").addEventListener("click",()=>{checks=0;void checkConnection();});
window.addEventListener("focus",()=>{void checkConnection();});
setInterval(()=>{void checkConnection();},8000);
</script></html>`);
  });
  router.post(`${base}/login`, async (req, res): Promise<void> => {
    const actor = Number(res.locals.authUser.id), nonce = nonces.get(actor);
    if (!nonce || nonce.until < Date.now() || req.body?.nonce !== nonce.value) {
      res.status(403).send("این صفحه منقضی شده است؛ صفحهٔ اتصال را دوباره باز کنید."); return;
    }
    nonces.delete(actor);
    try {
      const authorization = await options.login.start(options.origin());
      // A second origin check also protects callers that supply a different login adapter.
      const target = new URL(authorization);
      if (target.origin !== "https://replit.com" || target.pathname !== "/oidc/auth")
        throw new Error("invalid_authorization_origin");
      // Browser fetch explicitly requests JSON, avoiding form-redirect navigation
      // through proxy/CSP layers. Legacy POST clients retain their 303 behavior.
      if (req.get("Accept") === "application/json") {
        res.json({ authorization }); return;
      }
      res.redirect(303, authorization);
    } catch {
      res.status(503).send("شروع ورود انجام نشد. صفحهٔ اتصال را دوباره باز کنید و تلاش کنید.");
    }
  });
  return router;
}

