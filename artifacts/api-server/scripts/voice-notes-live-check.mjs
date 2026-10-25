// crm-voice-notes live check (deploy-time). Uses the SAME production code path (readSttConfig, plan vocabulary,
// keyterms/prompt, transcribe) against one SYNTHETIC clip. Never prints keys; prints only names/booleans + transcript.
//
//   (set -a; . /etc/nafisvam/crm.env; set +a; VN_CHECK_AUDIO=/tmp/vn-synthetic.mp3 VN_CHECK_DB=/path/customers.db \
//      VN_CHECK_BASE=https://crm.nafisvam.com VN_CHECK_FALLBACK=1 node voice-notes-live-check.bundle.mjs)
//
// VN_CHECK_DB is opened READ-ONLY (plan names only). VN_CHECK_BASE adds two logged-out HTTP probes:
// GET /api/voice-notes/config → 401 (global auth gate) or {enabled:false}; POST /api/voice-notes/transcribe → 401 when STT_ENABLED is on (404 when off).
// Exit code 0 only if every requested check passes.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readSttConfig, fallbackSttConfig, readPlanVocab, keyterms, transcribe } from "../src/lib/voice-notes-core";

const env = process.env;
const fail = []; const say = (...a) => console.log(...a);
const cfg = readSttConfig(env);
say(`config: enabled=${cfg.enabled} provider=${cfg.provider} model=${cfg.model} hasKey=${cfg.hasKey} fallback=${cfg.fallback} dailyLimitMin=${cfg.dailyLimitSeconds / 60}`);
if (env.VN_CHECK_EXPECT_ENABLED === "1" && !cfg.enabled) fail.push("STT_ENABLED is not on");
if (env.VN_CHECK_EXPECT_PROVIDER && cfg.provider !== env.VN_CHECK_EXPECT_PROVIDER) fail.push(`provider is ${cfg.provider}`);
if (!cfg.hasKey) fail.push(`no key for ${cfg.provider}`);

let vocab = { active: [], inactive: [] };
if (env.VN_CHECK_DB) {
  const db = new DatabaseSync(env.VN_CHECK_DB, { readOnly: true });
  try { vocab = readPlanVocab(db); } finally { db.close(); }
}
const kt = keyterms(vocab.active, vocab.inactive);
say(`vocabulary: activePlans=${vocab.active.length} inactivePlans=${vocab.inactive.length} keyterms=${kt.length} first=${kt.slice(0, 6).join("|")}`);

const audioPath = env.VN_CHECK_AUDIO;
if (audioPath) {
  const audio = new Uint8Array(readFileSync(audioPath));
  const mime = audioPath.endsWith(".mp3") ? "audio/mpeg" : audioPath.endsWith(".m4a") ? "audio/mp4" : "audio/webm";
  const runs = [["primary", cfg]];
  if (env.VN_CHECK_FALLBACK === "1" && cfg.fallback) runs.push(["fallback", fallbackSttConfig(env)]);
  for (const [label, c] of runs) {
    const t0 = Date.now();
    try {
      const r = await transcribe(c, env, { audio, mime, plans: vocab.active, inactivePlans: vocab.inactive }, (u, i) => fetch(u, i));
      say(`${label} ${c.provider}/${c.model}: ok ${((Date.now() - t0) / 1000).toFixed(2)}s duration=${r.durationSec ?? "-"} text: ${r.text}`);
      if (!r.text) fail.push(`${label}: empty text`);
    } catch (e) {
      say(`${label} ${c.provider}/${c.model}: FAILED code=${e?.code ?? e?.name}`); fail.push(`${label} failed`);
    }
  }
}

if (env.VN_CHECK_BASE) {
  const base = env.VN_CHECK_BASE.replace(/\/+$/, "");
  const g = await fetch(`${base}/api/voice-notes/config`).then(async (r) => [r.status, await r.json().catch(() => null)]).catch((e) => [0, String(e)]);
  say(`http: GET /api/voice-notes/config (logged out) → ${g[0]} ${JSON.stringify(g[1])}`);
  // Production has a global auth gate in front of /api/* (unknown paths are 401 logged out too), so 401 is the
  // expected live answer; 200 {enabled:false} is what the router itself returns when reached without a session.
  if (!(g[0] === 401 || (g[0] === 200 && g[1]?.enabled === false))) fail.push("config probe");
  const p = await fetch(`${base}/api/voice-notes/transcribe?duration=1`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(10) }).then((r) => r.status).catch(() => 0);
  const want = cfg.enabled ? 401 : 404;
  say(`http: POST /api/voice-notes/transcribe (logged out) → ${p} (expect ${want}: ${cfg.enabled ? "route live, auth enforced" : "flag off"})`);
  if (p !== want) fail.push("transcribe probe");
}
say(fail.length ? `RESULT: FAIL — ${fail.join("; ")}` : "RESULT: PASS");
process.exitCode = fail.length ? 1 : 0;
