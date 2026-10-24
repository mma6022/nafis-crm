import { Router } from "express";
import { createHash } from "node:crypto";
import { crmDb, queryRow, queryRows } from "./crm-db";
import { requireAuth, type AuthUser } from "./auth";
import { registerNotificationActorFunction } from "./notification-actor-context";

type Event = {
  id: number; customer_id: number; customer_name: string; owner_id: number | null;
  resource_type: string; resource_id: number; kind: string; title: string; body: string;
  permission: string; created_at: string; current_customer_id: number | null; read_at: string | null;
};
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Source = { table: string; customer: (row: string) => string; resource?: (row: string) => string;
  type: string; permission: string; title: string; kind?: string; insertOnly?: boolean;
  when?: (row: string) => string; body?: (row: string) => string; watch?: string[] };
const direct = (row: string) => `${row}.customer_id`;
const loanId = (row: string) => `${row}.application_id`;
const loanCustomer = (row: string) => `(SELECT customer_id FROM loan_applications WHERE id=${loanId(row)})`;
const purchaseId = (row: string) => `${row}.purchase_id`;
const purchaseCustomer = (row: string) => `(SELECT customer_id FROM goods_purchases WHERE id=${purchaseId(row)})`;

export function installSiteNotifications() {
  registerNotificationActorFunction(crmDb);
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS site_notification_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,customer_name TEXT NOT NULL,
      owner_id INTEGER,resource_type TEXT NOT NULL,resource_id INTEGER NOT NULL,kind TEXT NOT NULL,
      title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',permission TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_site_notification_customer ON site_notification_events(customer_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_site_notification_resource ON site_notification_events(resource_type,resource_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS site_notification_reads(
      user_id INTEGER NOT NULL,event_id INTEGER NOT NULL REFERENCES site_notification_events(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
    CREATE TABLE IF NOT EXISTS site_notification_watermarks(
      user_id INTEGER PRIMARY KEY,last_read_id INTEGER NOT NULL DEFAULT 0,read_at TEXT NOT NULL);
  `);
  const eventColumns = crmDb.prepare("PRAGMA table_info(site_notification_events)").all() as { name: string }[];
  // Old events retain NULL so this rollout neither rewrites nor groups history.
  if (!eventColumns.some(column => column.name === "actor_key"))
    crmDb.exec("ALTER TABLE site_notification_events ADD COLUMN actor_key TEXT");
  crmDb.exec(`CREATE INDEX IF NOT EXISTS idx_site_notification_actor_window
    ON site_notification_events(resource_type,resource_id,customer_id,actor_key,created_at DESC)`);
  // Only this connection's TEMP trigger calls the request-local SQL function.
  // Persistent triggers remain usable by maintenance/background connections
  // without requiring a new application-defined function on those connections.
  const capturedColumns = [
    "customer_id","customer_name","owner_id","resource_type","resource_id",
    "kind","title","body","permission","created_at",
  ];
  const actorCapture = `DROP TRIGGER IF EXISTS temp.site_notification_capture_actor;
    CREATE TEMP TRIGGER site_notification_capture_actor BEFORE INSERT ON main.site_notification_events
    WHEN NEW.actor_key IS NULL
    BEGIN
      INSERT INTO site_notification_events(${capturedColumns.join(",")},actor_key)
        VALUES(${capturedColumns.map(column=>`NEW.${column}`).join(",")},site_notification_actor());
      SELECT RAISE(IGNORE);
    END;
    DROP TRIGGER IF EXISTS site_notification_group_loan_minute;
    CREATE TRIGGER site_notification_group_loan_minute AFTER INSERT ON site_notification_events
    WHEN NEW.resource_type='loan' AND EXISTS (
      SELECT 1 FROM site_notification_events e
      WHERE e.id<NEW.id AND e.resource_type=NEW.resource_type
        AND e.resource_id=NEW.resource_id AND e.customer_id=NEW.customer_id
        AND COALESCE(e.actor_key,'system')=COALESCE(NEW.actor_key,'system')
        AND e.permission=NEW.permission
        AND e.created_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-60 seconds')
        AND e.created_at<=NEW.created_at
    )
    BEGIN DELETE FROM site_notification_events WHERE id=NEW.id; END;`;
  const sources: Source[] = [
    { table:"customers",customer:r=>`${r}.id`,type:"customer",permission:"customers.view",title:"پروندهٔ مشتری تغییر کرد" },
    { table:"customer_chat_messages",customer:direct,type:"chat",permission:"customers.view",title:"پیام جدید مشتری",kind:"customer-message",insertOnly:true,
      when:r=>`${r}.sender_type='customer'`,body:r=>`CASE WHEN ${r}.text<>'' THEN substr(${r}.text,1,160) ELSE 'مشتری یک پیوست فرستاده است.' END` },
    { table:"instagram_messages",customer:r=>`(SELECT customer_id FROM instagram_threads WHERE id=${r}.thread_id)`,
      resource:r=>`${r}.thread_id`,type:"instagram",permission:"instagram.staff",title:"پیام جدید اینستاگرام مشتری",kind:"customer-message",insertOnly:true,
      when:r=>`${r}.direction='inbound'`,body:()=>lit("پیام جدیدی در گفت‌وگوی اینستاگرام این مشتری ثبت شد.") },
    { table:"loan_application_notes",customer:loanCustomer,resource:loanId,type:"loan",permission:"loan_applications.view",title:"یادداشت جدید در پروندهٔ تسهیلات",kind:"case-note",insertOnly:true,
      body:r=>`substr(${r}.author_name || ': ' || CASE WHEN ${r}.text<>'' THEN ${r}.text ELSE 'یادداشت پیوست‌دار' END,1,160)` },
    { table:"loan_applications",customer:direct,type:"loan",permission:"loan_applications.view",title:"پروندهٔ تسهیلات تغییر کرد" },
    { table:"loan_application_stage_history",customer:loanCustomer,resource:loanId,type:"loan",permission:"loan_applications.view",title:"رویداد جدید در پروندهٔ تسهیلات",insertOnly:true,when:r=>`${r}.action<>'case-note-added'` },
    ...["loan_application_documents","loan_application_collateral","loan_application_generated_documents","loan_application_guarantors",
      "loan_funder_defects","loan_physical_checks","loan_physical_documents","loan_salesperson_attribution_audit","loan_filing_fee_charges"].map(table=>({
        table,customer:loanCustomer,resource:loanId,type:"loan",permission:"loan_applications.view",title:"مدارک یا جزئیات پروندهٔ تسهیلات تغییر کرد" })),
    { table:"loan_application_guarantor_documents",customer:r=>`(SELECT a.customer_id FROM loan_applications a JOIN loan_application_guarantors g ON g.application_id=a.id WHERE g.id=${r}.guarantor_id)`,
      resource:r=>`(SELECT application_id FROM loan_application_guarantors WHERE id=${r}.guarantor_id)`,type:"loan",permission:"loan_applications.view",title:"مدارک ضامن تغییر کرد" },
    { table:"goods_purchases",customer:direct,type:"goods",permission:"goods_purchases.view",title:"پروندهٔ خرید کالا تغییر کرد" },
    ...["goods_purchase_documents","goods_purchase_events","goods_invoice_items","goods_finance_ledger"].map(table=>({
      table,customer:purchaseCustomer,resource:purchaseId,type:"goods",permission:"goods_purchases.view",title:"مدارک یا جزئیات خرید کالا تغییر کرد" })),
    { table:"contract_generations",customer:direct,type:"contract",permission:"contracts.view",title:"وضعیت قرارداد تغییر کرد",
      watch:["status","provider_status","error_message","deleted_at","superseded_at"] },
    ...["customer_credit_checks","customer_verification_events","customer_portal_verification_events",
      "customer_manual_verification_requests","customer_manual_verification_decisions","customer_manual_check_decisions",
      "customer_identity_documents","customer_bank_accounts","customer_portal_profile_audit","customer_repeat_requests",
      "customer_portal_registrations","customer_tags"].map(table=>({
        table,customer:direct,type:"customer",permission:table==="customer_credit_checks"?"customers.credit_check":"customers.view",
        title:table==="customer_credit_checks"?"وضعیت اعتبارسنجی مشتری تغییر کرد":"اطلاعات پروندهٔ مشتری تغییر کرد" })),
    ...["call_logs","voip_after_call_events"].map(table=>({
      table,customer:direct,type:"calls",permission:"calls.view",title:"تماس یا یادداشت تماس ثبت شد",kind:"customer-note" })),
    ...["consultation_forms","customer_portal_conversations"].map(table=>({
      table,customer:direct,type:"consultations",permission:"consultations.view",title:"مشاورهٔ مشتری تغییر کرد" })),
    { table:"customer_payment_orders",customer:direct,type:"payment",permission:"payment_orders.view",title:"دستور پرداخت مشتری تغییر کرد" },
    ...["wallet_accounts_v2","wallet_payment_intents","wallet_share_links"].map(table=>({
      table,customer:direct,type:"wallet",permission:"wallets.view",title:"وضعیت کیف پول مشتری تغییر کرد" })),
  ];
  const triggerCommands:string[]=[];
  for (const source of sources) {
    const columns = crmDb.prepare(`PRAGMA table_info(${q(source.table)})`).all() as {name:string;pk:number}[];
    if (!columns.length) continue;
    const names = new Set(columns.map(c=>c.name));
    const identity = names.has("id") ? "id" : names.has("customer_id") ? "customer_id" : null;
    if (!identity) continue;
    const expressions=[source.customer("NEW"),source.resource?.("NEW"),source.when?.("NEW"),source.body?.("NEW")].filter(Boolean).join(" ");
    for(const reference of expressions.matchAll(/\bNEW\.(?:"([^"]+)"|(\w+))/g)){
      const field=reference[1]??reference[2];
      if(!names.has(field))throw new Error(`notification_schema_mismatch:${source.table}:${field}`);
    }
    const watched = (source.watch ?? columns.map(c=>c.name).filter(n=>![
      "id","updated_at","created_at","notified_at","last_seen_at","completed_at","input_json","canonical_json","checks_json",
      "send_claim_id","send_claim_expires_at","job_token","job_lease_expires_at","provider_idempotency_key","content_hash",
      "verification_version","portal_auth_version","phone_normalized","national_code_normalized",
      // crm-no-plan-option: customers.city is filled by the first-call form in the same save; no separate bell event.
      "city",
    ].includes(n))).filter(n=>names.has(n));
    for (const operation of source.insertOnly ? ["INSERT"] : ["INSERT","UPDATE","DELETE"]) {
      if (operation==="UPDATE" && !watched.length) continue;
      const row = operation==="DELETE" ? "OLD" : "NEW";
      const changed = operation==="UPDATE" ? `(${watched.map(n=>`OLD.${q(n)} IS NOT NEW.${q(n)}`).join(" OR ")})` : "1";
      const customer = source.customer(row), resource = source.resource?.(row) ?? `${row}.${q(identity)}`;
      // Deletion of the customer itself uses its immutable old owner snapshot.
      const ownCustomer = source.table==="customers";
      const owner = ownCustomer ? `${row}.salesperson_id` : `(SELECT salesperson_id FROM customers WHERE id=${customer})`;
      const name = ownCustomer ? `${row}.name` : `(SELECT name FROM customers WHERE id=${customer})`;
      const title = operation==="DELETE" ? source.title+" (حذف)" : source.title;
      const trigger = `site_notify_${source.table}_${operation.toLowerCase()}`;
      triggerCommands.push(`DROP TRIGGER IF EXISTS ${q(trigger)};
        CREATE TRIGGER ${q(trigger)} AFTER ${operation} ON ${q(source.table)}
        WHEN ${changed} AND (${source.when?.(row) ?? "1"}) AND ${customer} IS NOT NULL
        BEGIN INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at)
        VALUES(${customer},COALESCE(${name},'مشتری'),${owner},${lit(source.type)},COALESCE(${resource},${row}.${q(identity)}),
          ${lit(ownCustomer&&operation==="DELETE"?"customer-deleted":source.kind??"case-change")},${lit(title)},${source.body?.(row)??lit("برای بررسی، پروندهٔ مرتبط را باز کنید.")},
          ${lit(source.permission)},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
    }
  }
  crmDb.exec("BEGIN IMMEDIATE");
  try{crmDb.exec(actorCapture + triggerCommands.join("\n"));crmDb.exec("COMMIT");}
  catch(error){crmDb.exec("ROLLBACK");throw error;}
}

