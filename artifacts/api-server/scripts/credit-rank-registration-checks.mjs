import assert from "node:assert/strict";

// Called by the existing isolated HTTP fixture, never the production database.
export async function checkCreditRankRegistration(ctx) {
  const {db, request, expect, inspect, staffCookie, registrarCookie, adminCookie, customers, planId, conditionId, staffId} = ctx;
  const customerId=customers[0];
  db.exec(`CREATE TABLE company_wallet_accounts(wallet_type TEXT PRIMARY KEY,balance TEXT);
    CREATE TABLE company_wallet_ledger(id INTEGER PRIMARY KEY, wallet_type TEXT,amount_toman TEXT,kind TEXT,fee_charge_id INTEGER,actor_user_id INTEGER,idempotency_key TEXT UNIQUE,created_at TEXT);
    INSERT INTO company_wallet_accounts VALUES('cash','0');`);
  db.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance) VALUES(?,'cash','10000')").run(customerId);
  db.prepare("UPDATE customer_credit_checks SET score_label='C'").run();
  db.prepare("UPDATE loan_plan_conditions SET max_principal='10000' WHERE id=?").run(conditionId);
  db.prepare("UPDATE loan_plans SET filing_fee_toman='100' WHERE id=?").run(planId);
  db.prepare("DELETE FROM loan_filing_fee_charges WHERE customer_id=?").run(customerId);
  // Explicitly give registrar the permission to prove the role gate is additional.
  db.prepare("INSERT OR IGNORE INTO role_permissions(role_slug,permission) VALUES('registrar','loan_applications.create')").run();
  db.prepare("UPDATE customers SET salesperson_id=NULL WHERE id=?").run(customers[2]);
  const fees=`/api/loan-applications/filing-fee-plans?customerId=${customerId}`;
  const display=`/api/customers/${customerId}/eligible-plans`;
  assert.equal((await expect(request(display,staffCookie,undefined,"GET"),200,"normal rank filter")).plans.length,0);
  const expanded=await expect(request(`${display}?ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"expanded rank-independent condition");
  assert.equal(expanded.plans[0].maximumAmount,"50000");
  assert.equal(expanded.credit.rank,"C");
  assert.equal((await expect(request(fees,staffCookie,undefined,"GET"),200,"normal fees")).plans.length,0);
  assert.equal((await expect(request(`${fees}&ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"override fees")).plans.length,1);
  await expect(request(`${fees}&ignoreCreditRank=true`,registrarCookie,undefined,"GET"),403,"registrar cannot waive rank even with permission");
  await expect(request(`${fees}&ignoreCreditRank=1`,staffCookie,undefined,"GET"),400,"invalid query");
  await expect(request(`/api/customers/${customers[2]}/eligible-plans?ignoreCreditRank=true`,staffCookie,undefined,"GET"),404,"scope retained");
  const pay=(body,key="rank-test-payment")=>request("/api/loan-applications/filing-fee-charges",staffCookie,
    {customerId,planId,...body},"POST",{"Idempotency-Key":key});
  await expect(pay({ignoreCreditRank:false}),422,"normal payment rejects rank");
  await expect(pay({ignoreCreditRank:"true"}),400,"body must be boolean");
  await expect(request("/api/loan-applications/filing-fee-charges",registrarCookie,
    {customerId,planId,ignoreCreditRank:true},"POST",{"Idempotency-Key":"registrar-rank-payment"}),403,"registrar cannot charge override");
  const wallet=()=>inspect("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'",customerId).balance;
  assert.equal(wallet(),"10000");
  db.prepare("UPDATE customers SET verification_status='unverified' WHERE id=?").run(customerId);
  await expect(pay({ignoreCreditRank:true}),422,"identity still required");
  db.prepare("UPDATE customers SET verification_status='verified' WHERE id=?").run(customerId);
  db.prepare("UPDATE customer_credit_checks SET completed_at='2000-01-01T00:00:00Z' WHERE customer_id=?").run(customerId);
  assert.equal((await expect(request(`${display}?ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"stale credit exempt display")).credit.fresh,false);
  assert.equal((await expect(request(`${fees}&ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"stale credit exempt fee eligibility")).plans.length,1);
  await expect(pay({ignoreCreditRank:false}),422,"ordinary payment still requires fresh credit");
  db.prepare("UPDATE wallet_accounts_v2 SET balance='0' WHERE customer_id=?").run(customerId);
  await expect(pay({ignoreCreditRank:true}),409,"no overdraft");
  db.prepare("UPDATE wallet_accounts_v2 SET balance='10000' WHERE customer_id=?").run(customerId);
  const charge=await expect(pay({ignoreCreditRank:true}),201,"authorized rank-independent payment");
  const repeat=await expect(pay({ignoreCreditRank:true}),200,"payment retry idempotent");
  assert.equal(charge.chargeId,repeat.chargeId);
  assert.equal(wallet(),"9900");
  assert.equal(inspect("SELECT balance FROM company_wallet_accounts WHERE wallet_type='cash'").balance,"100");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE kind='filing_fee_out'").count,1);
  assert.equal(inspect("SELECT COUNT(*) count FROM company_wallet_ledger").count,1);
  const input={customerId,planId,conditionId,feeChargeId:charge.chargeId,requestedAmount:"40000",durationMonths:12,manualValues:{},preRegistration:true};
  const create=(extra,cookie=staffCookie)=>request("/api/loan-applications",cookie,{...input,...extra});
  await expect(create({ignoreCreditRank:false}),422,"normal creation rejects mismatch");
  await expect(create({ignoreCreditRank:true},registrarCookie),403,"registrar cannot create exempt case");
  await expect(create({ignoreCreditRank:"true"}),400,"no truthy body coercion");
  await expect(create({ignoreCreditRank:true,requestedAmount:"60000"}),422,"full plan ceiling still enforced");
  await expect(create({ignoreCreditRank:true,durationMonths:24}),422,"condition duration still enforced");
  await expect(create({ignoreCreditRank:true,conditionId:0}),400,"synthetic display condition cannot register");
  assert.equal(inspect("SELECT application_id FROM loan_filing_fee_charges WHERE id=?",charge.chargeId).application_id,null);
  const app=await expect(create({ignoreCreditRank:true}),201,"exempt case registers above rank-conditioned cap");
  const snapshot=JSON.parse(inspect("SELECT condition_snapshot_json FROM loan_applications WHERE id=?",app.id).condition_snapshot_json);
  assert.equal(snapshot.credit_rank_ignored,true);
  assert.equal(snapshot.max_principal,"50000");
  assert.equal(snapshot.credit_rank_override.actorId,staffId);
  assert.ok(snapshot.credit_rank_override.at);
  assert.equal(snapshot.credit_rank_override.originalMaximumAmount,"10000");
  assert.equal(snapshot.customer_ranks,'["A"]');
  assert.equal(inspect("SELECT score_label FROM customer_credit_checks WHERE customer_id=?",customerId).score_label,"C");
  assert.equal(inspect("SELECT max_principal FROM loan_plan_conditions WHERE id=?",conditionId).max_principal,"10000");
  const repeatedCase=await expect(create({ignoreCreditRank:true}),200,"case retry does not duplicate");
  assert.equal(repeatedCase.id,app.id);
  const detail=await expect(request(`/api/loan-applications/${app.id}`,staffCookie,undefined,"GET"),200,"reloaded exemption");
  assert.equal(detail.creditRankIgnored,true);
  db.prepare("DELETE FROM customer_credit_checks WHERE customer_id=?").run(customerId);
  assert.equal((await expect(request(`${display}?ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"missing credit exempt display")).credit.fresh,false);
  assert.equal((await expect(request(`${fees}&ignoreCreditRank=true`,staffCookie,undefined,"GET"),200,"missing credit exempt fee eligibility")).plans.length,1);
  await expect(request(`/api/loan-applications/${app.id}`,staffCookie,{requestedAmount:"45000"},"PATCH"),200,"edit honors persisted exemption");
  await expect(request(`/api/loan-applications/${app.id}`,staffCookie,{requestedAmount:"60000"},"PATCH"),422,"edit retains full cap");
  await expect(request(`/api/loan-applications/${app.id}`,staffCookie,{ignoreCreditRank:false},"PATCH"),400,"cannot mutate exemption through ordinary edit");
  // Admin is independently authorized; a pre-existing unused synthetic charge
  // allows checking creation without another real-world-style payment.
  const adminApp=await expect(request("/api/loan-applications",adminCookie,{...input,customerId:customers[1],feeChargeId:2,ignoreCreditRank:true}),201,"admin exemption");
  assert.ok(adminApp.id);
  // Missing credit is allowed only for explicitly authorized new cases.
  db.prepare("DELETE FROM customer_credit_checks WHERE customer_id=?").run(customers[1]);
  await expect(request(`/api/loan-applications/${adminApp.id}`,adminCookie,{requestedAmount:"45000"},"PATCH"),200,"persisted exemption without any credit result");
  const missingCreditFeeId=Number(db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,'100','missing-credit-synthetic-fee',?,?)`)
    .run(customers[1],planId,staffId,new Date().toISOString()).lastInsertRowid);
  const missingCreditCase=await expect(request("/api/loan-applications",adminCookie,{...input,customerId:customers[1],feeChargeId:missingCreditFeeId,ignoreCreditRank:true}),201,"creation without credit result");
  assert.equal(JSON.parse(inspect("SELECT condition_snapshot_json FROM loan_applications WHERE id=?",missingCreditCase.id).condition_snapshot_json).credit_rank_ignored,true);
  console.log("PASS rank exemption throughout payment, registration and persisted edits with stale/missing credit; ordinary credit, roles, identity, cap, durations and payment idempotency preserved. All resources synthetic.");
}
