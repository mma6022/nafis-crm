/**
 * Recording download UI: the «دانلود فایل صوتی» control sits next to every
 * existing player, has a 40px tap target at 390, and shows a short message
 * when there is no stored file. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const css = read("src/components/voip/RecordingDownloadButton.css");
const btn = read("src/components/voip/RecordingDownloadButton.tsx");
const report = read("src/components/voip/CallReportDialog.tsx");
const popup = read("src/components/voip/AfterCallPopup.tsx");
const history = read("src/components/CallHistory.tsx");
const vc = read("src/features/voip-call/VoipCall.tsx");
const callView = read("src/features/call-transcripts/CallView.tsx");
const chat = read("src/features/call-transcripts/ChatTranscript.tsx");
const panel = read("src/components/RecordedCallsPanel.tsx");

let n = 0;
const ok = (name, cond) => { if (!cond) { console.error("FAIL -", name); process.exitCode = 1; return; } n++; console.log("ok -", name); };

ok("button label is «دانلود فایل صوتی»",
  btn.includes("دانلود فایل صوتی") && btn.includes("aria-label=\"دانلود فایل صوتی\""));
ok("40px+ tap target, including at 390",
  /min-height:\s*40px/.test(css) && /min-width:\s*40px/.test(css)
  && /@media \(max-width:\s*390px\)[\s\S]{0,180}min-height:\s*40px/.test(css));
ok("missing file shows a short Persian message, not a broken href",
  btn.includes("فایل صوتی این تماس ذخیره نشده است.") && btn.includes("missing")
  && !btn.includes("href={undefined}"));
ok("download URL is /download and does not require a transcript",
  btn.includes("/api/voip/recordings/") && btn.includes("/download?")
  && btn.includes("/api/voip-call/calls/") && btn.includes("/download")
  && !btn.includes("transcript") && !btn.includes("textState"));

ok("after-call / report dialog has the button next to the player",
  report.includes("RecordingDownloadButton") && report.includes("audio-report")
  && report.includes("button-report-download") && report.includes("simotelRecordingDownloadUrl"));
ok("after-call popup reuses the report editor (same player + download)",
  popup.includes("CallReportEditor"));
ok("customer call history (timeline) uses the VoIP player + download",
  history.includes("CallReportDialog") && vc.includes("RecordingDownloadButton")
  && vc.includes("voipCallRecordingDownloadUrl") && vc.includes("VcPlayer")
  && vc.includes("button-vc-download"));
ok("transcript CallView and chat view have the button next to the player",
  callView.includes("button-ct-download") && callView.includes("ct-player")
  && chat.includes("button-ct-chat-download") && chat.includes("ct-player")
  && callView.includes("simotelRecordingDownloadUrl") && chat.includes("simotelRecordingDownloadUrl"));
ok("recorded-calls panel uses the same button and missing message",
  panel.includes("RecordingDownloadButton") && panel.includes("button-rc-download-")
  && panel.includes("simotelRecordingDownloadUrl"));
ok("missing-file message is used in the report dialog and transcript/history when there is no file",
  report.includes("missing") && (callView.includes("button-ct-download-missing") || callView.includes("missing"))
  && vc.includes("button-vc-download-missing"));

if (!process.exitCode) console.log(`PASS ${n}/10 recording-download-ui`);
