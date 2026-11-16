#!/usr/bin/env python3
"""call-transcripts v1.1 — one-time, throttled backfill of recorded calls whose transcript is missing/failed,
plus completed transcripts that have no summary. DRY-RUN by default (read-only DB, prints count / minutes / cost).

  python3 ct-backfill.py --db /path/crm.db                          # dry-run (default)
  python3 ct-backfill.py --db /path/crm.db --apply --cap-usd 2.00   # queue jobs (needs flag.call_transcripts.auto=1)

Only queues rows (requested_by=0 = system); the running API worker does the work. Never calls Simotel/OpenAI itself.
Hard cap: refuses to start when the upper-bound estimate exceeds --cap-usd and stops queueing once the running
upper bound would cross it. Throttle: at most --max-pending system jobs queued/processing at a time (default 2).
Never prints phone numbers or customer names.
"""
import argparse, datetime as dt, hashlib, json, os, sqlite3, sys, time

COST_MONO = 0.015      # USD per audio minute (full ASR + diarize + per-turn ASR), see research t730u
COST_STEREO = 0.030    # upper bound when both channels are processed separately
COST_SUMMARY = 0.002   # one gpt-4.1-mini call per summary (upper bound)
TEHRAN = dt.timezone(dt.timedelta(hours=3, minutes=30))

def tday(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TEHRAN).strftime("%Y-%m-%d")

