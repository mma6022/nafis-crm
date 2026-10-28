import { Router } from "express";
import { requireAdmin } from "../lib/auth";
import { loadCrmMeta, loadSiteReleases } from "../lib/release-registry";

// Release 84(A): admin-only, read-only. No write/rollback endpoints here (site rollback = manual, by the developer).
const router = Router();

router.get("/site-releases", requireAdmin, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await loadSiteReleases());
  } catch {
    res.status(500).json({ available: false, reason: "read_error" });
  }
});

router.get("/crm-release-meta", requireAdmin, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await loadCrmMeta());
  } catch {
    res.status(500).json({ available: false, reason: "read_error", schemaCutoff: null, cutoffSource: "none", releases: {} });
  }
});

export default router;
