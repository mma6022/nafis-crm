import { createHash } from "node:crypto";
import { crmDb, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { eventFor, experts, customerMatcher, normalizePhone, resolveEvent, finishSavedLiveReport, ensureAfterCallSchema } from "./voip-after-call";
import { notifyCallReport } from "./voip-call-notifications";

type Signal = { cuid:string; phone:string; direction:string };
function text(value:unknown,max=128) {
  return (typeof value==="string" || typeof value==="number") ? String(value).trim().slice(0,max) : "";
}
function identifier(body:Record<string,unknown>) {
  const value=text(body.unique_id ?? body.cuid).replace(/\s+/g,"");
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value)?value:null;
}
export function ensureCallSignalSchema() {
  ensureAfterCallSchema();
  crmDb.exec(`CREATE TABLE IF NOT EXISTS simotel_call_signals(cuid TEXT NOT NULL,phone TEXT NOT NULL,direction TEXT NOT NULL,
    received_at TEXT NOT NULL,PRIMARY KEY(cuid,phone,direction));
    CREATE TABLE IF NOT EXISTS simotel_extension_signals(cuid TEXT NOT NULL,extension TEXT NOT NULL,state TEXT NOT NULL,
    participant TEXT,direction TEXT,dialer TEXT,received_at TEXT NOT NULL,PRIMARY KEY(cuid,extension));`);
  if(!queryRows<{name:string}>("PRAGMA table_info(simotel_extension_signals)").some(c=>c.name==="dialer"))crmDb.exec("ALTER TABLE simotel_extension_signals ADD COLUMN dialer TEXT");
}
function markLive(body:Record<string,unknown>,now:Date) {
  const cuid=identifier(body), extension=text(body.exten,6), state=text(body.state).toLowerCase().replace(/\s/g,"");
  if(!cuid || !/^[A-Za-z0-9*#_.-]{1,6}$/.test(extension)) return false;
  const available=experts().filter(e=>e.extension===extension);
  if(available.length!==1) return false; // Never choose another agent for an unassigned/ambiguous extension.
  if(["idle","unavailable","pause"].includes(state)) {
    for(const row of queryRows<{id:number}>("SELECT id FROM voip_after_call_events WHERE live_cuid=? AND extension=? AND is_live=1",[cuid,extension])) {
      executeChanges("UPDATE voip_after_call_events SET is_live=0,ended_at=?,status=CASE WHEN status='ACTIVE' THEN 'ANSWERED' ELSE 'NO ANSWER' END WHERE id=?",[now.toISOString(),row.id]);
      finishSavedLiveReport(row.id);
    }
    executeChanges("DELETE FROM simotel_extension_signals WHERE cuid=? AND extension=?",[cuid,extension]);
    return true;
  }
  if(!["ringing","inuse"].includes(state))return false;
  let phone=text(body.participant), direction=body.direction==="in"?"incoming":body.direction==="out"?"outgoing":null;
  const signals=queryRows<Signal>("SELECT cuid,phone,direction FROM simotel_call_signals WHERE cuid=? AND julianday(received_at)>julianday(?)-2.0/24",[cuid,now.toISOString()]);
  const compatible=signals.filter(s=>(!direction||s.direction===direction)&&(!phone||normalizePhone(s.phone)===normalizePhone(phone)));
  if(!phone || !direction) {
    if(compatible.length!==1)return false;
    phone=phone||compatible[0].phone;direction=direction||compatible[0].direction;
  }
  phone=normalizePhone(phone)??phone;
  if(!/^\+?\d{7,18}$/.test(phone) || !direction)return false; // Internal-to-internal ringing isn't a customer call.
  const external="live-"+createHash("sha256").update([cuid,extension,phone,direction].join("|")).digest("hex").slice(0,40);
  const previous=queryRow<{id:number;is_live:number;status:string}>(
    "SELECT id,is_live,status FROM voip_after_call_events WHERE external_id=? OR (live_cuid=? AND extension=? AND phone=? AND direction=?) ORDER BY id DESC LIMIT 1",
    [external,cuid,extension,phone,direction]);
  if(previous && !previous.is_live)return true; // Late/duplicate start events cannot resurrect ended calls.
  const nextStatus=state==="ringing" || body.dialer==="yes" ? "RINGING" : "ACTIVE";
  if(previous) executeChanges("UPDATE voip_after_call_events SET status=CASE WHEN status='ACTIVE' THEN status ELSE ? END WHERE id=?",[nextStatus,previous.id]);
  else executeChanges(`INSERT OR IGNORE INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,
    extensions_json,has_recording,is_live,live_cuid,auto_capture) VALUES(?,?,?,?,?,?,?,?,0,1,?,1)`,
    [external,phone,direction,nextStatus,now.toISOString(),now.toISOString(),extension,JSON.stringify([extension]),cuid]);
  const selected=queryRow<{id:number}>("SELECT id FROM voip_after_call_events WHERE external_id=?",[external]);
  if(selected)resolveEvent(selected.id,experts(),customerMatcher());
  return true;
}
export function receiveSimotelCallEvent(payload:unknown,now=new Date()) {
  if(!payload || typeof payload!=="object" || Array.isArray(payload))throw new Error("invalid_event");
  const body=payload as Record<string,unknown>;
  const name=text(body.event_name).toLowerCase().replace(/[\s_-]/g,"");
  if(!["incomingcall","outgoingcall","newstate","cdr"].includes(name))return {handled:false,cdr:false};
  ensureCallSignalSchema();
  const cuid=identifier(body);
  if(!cuid && name!=="cdr")throw new Error("invalid_event");
  let handled=false,liveHandled=false;
  runTransaction(()=>{
    if(name==="incomingcall" || name==="outgoingcall") {
      const raw=text(body.number),phone=normalizePhone(raw)??raw;
      if(!/^\+?\d{3,18}$/.test(phone))throw new Error("invalid_event");
      const direction=name==="incomingcall"?"incoming":"outgoing";
      executeChanges(`INSERT INTO simotel_call_signals(cuid,phone,direction,received_at) VALUES(?,?,?,?)
        ON CONFLICT(cuid,phone,direction) DO UPDATE SET received_at=excluded.received_at`,[cuid,phone,direction,now.toISOString()]);
      // Trunk and extension callbacks can arrive in either order.
      for(const waiting of queryRows<{extension:string;state:string;participant:string|null;direction:string|null;dialer:string|null;received_at:string}>(
        "SELECT * FROM simotel_extension_signals WHERE cuid=?",[cuid])) {
        liveHandled=markLive({unique_id:cuid,exten:waiting.extension,state:waiting.state,participant:waiting.participant,direction:waiting.direction,dialer:waiting.dialer},new Date(waiting.received_at))||liveHandled;
      }
      handled=true;
    } else if(name==="newstate") {
      const extension=text(body.exten,6),state=text(body.state);
      if(!/^[A-Za-z0-9*#_.-]{1,6}$/.test(extension)||!state)throw new Error("invalid_event");
      if(["ringing","inuse"].includes(state.toLowerCase().replace(/\s/g,""))) executeChanges(`INSERT INTO simotel_extension_signals(cuid,extension,state,participant,direction,dialer,received_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(cuid,extension) DO UPDATE SET state=excluded.state,
        participant=excluded.participant,direction=excluded.direction,dialer=excluded.dialer`,
        [cuid,extension,state,text(body.participant)||null,text(body.direction)||null,text(body.dialer)||null,now.toISOString()]);
      handled=markLive(body,now);
      liveHandled=handled;
    } else handled=true;
    if(liveHandled)executeChanges("UPDATE voip_call_reporting_state SET live_event_seen_at=? WHERE id=1",[now.toISOString()]);
    executeChanges("DELETE FROM simotel_call_signals WHERE julianday(received_at)<julianday(?)-2",[now.toISOString()]);
    executeChanges("DELETE FROM simotel_extension_signals WHERE julianday(received_at)<julianday(?)-2",[now.toISOString()]);
  });
  // Event packets contain no customer information; viewers must reauthorize GET.
  notifyCallReport(null);
  return {handled,cdr:name==="cdr"};
}
