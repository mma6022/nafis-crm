/** «کیف پول من» / «کیف پول کارشناس‌ها» and «وضعیت تراکنش‌ها» › پورسانت‌ها. Read-only endpoints; scoping is enforced in lib/staff-wallet. */
import { Router, type RequestHandler } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { StaffWalletError, commissionStatusDetail, commissionStatusList, staffWallet } from "../lib/staff-wallet";

const router = Router();
const user = (res: any) => res.locals.authUser as AuthUser;
const wrap = (fn: (req: any, res: any) => void): RequestHandler => (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { fn(req, res); } catch (e) {
    if (e instanceof StaffWalletError) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e }, "staff_wallet_failed");
    res.status(500).json({ error: "staff_wallet_failed" });
  }
};

router.get("/goods-finance/staff-wallet", requireAuth, requirePermission("goods_finance.view"), wrap((req, res) => {
  res.json(staffWallet(user(res), { salespersonId: req.query.salespersonId, month: req.query.month }));
}));
router.get("/goods-finance/commission-status", requireAuth, wrap((req, res) => {
  res.json(commissionStatusList(user(res), req.query as Record<string, unknown>));
}));
router.get("/goods-finance/commission-status/:purchaseId", requireAuth, wrap((req, res) => {
  const id = Number(req.params.purchaseId);
  if (!Number.isInteger(id) || id <= 0) throw new StaffWalletError(400, "شناسه نامعتبر است.");
  res.json(commissionStatusDetail(user(res), id));
}));

export default router;
