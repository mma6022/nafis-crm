type ReturnDependencies = {
  queryRow: (sql: string, args?: any[]) => any;
  executeChanges: (sql: string, args?: any[]) => number;
  execute: (sql: string, args?: any[]) => unknown;
  transaction: (fn: () => void) => unknown;
  now: () => string;
};

/** Rejection is a reasoned return to the preceding sales task, not cancellation. */
export function returnRejectedLoanCase(a: any, actor: any, reason: string, action: string, d: ReturnDependencies) {
  const target: Record<string, string> = {
    funder_initial_approval: "customer_documents_upload",
    expert_approval: "collateral_upload",
    admin_approval: "physical_documents_submission",
  };
  const to = target[a.stage];
  if (!to || !reason.trim() || reason.trim().length > 1000) throw new Error("review_reason_required");
  d.transaction(() => {
    const current = d.queryRow("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [a.id]);
    if (!current || current.stage !== a.stage || current.status === "rejected" ||
        current.updated_at !== a.updated_at) throw new Error("invalid_stage_transition");
    const at = d.now();
    const changed = d.executeChanges(`UPDATE loan_applications SET stage=?,status='reviewing',
      funder_decision=CASE WHEN stage='expert_approval' THEN NULL ELSE funder_decision END,
      funder_reason=CASE WHEN stage='expert_approval' THEN NULL ELSE funder_reason END,
      expert_reviewed_at=CASE WHEN stage='expert_approval' THEN NULL ELSE expert_reviewed_at END,
      updated_at=? WHERE id=? AND stage=? AND status<>'rejected' AND deleted_at IS NULL`,
    [to, at, a.id, a.stage]);
    if (changed !== 1) throw new Error("invalid_stage_transition");
    d.execute(`INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?)`, [a.id, a.stage, to, action,
      JSON.stringify({ reason: reason.trim(), returnedToSales: true, previousDecision: {
        approvedAmount: current.approved_amount, initialApprovalAt: current.initial_approval_at,
        funderDecision: current.funder_decision, funderReason: current.funder_reason,
        expertReviewedAt: current.expert_reviewed_at,
      }, financialPostingChanged: false }), actor.id, at]);
  });
}