function permitted(user: AuthUser) {
  const permissions = user.role==="admin" ? null : [...user.permissions,...(user.role==="registrar"?["instagram.staff"]:[])];
  // Notification delivery is narrower than permission to browse CRM records.
  const assigned = user.role!=="admin";
  const owner = assigned ? "(CASE WHEN c.id IS NOT NULL THEN c.salesperson_id ELSE e.owner_id END=?)" : "1";
  return {
    sql:`${owner} ${permissions ? `AND e.permission IN (${permissions.length?permissions.map(()=>"?").join(","):"NULL"})` : ""}`,
    params:[...(assigned?[user.salespersonId??-1]:[]),...(permissions??[])],
  };
}
function from(user: AuthUser) {
  const scope = permitted(user);
  // Audited merge lineage is the same one used by authorized customer chat.
  const ownersExist=!!queryRow("SELECT 1 FROM sqlite_master WHERE name='customer_chat_owners' AND type='view'");
  const ownership=ownersExist?"LEFT JOIN customer_chat_owners f ON f.origin_customer_id=e.customer_id LEFT JOIN customers c ON c.id=f.customer_id AND c.merged_into_customer_id IS NULL":
    "LEFT JOIN customers c ON c.id=e.customer_id AND c.merged_into_customer_id IS NULL";
  return {sql:`FROM site_notification_events e ${ownership}
    LEFT JOIN site_notification_reads r ON r.event_id=e.id AND r.user_id=?
    LEFT JOIN site_notification_watermarks w ON w.user_id=?
    WHERE ${scope.sql}
      AND (c.id IS NOT NULL OR (e.kind='customer-deleted' AND NOT EXISTS(SELECT 1 FROM customers missing WHERE missing.id=e.customer_id)))`,
    params:[user.id,user.id,...scope.params]};
}
const selection=`e.*,COALESCE(c.name,e.customer_name) customer_name,c.id current_customer_id,
  CASE WHEN e.id<=COALESCE(w.last_read_id,0) THEN w.read_at ELSE r.read_at END read_at`;
