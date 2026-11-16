import type { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { VPS_CHAT_PREFIX, saveVpsChatObject, readVpsChatObject, deleteVpsChatObject } from "./chat-vps-storage";
const endpoint = "http://127.0.0.1:1106";
let storage: Storage | undefined;
async function managedStorage() {
  // Existing GCS references are never rewritten or interpreted as local files.
  // External hosts need their own authorized ADC file, not an exported runtime token.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.REPL_ID) {
    throw new Error("chat_managed_credentials_not_configured");
  }
  // The private VPS adapter must start without the optional managed SDK.
  const { Storage } = await import("@google-cloud/storage");
  return storage ??= new Storage(process.env.GOOGLE_APPLICATION_CREDENTIALS ? {} : {
  projectId: "", credentials: { audience:"replit",subject_token_type:"access_token",
    token_url:`${endpoint}/token`,type:"external_account",universe_domain:"googleapis.com",
    credential_source:{url:`${endpoint}/credential`,format:{type:"json",subject_token_field_name:"access_token"}} },
  });
}
function backend() {
  const selected = process.env.CHAT_STORAGE_BACKEND ?? (process.env.REPL_ID ? "managed" : "");
  if (selected !== "managed" && selected !== "vps-private") throw new Error("chat_storage_not_configured");
  return selected;
}
async function object(path: string) {
  const parts = path.replace(/^\/+/,"").split("/");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(parts[0] ?? "") || parts.length<2 ||
      parts.some(p => !p || p === "." || p === ".." || /[\\\u0000-\u001f]/.test(p))) throw new Error("invalid_private_object");
  return (await managedStorage()).bucket(parts.shift()!).file(parts.join("/"));
}
export async function saveChatObject(bytes: Buffer, mime: string) {
  if (backend() === "vps-private") return saveVpsChatObject(bytes);
  const root = process.env.PRIVATE_OBJECT_DIR;
  if (!root) throw new Error("chat_storage_not_configured");
  const path = `${root.replace(/\/$/,"")}/customer-chat/${randomUUID()}`;
  await (await object(path)).save(bytes,{resumable:false,metadata:{contentType:mime}});
  return path;
}
export function readChatObject(path: string) {
  if (path.startsWith(VPS_CHAT_PREFIX)) return readVpsChatObject(path);
  return Readable.from((async function* () {
    for await (const chunk of (await object(path)).createReadStream()) yield chunk;
  })());
}
export const deleteChatObject = async (path:string) => path.startsWith(VPS_CHAT_PREFIX)
  ? deleteVpsChatObject(path) : (await object(path)).delete({ignoreNotFound:true});
export function validateChatFile(file: Express.Multer.File) {
  const b=file.buffer,m=file.mimetype;
  const mime = m.split(";")[0];
  const png = mime==="image/png" && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = mime==="image/jpeg" && b[0]===255 && b[1]===216 && b[2]===255;
  const webp = mime==="image/webp" && b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WEBP";
  const pdf = mime==="application/pdf" && b.toString("ascii",0,5)==="%PDF-";
  const webm = ["audio/webm","video/webm"].includes(mime) && b.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  const ogg = mime==="audio/ogg" && b.toString("ascii",0,4)==="OggS";
  const wav = ["audio/wav","audio/x-wav"].includes(mime) && b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WAVE";
  const mp3 = mime==="audio/mpeg" && (b.toString("ascii",0,3)==="ID3" || (b[0]===255 && (b[1]&224)===224));
  const mp4 = ["audio/mp4","audio/x-m4a"].includes(mime) && b.toString("ascii",4,8)==="ftyp";
  const docx = mime==="application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
    b.toString("ascii",0,2)==="PK" && b.includes(Buffer.from("word/document.xml"));
  if (!b.length || !(png||jpeg||webp||pdf||webm||ogg||wav||mp3||mp4||docx)) throw new Error("unsupported_chat_file");
  return {mime: webm ? "audio/webm" : mime,
    kind: png||jpeg||webp ? "image" : webm||ogg||wav||mp3||mp4 ? "audio" : "file"};
}
