import { queryRow, queryRows } from "./crm-db";
import { pickGuarantorGrade, type GuarantorGradeSource } from "./guarantor-grade-rule";

function tableExists(name: string): boolean {
  return !!queryRow("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [name]);
}
function hasColumns(table: string, columns: string[]): boolean {
  const names = new Set(queryRows<{ name: string }>("SELECT name FROM pragma_table_info(?)", [table]).map((row) => row.name));
  return columns.every((column) => names.has(column));
}

/** Newest guarantor declaration for the customer (consultation or first-call form); see pickGuarantorGrade. */
export function customerGuarantorGrade(customerId: number): GuarantorGradeSource {
  // Older / partial schemas (fixtures, fresh installs) may lack the questionnaire columns: treat as "no declaration".
  const consultation = hasColumns("consultation_forms", ["customer_id", "has_guarantor", "guarantor_credit_rank", "created_at"]) ? queryRow<any>(
    `SELECT id,has_guarantor,guarantor_credit_rank,created_at FROM consultation_forms
     WHERE customer_id=? AND has_guarantor IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`, [customerId]) : null;
  let callForm: any = null;
  if (tableExists("team_sales_qualifications") && hasColumns("team_sales_qualifications", ["customer_id", "answers_json", "created_at"])) {
    // Newest call-form answer that actually says something about a guarantor (no-answer calls carry none).
    for (const row of queryRows<any>(
      `SELECT id,answers_json,created_at FROM team_sales_qualifications
       WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 20`, [customerId])) {
      let answers: any = {};
      try { answers = JSON.parse(String(row.answers_json ?? "{}")) ?? {}; } catch { answers = {}; }
      if (!["yes", "no", "unknown"].includes(String(answers.guarantorAvailable ?? ""))) continue;
      callForm = { id: Number(row.id), guarantorAvailable: answers.guarantorAvailable, gRank: answers.gRank, created_at: String(row.created_at) };
      break;
    }
  }
  return pickGuarantorGrade(consultation ?? null, callForm);
}
