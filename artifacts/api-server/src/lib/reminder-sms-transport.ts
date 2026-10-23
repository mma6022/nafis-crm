import { createHmac } from "node:crypto";

export const EXPERT_REMINDER_PATTERN = "2nuz0inzh8ywd36";
type TransportOptions = {
  enabled: boolean; relayUrl: string; fromNumber: string; secret?: string;
  fetcher?: typeof fetch;
};
export async function sendReminderPattern(recipient: string, name: string, options: TransportOptions): Promise<string> {
  if (!options.enabled) throw new Error("sms_disabled");
  if (!options.secret) throw new Error("sms_relay_not_configured");
  let relay: URL;
  try {
    relay = new URL(options.relayUrl);
    if (!["http:","https:"].includes(relay.protocol) || relay.username || relay.password ||
        !["localhost","127.0.0.1","::1","[::1]"].includes(relay.hostname)) throw new Error();
  } catch { throw new Error("sms_relay_not_configured"); }
  const body = JSON.stringify({
    sending_type:"pattern",from_number:options.fromNumber,
    code:EXPERT_REMINDER_PATTERN,recipients:[recipient],params:{name:name.trim().slice(0,80)},
  });
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = createHmac("sha256",options.secret).update(`${timestamp}.${body}`).digest("hex");
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(relay,{method:"POST",body,signal:AbortSignal.timeout(30_000),
      headers:{"Content-Type":"application/json","X-Relay-Timestamp":timestamp,"X-Relay-Signature":signature}});
  } catch { throw new Error("sms_delivery_unknown"); }
  let result: {ok?:boolean;error?:string;data?:{meta?:{status?:boolean};data?:{message_outbox_ids?:unknown[]}}};
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed!=="object") throw new Error();
    result=parsed as typeof result;
  } catch { throw new Error("sms_delivery_unknown"); }
  if (result.data?.meta?.status===false || ["provider_rejected","invalid_payload","invalid_signature","expired_signature"].includes(result.error ?? "")) {
    throw new Error("sms_provider_rejected");
  }
  const id=result.data?.data?.message_outbox_ids?.[0];
  if (!response.ok || result.ok!==true || result.data?.meta?.status!==true || !/^[1-9]\d*$/.test(String(id))) {
    throw new Error("sms_delivery_unknown");
  }
  return String(id);
}
