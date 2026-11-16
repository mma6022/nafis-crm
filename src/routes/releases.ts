import { Router } from "express";
import { requireAdmin } from "../lib/auth";

const router = Router();

// The installed manager is served outside the versioned CRM by the CRM-only
// Nginx exact-path rules. Do not let a historical CRM release control deployment.
router.get("/releases", requireAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    available: false,
    reason: "برای مدیریت نسخه‌ها، سرویس مستقل انتشار باید روی سرور نصب شود.",
    current: null,
    latest: null,
    updatesAvailable: false,
    releases: [],
  });
});

router.post("/releases/activate", requireAdmin, (_req, res) => {
  res.status(503).json({ error: "persistent_release_manager_required" });
});

export default router;