def digest(file, text):  # must equal JS createHash("sha256").update(JSON.stringify([file,text]))
    return hashlib.sha256(json.dumps([file, text], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()

def minutes(r):
    if r["duration_seconds"]: return r["duration_seconds"] / 60
    try:
        a = dt.datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")); b = dt.datetime.fromisoformat(r["ended_at"].replace("Z", "+00:00"))
        return max(0.0, (b - a).total_seconds() / 60)
    except Exception: return 0.0

def targets(c):
    rows = c.execute("""SELECT e.id, COALESCE(e.recording_provider_id,e.external_id) pid, e.recording_file, e.started_at, e.ended_at, e.duration_seconds,
        t.state t_state, t.source_file t_file, t.result_json t_result
      FROM voip_after_call_events e LEFT JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id)
      WHERE e.is_live=0 AND e.has_recording=1 AND e.recording_file IS NOT NULL AND COALESCE(e.recording_provider_id,e.external_id) NOT LIKE 'live-%'
      ORDER BY e.id""").fetchall()
    tx, sm = [], []
    for r in rows:
        if r["t_state"] in ("queued", "processing"): continue
        if r["t_state"] is None or r["t_state"] == "failed" or r["t_file"] != r["recording_file"]:
            tx.append(r); continue
        text = (json.loads(r["t_result"] or "{}") or {}).get("text")
        if not isinstance(text, str) or not text.strip(): continue
        h = digest(r["t_file"], text)
        edit = c.execute("SELECT source_hash FROM voip_recording_summary_edits WHERE external_id=? ORDER BY revision DESC LIMIT 1", (r["pid"],)).fetchone() if has_table(c, "voip_recording_summary_edits") else None
        if edit and edit[0] == h: continue
        s = c.execute("SELECT state, source_hash FROM voip_recording_summaries WHERE external_id=?", (r["pid"],)).fetchone() if has_table(c, "voip_recording_summaries") else None
        if s and s["source_hash"] == h and s["state"] in ("completed", "queued", "processing"): continue
        sm.append((r, h))
    return tx, sm

def has_table(c, n): return c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (n,)).fetchone() is not None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("CRM_DATABASE_PATH"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--cap-usd", type=float, default=None)
    ap.add_argument("--max-pending", type=int, default=2)
    ap.add_argument("--limit", type=int, default=50, help="max transcripts to queue (summary-only targets are cheap and always included, still under the cap)")
    ap.add_argument("--poll", type=float, default=20.0)
    ap.add_argument("--timeout-min", type=float, default=180.0)
    a = ap.parse_args()
    if not a.db or not os.path.exists(a.db): sys.exit("DB not found (--db)")
    ro = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True); ro.row_factory = sqlite3.Row
    tx, sm = targets(ro)
    tx = tx[: max(0, a.limit)]
    mins = sum(minutes(r) for r in tx)
    est, upper = mins * COST_MONO + len(sm) * COST_SUMMARY, mins * COST_STEREO + (len(tx) + len(sm)) * COST_SUMMARY
    print(json.dumps({"mode": "apply" if a.apply else "dry-run", "transcribe": len(tx), "summaryOnly": len(sm),
        "audioMinutes": round(mins, 1), "estimatedUsd": round(est, 3), "upperBoundUsd": round(upper, 3),
        "eventIds": [r["id"] for r in tx], "summaryEventIds": [r["id"] for r, _ in sm]}, ensure_ascii=False))
    if not a.apply: return
    if a.cap_usd is None: sys.exit("refused: --apply needs --cap-usd")
    if upper > a.cap_usd: sys.exit(f"refused: upper bound {upper:.3f} USD > cap {a.cap_usd:.2f} USD (use --limit)")
    flag = ro.execute("SELECT value FROM call_queue_settings WHERE key='flag.call_transcripts.auto'").fetchone()
    if not flag or flag[0] != "1": sys.exit("refused: flag.call_transcripts.auto is OFF (system jobs would fail)")
    cols = {r[1] for r in ro.execute("PRAGMA table_info(voip_recording_transcripts)")}
    if not {"attempts", "next_attempt_at"} <= cols: sys.exit("refused: schema not ready (start the new API with the flag on first)")
    ro.close()
    c = sqlite3.connect(a.db, timeout=30); c.row_factory = sqlite3.Row
    spent, deadline = 0.0, time.time() + a.timeout_min * 60
    now = lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for r, h in sm:
        spent += COST_SUMMARY
        c.execute("""INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,error,created_at,updated_at)
          VALUES(?,?,0,?,?,'queued',NULL,?,?) ON CONFLICT(external_id) DO UPDATE SET source_hash=excluded.source_hash,requested_by=0,
          range_from=excluded.range_from,range_to=excluded.range_to,state='queued',error=NULL,result_json=NULL,lease_until=NULL,updated_at=excluded.updated_at""",
          (r["pid"], h, tday(r["started_at"]), tday(r["ended_at"]), now(), now())); c.commit()
        print(json.dumps({"queued": "summary", "eventId": r["id"]}))
    for r in tx:
        cost = minutes(r) * COST_STEREO + COST_SUMMARY
        if spent + cost > a.cap_usd: print(json.dumps({"stopped": "cap", "spentUpperUsd": round(spent, 3)})); break
        while True:
            pend = c.execute("SELECT COUNT(*) FROM voip_recording_transcripts WHERE requested_by=0 AND state IN ('queued','processing')").fetchone()[0]
            total = c.execute("SELECT COUNT(*) FROM voip_recording_transcripts WHERE state IN ('queued','processing')").fetchone()[0]
            if pend < a.max_pending and total < 10: break
            if time.time() > deadline: sys.exit("stopped: timeout while throttled")
            time.sleep(a.poll)
        c.execute("""INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,created_at,updated_at,attempts,next_attempt_at)
          VALUES(?,?,?,?,0,'queued',?,?,0,NULL) ON CONFLICT(external_id) DO UPDATE SET source_file=excluded.source_file,range_from=excluded.range_from,
          range_to=excluded.range_to,requested_by=0,state='queued',phase=NULL,error=NULL,
          result_json=CASE WHEN source_file=excluded.source_file THEN result_json ELSE NULL END,
          completed_at=CASE WHEN source_file=excluded.source_file THEN completed_at ELSE NULL END,
          lease_until=NULL,attempts=0,next_attempt_at=NULL,updated_at=excluded.updated_at""",
          (r["pid"], r["recording_file"], tday(r["started_at"]), tday(r["ended_at"]), now(), now())); c.commit()
        spent += cost
        print(json.dumps({"queued": "transcript", "eventId": r["id"], "spentUpperUsd": round(spent, 3)}))
    print(json.dumps({"done": True, "spentUpperUsd": round(spent, 3)}))

if __name__ == "__main__": main()
