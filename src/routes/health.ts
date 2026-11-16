import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { eventLoopLagSnapshot, startEventLoopLagMonitor } from "../lib/event-loop-lag";

startEventLoopLagMonitor();

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  const lag = eventLoopLagSnapshot();
  if (lag) res.setHeader("X-Event-Loop-Lag-P99-Ms", String(lag.p99Ms));
  res.json(data);
});

/** Lag numbers only — no request data, no secrets. Public like /healthz so probes can read it. */
router.get("/event-loop-lag", (_req, res) => {
  const lag = eventLoopLagSnapshot();
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ lag: lag ?? { minMs: 0, meanMs: 0, maxMs: 0, p50Ms: 0, p99Ms: 0, resolutionMs: 0 } });
});

export default router;
