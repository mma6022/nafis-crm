import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VoipTranscriptSegment, VoipTranscriptSpeaker } from "@workspace/api-zod";
import { accurateSpeech, speechRequest, SPEECH_MODEL, SPEAKER_MODEL, TranscriptionError } from "./recording-speech-provider";
import { joinSpeechWindows, speechWindows } from "./recording-speech-windows";
export { TranscriptionError, validateSpeechText } from "./recording-speech-provider";

const run = promisify(execFile);
export const TRANSCRIPTION_MODEL = SPEECH_MODEL;
const formats = "wav,mp3,ogg,flac,mov,matroska,webm,gsm,amr,aac";
const safeInput = ["-protocol_whitelist", "file,pipe", "-format_whitelist", formats];
export function speechConfigured() { return !!process.env.OPENAI_API_KEY; }
async function media(command: string, args: string[], binary = false) {
  try {
    return await run(command, args, { timeout: 180000, maxBuffer: binary ? 10*1024*1024 : 1024*1024,
      encoding: binary ? "buffer" : "utf8", windowsHide: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TranscriptionError("ابزار پردازش صدا روی سرور نصب نشده است.");
    throw new TranscriptionError("فایل صوتی قابل پردازش نیست یا پردازش صدا بیش از حد طول کشید.");
  }
}
export async function probeRecording(file: string) {
  const result = await media("ffprobe", ["-v","error",...safeInput,"-show_entries","format=duration:stream=codec_type,channels","-of","json",file]);
  const info = JSON.parse(String(result.stdout));
  const streams = info.streams?.filter((x: {codec_type?:string}) => x.codec_type === "audio") ?? [];
  const duration = Number(info.format?.duration), channels = Number(streams[0]?.channels);
  if (streams.length !== 1 || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(channels) || channels < 1) {
    throw new TranscriptionError("ساختار یا مدت فایل صوتی معتبر نیست.");
  }
  if (duration > 5400) throw new TranscriptionError("این پردازش حداکثر ضبط ۹۰ دقیقه‌ای را پشتیبانی می‌کند؛ فایل بلندتر باید تقسیم شود.");
  return {duration, channels};
}
export async function hasIndependentChannels(file: string, channels: number) {
  if (channels !== 2) return false;
  const result = await media("ffmpeg", ["-v","error","-nostdin","-threads","1",...safeInput,"-i",file,
    "-t","120","-map","0:a:0","-ac","2","-ar","8000","-f","f32le","pipe:1"],true);
  const pcm = result.stdout as Buffer;
  let left = 0, right = 0, difference = 0;
  for (let offset = 0; offset+8 <= pcm.length; offset += 8) {
    const a = pcm.readFloatLE(offset), b = pcm.readFloatLE(offset+4);
    left += a*a; right += b*b; difference += (a-b)*(a-b);
  }
  const samples = pcm.length/8;
  return samples > 0 && left/samples > 1e-8 && right/samples > 1e-8 && difference/(left+right) > 0.015;
}
export async function cleanRecording(input: string, output: string, channel?: number) {
  const filter = [channel == null ? null : `pan=mono|c0=c${channel}`,
    "aresample=16000", "highpass=f=50", "afftdn=nr=3:tn=1"]
    .filter(Boolean).join(",");
  await media("ffmpeg", ["-v","error","-nostdin","-y","-threads","1","-filter_threads","1",...safeInput,
    "-i",input,"-map","0:a:0","-vn","-af",filter,"-ac","1","-ar","16000","-c:a","flac","-compression_level","5",output]);
  if ((await fs.stat(output)).size > 24*1024*1024) throw new TranscriptionError("حجم صدای آماده‌شده بیشتر از ظرفیت سرویس تبدیل است.");
}
async function originalSpeechTrack(input: string, output: string, channel?: number) {
  const filters = [channel == null ? null : `pan=mono|c0=c${channel}`, "aresample=16000"].filter(Boolean).join(",");
  await media("ffmpeg", ["-v","error","-nostdin","-y","-threads","1","-filter_threads","1",...safeInput,
    "-i",input,"-map","0:a:0","-vn","-af",filters,"-ac","1","-ar","16000","-c:a","flac","-compression_level","5",output]);
}
async function completeSpeech(file: string, directory: string, channel: number, duration: number) {
  const detection = await media("ffmpeg", ["-v","info","-nostdin","-threads","1",...safeInput,
    "-i",file,"-af","silencedetect=noise=-40dB:d=0.4","-f","null","-"]);
  const pauses = [...String(detection.stderr).matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)]
    .map(x => Number(x[1]) - Number(x[2]) / 2);
  const windows = speechWindows(duration, pauses);
  const texts: string[] = [];
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index];
    const clip = path.join(directory, `full-${channel}-${index}.flac`);
    const start = Math.max(0, window.start - 0.35), end = Math.min(duration, window.end + 0.35);
    try {
      await media("ffmpeg", ["-v","error","-nostdin","-y","-threads","1",...safeInput,
        "-i",file,"-ss",String(start),"-t",String(end-start),"-ac","1","-c:a","flac",clip]);
      if ((await fs.stat(clip)).size > 24*1024*1024) throw new TranscriptionError("حجم قطعهٔ صوت بیشتر از ظرفیت سرویس تبدیل است.");
      texts.push(await accurateSpeech(clip));
    } finally { await fs.rm(clip, {force:true}); }
  }
  return joinSpeechWindows(texts);
}
type RawSegment = {speaker:string;start:number;end:number;text:string};
export function validateDiarizedResponse(data: unknown, duration: number): RawSegment[] {
  const value = data as {text?:unknown;segments?:unknown};
  if (!value || typeof value.text !== "string" || !Array.isArray(value.segments) || value.segments.length > 20000) {
    throw new TranscriptionError("سرویس تبدیل متنِ همراه با تفکیک گویندگان برنگرداند.");
  }
  const segments = value.segments.map(x => {
    if (!x || typeof x !== "object" || typeof x.speaker !== "string" || !x.speaker || x.speaker.length > 128
      || typeof x.text !== "string" || x.text.length > 20000 || !Number.isFinite(x.start)
      || !Number.isFinite(x.end) || x.start < 0 || x.end < x.start || x.end > duration+3) {
      throw new TranscriptionError("زمان‌بندی یا تفکیک گویندگان در پاسخ سرویس معتبر نیست.");
    }
    return {speaker:x.speaker,start:x.start,end:Math.min(x.end,duration),text:x.text.trim()} as RawSegment;
  }).filter(x => x.text);
  if (value.text.trim() && !segments.length) throw new TranscriptionError("سرویس متن را بدون قطعه‌بندی گویندگان برگرداند.");
  return segments;
}
async function diarize(file: string, duration: number) {
  const data = await speechRequest(file, {
    model: SPEAKER_MODEL, response_format: "diarized_json", chunking_strategy: "auto", language: "fa",
  });
  return validateDiarizedResponse(data,duration);
}
export async function transcribeRecording(input: string, directory: string, phase: (value:"cleaning"|"transcribing")=>void) {
  phase("cleaning");
  const {duration,channels}=await probeRecording(input);
  const independent=await hasIndependentChannels(input,channels);
  const files=independent?[path.join(directory,"left.flac"),path.join(directory,"right.flac")]:[path.join(directory,"clean.flac")];
  for(let i=0;i<files.length;i++)await cleanRecording(input,files[i],independent?i:undefined);
  const originals = files.map((_, i) => path.join(directory, `original-${i}.flac`));
  for(let i=0;i<originals.length;i++)await originalSpeechTrack(input,originals[i],independent?i:undefined);
  phase("transcribing");
  const utterances:Array<RawSegment & {key:string}>=[];
  const references: Array<{ channel: number; text: string }> = [];
  for(let i=0;i<files.length;i++){
    // Recognize the entire channel with the accurate model before identifying
    // speakers. Never use the diarizer's unreliable words as the final text.
    // Clear telephone speech must not lose quiet consonants to denoising.
    // Use the minimally processed original for the authoritative transcript;
    // retain the cleaned track for speaker detection only.
    const reference = await completeSpeech(originals[i], directory, i, duration);
    if (!reference) continue;
    references.push({ channel: i, text: reference });
    const results=await diarize(files[i],duration);
    if (reference && !results.length) throw new TranscriptionError("متن تشخیص داده شد، ولی زمان‌بندی گویندگان قابل اعتماد نبود؛ تبدیل را دوباره انجام دهید.");
    const pieces: RawSegment[] = [];
    for (const segment of results) {
      for (let start = segment.start; start < segment.end; start += 45) {
        pieces.push({ ...segment, start, end: Math.min(start + 45, segment.end) });
      }
    }
    // Bound provider concurrency; clips retain genuine audio timestamps.
    let next = 0;
    const corrections = await Promise.allSettled(Array.from({ length: Math.min(2, pieces.length) }, async () => {
      while (next < pieces.length) {
        const index = next++, segment = pieces[index];
        const clip = path.join(directory, `turn-${i}-${index}.flac`);
        const start = Math.max(0, segment.start - 0.35);
        const end = Math.min(duration, segment.end + 0.35);
        await media("ffmpeg", ["-v", "error", "-nostdin", "-y", "-threads", "1", ...safeInput,
          "-i", originals[i], "-ss", String(start), "-t", String(end - start), "-ac", "1", "-c:a", "flac", clip]);
        const text = await accurateSpeech(clip);
        if (text) utterances.push({ ...segment, text, key: independent ? `${i}:channel` : `${i}:${segment.speaker}` });
        await fs.rm(clip, { force: true });
      }
    }));
    const failure = corrections.find(x => x.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  utterances.sort((a,b)=>a.start-b.start||a.end-b.end);
  const keys=[...new Set(utterances.map(x=>x.key))];
  const speakers:VoipTranscriptSpeaker[]=keys.map((_,i)=>({id:`speaker-${i+1}`,label:`گوینده ${(i+1).toLocaleString("fa-IR")}`}));
  const segments:VoipTranscriptSegment[]=utterances.map(x=>({speakerId:speakers[keys.indexOf(x.key)].id,startSeconds:x.start,endSeconds:x.end,text:x.text}));
  // Never reconstruct the authoritative transcript from diarization spans:
  // speaker timing can omit or clip speech even when full-file ASR succeeds.
  const text=references.map(r=>independent
    ? `${speakers[keys.indexOf(`${r.channel}:channel`)]?.label ?? `کانال ${r.channel + 1}`}: ${r.text}`
    : r.text).join("\n");
  return {model:TRANSCRIPTION_MODEL,durationSeconds:duration,audioSeparation:independent?"stereo_channels" as const:"diarization" as const,
    notice:(independent?"دو کانال مستقل، با حفظ صدای اصلی و قطعه‌بندی در مکث‌های طبیعی تبدیل شدند. نقش مشتری یا کارشناس حدس زده نشده است."
      :"متن کامل از صدای اصلی و قطعه‌های پیوسته در مکث‌های طبیعی تهیه شده و مبناست؛ متن اشتباه قطعه‌های دیگر به مدل داده نمی‌شود. زمان‌بندی گویندگان تقریبی است و تفکیک گفتار هم‌زمان تضمین نمی‌شود.")
      + " اعداد، رتبه اعتباری و بخش‌های نامفهوم را حتماً با صدا بررسی کنید؛ متن ماشینی تأیید مالی محسوب نمی‌شود."
      + (/\.\.\.|…|\[نامفهوم\]/.test(text) ? " در این تبدیل هنوز بخش‌های نامفهوم وجود دارد؛ کامل و قطعی بودن مکالمه تأیید نشده است." : ""),
    speakers,segments,text};
}