import type { Router, Response } from "express";
import type { AuthUser } from "./auth";
import { CancelLoanApplicationBody } from "@workspace/api-zod";
import { execute, executeChanges, runImmediateTransaction } from "./crm-db";

type CaseRow = {
  id: number; stage: string; status: string;
  customer_salesperson_id?: number | null;
};

export function canCancelLoanCase(row: CaseRow, actor: AuthUser): boolean {
  return row.status !== "rejected" && (actor.role === "admin" ||
    (actor.role === "salesperson" && Number(actor.salespersonId) > 0 &&
      Number(row.customer_salesperson_id) === Number(actor.salespersonId)));
}

export function registerLoanCaseCancellation(
  router: Router,
  scoped: (id: number, actor: AuthUser) => CaseRow | null,
  shape: (row: any, actor: AuthUser) => any,
  user: (res: Response) => AuthUser,
) {
  router.post("/loan-applications/:id/cancel", (req, res) => {
    const actor = user(res), id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(404).json({ error: "loan_application_not_found" }); return;
    }
    // The staff API authenticates the actor; customer IDs and roles are never
    // accepted from the request body. Recheck ownership under the write lock.
    const outcome = runImmediateTransaction(() => {
      const row = scoped(id, actor);
      if (!row) return { status: 404, error: "loan_application_not_found" };
      if (row.status === "rejected") return { status: 409, error: "case_already_closed" };
      if (!canCancelLoanCase(row, actor)) return { status: 403, error: "action_forbidden" };
      const parsed = CancelLoanApplicationBody.safeParse({
        ...req.body, reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : req.body?.reason,
      });
      if (!parsed.success || Object.keys(req.body ?? {}).some(key => key !== "reason")) {
        return { status: 400, error: "cancellation_reason_required" };
      }
      const ts = new Date().toISOString();
      const changed = executeChanges(
        "UPDATE loan_applications SET status='rejected',updated_at=? WHERE id=? AND status<>'rejected' AND deleted_at IS NULL",
        [ts, id],
      );
      if (changed !== 1) return { status: 409, error: "case_already_closed" };
      execute(
        "INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [id, row.stage, row.stage, "cancel-case", parsed.data.reason, actor.id, ts],
      );
      return { status: 200 };
    });
    if (outcome.status !== 200) {
      const messages: Record<string, string> = {
        cancellation_reason_required: "دلیل لغو باید بین ۱ تا ۱۰۰۰ نویسه باشد.",
        case_already_closed: "این پرونده قبلاً بسته شده است.",
        action_forbidden: "فقط مدیر یا کارشناس فروش فعلی همین مشتری می‌تواند پرونده را لغو کند.",
      };
      res.status(outcome.status).json({ error: outcome.error, message: messages[outcome.error!] }); return;
    }
    res.json(shape(scoped(id, actor), actor));
  });
}
