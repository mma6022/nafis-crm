import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { logger } from "./logger";

/** Event-loop lag histogram for the CRM API. No request bodies or secrets. */
const RESOLUTION_MS = 20;
const WARN_P99_NS = 100 * 1e6; // 100ms
const WARN_EVERY_MS = 30_000;

let hist: IntervalHistogram | null = null;
let lastWarn = 0;

export function startEventLoopLagMonitor(): void {
  if (hist) return;
  hist = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  hist.enable();
  const tick = setInterval(() => {
    const snap = eventLoopLagSnapshot();
    if (!snap) return;
    if (snap.p99Ms >= 100 && Date.now() - lastWarn >= WARN_EVERY_MS) {
      lastWarn = Date.now();
      logger.warn({ eventLoopLag: snap }, "event-loop lag high");
    }
  }, 5_000);
  tick.unref();
}

export function eventLoopLagSnapshot(): {
  minMs: number; meanMs: number; maxMs: number; p50Ms: number; p99Ms: number; resolutionMs: number;
} | null {
  if (!hist) return null;
  const ns = (n: number) => Math.round((n / 1e6) * 100) / 100;
  return {
    minMs: ns(hist.min),
    meanMs: ns(hist.mean),
    maxMs: ns(hist.max),
    p50Ms: ns(hist.percentile(50)),
    p99Ms: ns(hist.percentile(99)),
    resolutionMs: RESOLUTION_MS,
  };
}

/** Test helper: reset the histogram so a fixture starts clean. */
export function resetEventLoopLagForTests(): void {
  hist?.reset();
  lastWarn = 0;
}

export { WARN_P99_NS };
