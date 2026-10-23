import fs from "node:fs/promises";
import path from "node:path";

export const SPEECH_MODEL = "gpt-transcribe";
export const SPEAKER_MODEL = "gpt-4o-transcribe-diarize";
export class TranscriptionError extends Error {}

const persianPrompt = "مکالمهٔ تلفنی فارسی ایرانی است. گفتار را عیناً به فارسی پیاده کن؛ ترجمه، خلاصه، پاسخ یا تکمیل جملهٔ نامفهوم نکن. واژگان احتمالی: نفیس، وام، اعتبارسنجی، اقساط، ضامن، چک، سفته، تومان. فقط واژه‌ها و اعداد واقعاً شنیده‌شده را بنویس و بخش نامفهوم را حدس نزن.";

export async function speechRequest(file: string, fields: Record<string, string>): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new TranscriptionError("کلید سرویس تبدیل گفتار روی سرور تنظیم نشده است.");
  const form = new FormData();
  const type = file.endsWith(".flac") ? "audio/flac" : file.endsWith(".mp3") ? "audio/mpeg" : "audio/mp4";
  form.append("file", new Blob([await fs.readFile(file)], { type }), path.basename(file));
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
      redirect: "error", signal: AbortSignal.timeout(12 * 60 * 1000),
    });
  } catch { throw new TranscriptionError("ارتباط با سرویس تبدیل گفتار قطع شد؛ دوباره تلاش کنید."); }
  const reader = response.body?.getReader();
  if (!reader) throw new TranscriptionError("پاسخ سرویس تبدیل گفتار خالی است.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > (response.ok ? 8 * 1024 * 1024 : 65536)) {
      await reader.cancel();
      throw new TranscriptionError("پاسخ سرویس تبدیل گفتار بیش از حد بزرگ است.");
    }
    chunks.push(value);
  }
  let data: any;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TranscriptionError("پاسخ سرویس تبدیل گفتار معتبر نیست."); }
  if (!response.ok) {
    if (response.status === 429 && (data?.error?.type === "insufficient_quota" || data?.error?.code === "credit_balance_exhausted"))
      throw new TranscriptionError("اعتبار حساب OpenAI تمام شده است؛ مدیر باید حساب سرویس را شارژ کند، سپس تبدیل را دوباره انجام دهید.");
    throw new TranscriptionError(response.status === 429 ? "سقف استفادهٔ سرویس تبدیل گفتار کافی نیست؛ بعداً دوباره تلاش کنید."
      : [401, 403].includes(response.status) ? "سرویس تبدیل گفتار دسترسی کلید API را نپذیرفت."
      : "سرویس تبدیل گفتار درخواست را انجام نداد؛ دوباره تلاش کنید.");
  }
  return data;
}

export function validateSpeechText(value: unknown): string {
  const text = (value as { text?: unknown })?.text;
  if (typeof text !== "string" || text.length > 300000) throw new TranscriptionError("متن برگشتی از سرویس تبدیل معتبر نیست.");
  const words = text.trim().split(/\s+/);
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 15) throw new TranscriptionError("سرویس متن تکراری و غیرقابل‌اعتماد برگرداند؛ این نتیجه ذخیره نمی‌شود. تبدیل را دوباره انجام دهید.");
  }
  const tokens = words.map(x => x.replace(/[.,،؛:!?؟]/g, ""));
  for (let width = 2; width <= 8; width++) {
    let repetitions = 1;
    for (let i = width; i < tokens.length; i++) {
      repetitions = tokens[i] === tokens[i - width] ? repetitions + 1 : 1;
      if (repetitions >= width * 6) {
        throw new TranscriptionError("سرویس عبارت‌های تکراری و غیرقابل‌اعتماد برگرداند؛ این نتیجه ذخیره نمی‌شود. تبدیل را دوباره انجام دهید.");
      }
    }
  }
  return text.trim();
}

export async function accurateSpeech(file: string) {
  // A transcript from another interval is not acoustic evidence. Feeding a
  // flawed whole-call transcript into every short turn propagates its errors.
  const prompt = persianPrompt;
  return validateSpeechText(await speechRequest(file, {
    model: SPEECH_MODEL, "languages[]": "fa", response_format: "json", temperature: "0", prompt,
  }));
}