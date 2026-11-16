import { validateChatFile } from "./chat-storage";
export function validateInternalChatFile(file: Express.Multer.File) {
  try { return validateChatFile(file); } catch { /* additional common, download-only documents */ }
  const b=file.buffer,mime=file.mimetype.split(";")[0],name=file.originalname.toLowerCase();
  const zip=b[0]===0x50&&b[1]===0x4b&&b[2]===3&&b[3]===4;
  if (zip && name.endsWith(".xlsx") && b.includes(Buffer.from("xl/workbook.xml"))) return {mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",kind:"file"};
  if (zip && name.endsWith(".pptx") && b.includes(Buffer.from("ppt/presentation.xml"))) return {mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",kind:"file"};
  if (zip && name.endsWith(".zip") && ["application/zip","application/x-zip-compressed","application/octet-stream"].includes(mime)) return {mime:"application/zip",kind:"file"};
  if (b.length && b.length<=20*1024*1024 && !b.includes(0) && /\.(txt|csv)$/.test(name) && ["text/plain","text/csv","application/csv","application/octet-stream"].includes(mime)) {
    try { new TextDecoder("utf-8",{fatal:true}).decode(b); return {mime:name.endsWith(".csv")?"text/csv":"text/plain",kind:"file"}; } catch { /* invalid UTF-8 */ }
  }
  if (mime==="video/mp4" && b.toString("ascii",4,8)==="ftyp") return {mime,kind:"video"};
  throw Object.assign(new Error("نوع یا محتوای فایل پشتیبانی نمی‌شود؛ تصویر، PDF، Word، Excel، PowerPoint، متن، ZIP، ویدیو MP4 یا صوت ارسال کنید."),{status:400});
}