const notificationPages = {
  customer: "customers", chat: "chat", instagram: "instagram-inbox", loan: "loan-applications", loan_draft: "loan-applications",
  goods: "goods-purchases", contract: "contracts", payment: "payment-orders",
  calls: "calls", consultations: "consultations", wallet: "wallet-management",
} as const;
const pageExpression = `CASE e.resource_type ${Object.entries(notificationPages).map(([type,page])=>`WHEN ${lit(type)} THEN ${lit("/"+page)}`).join(" ")} ELSE '/customers' END`;
function pageFilter(value: unknown): {sql:string;params:string[]} | null {
  if(value===undefined) return {sql:"",params:[]};
  if(typeof value!=="string")return null;
  const page=value.replace(/^\//,"");
  if(!Object.values(notificationPages).includes(page as typeof notificationPages[keyof typeof notificationPages]))return null;
  return {sql:`AND (${pageExpression})=?`,params:["/"+page]};
}
function target(e: Event) {
  const id=e.current_customer_id;
  if (!id) return "/customers";
  if(e.resource_type==="chat")return `/chat?customerId=${id}`;
  if(e.resource_type==="instagram")return `/instagram-inbox?threadId=${e.resource_id}`;
  if(e.resource_type==="loan") {
    const row=queryRow<{deleted_at:string|null}>("SELECT deleted_at FROM loan_applications WHERE id=? AND customer_id=?",[e.resource_id,id]);
    return row&&!row.deleted_at?`/loan-applications/${e.resource_id}${e.kind==="case-note"?"?focus=notes":""}`:"/loan-applications";
  }
  if(e.resource_type==="loan_draft") {
    const row=queryRow<{deleted_at:string|null}>("SELECT deleted_at FROM loan_request_drafts WHERE id=? AND customer_id=?",[e.resource_id,id]);
    return row&&!row.deleted_at?`/loan-applications?tab=pending&draftId=${e.resource_id}`:"/loan-applications?tab=pending";
  }
  if(e.resource_type==="goods")return queryRow("SELECT 1 FROM goods_purchases WHERE id=? AND customer_id=?",[e.resource_id,id])?`/goods-purchases/${e.resource_id}`:"/goods-purchases";
  if(e.resource_type==="contract")return `/contracts?customerId=${id}`;
  if(e.resource_type==="payment")return `/payment-orders/${e.resource_id}`;
  if(e.resource_type==="calls")return `/calls?customerId=${id}`;
  if(e.resource_type==="consultations")return `/consultations?customerId=${id}`;
  if(e.resource_type==="wallet")return `/wallet-management?customerId=${id}`;
  return `/customers/${id}`;
}
export function createSiteNotificationRouter() {
  installSiteNotifications();
  const router=Router();
  router.use("/site-notifications",requireAuth,(_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
  router.get("/site-notifications",(req,res)=>{
    const user=res.locals.authUser as AuthUser,scope=from(user);
    const before=req.query.beforeId===undefined?null:Number(req.query.beforeId);
    const limit=req.query.limit===undefined?30:Number(req.query.limit);
    const filter=pageFilter(req.query.page);
    if(!filter||!Number.isSafeInteger(limit)||limit<1||limit>50||(before!==null&&(!Number.isSafeInteger(before)||before<1))||
      (req.query.unreadOnly!==undefined&&!["true","false"].includes(String(req.query.unreadOnly)))){
      res.status(400).json({error:"invalid_notification_cursor"});return;
    }
    const unread="AND e.id>COALESCE(w.last_read_id,0) AND r.event_id IS NULL";
    const count=queryRow<{n:number}>(`SELECT COUNT(DISTINCT e.id) n ${scope.sql} ${unread}`,scope.params)?.n??0;
    const pageCounts=Object.fromEntries(queryRows<{page:string;n:number}>(`SELECT ${pageExpression} page,COUNT(DISTINCT e.id) n ${scope.sql} ${unread} GROUP BY ${pageExpression}`,scope.params).map(row=>[row.page,Number(row.n)]));
    const latest=queryRow<{n:number}>(`SELECT COALESCE(MAX(e.id),0) n ${scope.sql}`,scope.params)?.n??0;
    const assigned=user.role!=="admin";
    const customerIds=queryRows<{id:number}>(`SELECT id FROM customers WHERE merged_into_customer_id IS NULL ${assigned?"AND salesperson_id=?":""} ORDER BY id`,
      assigned?[user.salespersonId??-1]:[]).map(c=>c.id);
    const scopeVersion=createHash("sha256").update(JSON.stringify([user.id,user.role,user.customerScope,user.salespersonId,[...user.permissions].sort(),customerIds])).digest("hex");
    const items=queryRows<Event>(`SELECT DISTINCT ${selection} ${scope.sql} ${filter.sql} ${before?"AND e.id<?":""} ${req.query.unreadOnly==="true"?unread:""}
      ORDER BY e.id DESC LIMIT ?`,[...scope.params,...filter.params,...(before?[before]:[]),limit+1]);
    res.json({items:items.slice(0,limit).map(e=>({id:Number(e.id),kind:e.kind,title:e.title,body:e.body,
      page:notificationPages[e.resource_type as keyof typeof notificationPages]??"customers",
      customerId:Number(e.current_customer_id??e.customer_id),customerName:e.customer_name,target:target(e),createdAt:e.created_at,readAt:e.read_at})),
      pageCounts,unreadCount:Number(count),latestId:Number(latest),scopeVersion,nextCursor:items.length>limit?String(items[limit-1].id):null});
  });
  router.post("/site-notifications/read-all",(req,res)=>{
    const user=res.locals.authUser as AuthUser,through=Number(req.body?.throughId);
    const filter=pageFilter(req.body?.page);
    if(!filter||!Number.isSafeInteger(through)||through<0){res.status(400).json({error:"invalid_notification_id"});return;}
    const scope=from(user);
    const latest=queryRow<{n:number}>(`SELECT COALESCE(MAX(e.id),0) n ${scope.sql}`,scope.params)?.n??0;
    if(through>latest){res.status(400).json({error:"invalid_notification_id"});return;}
    // Store authorized event reads, not a global watermark that would acknowledge
    // other pages or customers newly assigned to this user in the future.
    crmDb.prepare(`INSERT INTO site_notification_reads(user_id,event_id,read_at)
      SELECT DISTINCT ?,e.id,? ${scope.sql} ${filter.sql} AND e.id<=?
      ON CONFLICT(user_id,event_id) DO NOTHING`)
      .run(user.id,new Date().toISOString(),...scope.params,...filter.params,through);
    res.json({ok:true});
  });
  router.post("/site-notifications/:id/read",(req,res)=>{
    const id=Number(req.params.id),user=res.locals.authUser as AuthUser,scope=from(user);
    if(!Number.isSafeInteger(id)||id<1){res.status(400).json({error:"invalid_notification_id"});return;}
    const event=queryRow<Event>(`SELECT ${selection} ${scope.sql} AND e.id=?`,[...scope.params,id]);
    if(!event){res.status(404).json({error:"notification_not_found",message:"این اعلان دیگر در دسترس شما نیست."});return;}
    crmDb.prepare("INSERT INTO site_notification_reads(user_id,event_id,read_at) VALUES(?,?,?) ON CONFLICT(user_id,event_id) DO NOTHING")
      .run(user.id,id,new Date().toISOString());
    res.json({ok:true,target:target(event)});
  });
  return router;
}
