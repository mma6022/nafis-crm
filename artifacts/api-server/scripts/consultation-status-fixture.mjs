import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { registerCustomerIdentityFunctions } from "../src/lib/customer-integrity.ts";

// Only synthetic, uniquely identified records are used, never existing customers.
const file = "/tmp/consultation-ui-fixture.json";
const db = new DatabaseSync(path.resolve("../../attached_assets/customers_1789823100050.db"));
registerCustomerIdentityFunctions(db);
db.exec("PRAGMA foreign_keys=ON");
db.exec("PRAGMA busy_timeout=10000");
const base = "http://127.0.0.1:8080/api";
if (process.argv.includes("--cleanup")) {
  const fixture = JSON.parse(await readFile(file, "utf8"));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of fixture.customerIds) {
      db.prepare("DELETE FROM call_logs WHERE customer_id=?").run(id);
      db.prepare("DELETE FROM consultation_forms WHERE customer_id=?").run(id);
      db.prepare("DELETE FROM customers WHERE id=?").run(id);
    }
    for (const id of fixture.planIds) {
      db.prepare("DELETE FROM loan_plan_conditions WHERE plan_id=?").run(id);
      db.prepare("DELETE FROM loan_plans WHERE id=?").run(id);
    }
    for (const id of fixture.userIds) {
      db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(id);
      db.prepare("DELETE FROM users WHERE id=?").run(id);
    }
    for (const id of fixture.ownerIds) db.prepare("DELETE FROM salespersons WHERE id=?").run(id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  await unlink(file);
  console.log("Synthetic consultation fixture records removed.");
} else {
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required");
  const now = new Date().toISOString(), suffix = randomBytes(5).toString("hex");
  const prefix = `Consultation fixture ${suffix}`;
  db.exec("BEGIN");
  const ownerIds = [1, 2].map(n => Number(db.prepare("INSERT INTO salespersons(name,created_at) VALUES(?,?)").run(`${prefix} owner ${n}`, now).lastInsertRowid));
  const userIds = [], cookies = {};
  for (const [key, role, owner] of [["admin", "admin", null], ["expert", "salesperson", ownerIds[0]]]) {
    const id = Number(db.prepare("INSERT INTO users(username,password_hash,full_name,role,salesperson_id,active,created_at) VALUES(?,?,?,?,?,1,?)")
      .run(`${prefix}-${key}`, "not-a-login-password", prefix, role, owner, now).lastInsertRowid);
    userIds.push(id);
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(createHmac("sha256", process.env.SESSION_SECRET).update(token).digest("hex"), id, new Date(Date.now()+1800000).toISOString(), now);
    cookies[key] = `crm_session=${token}`;
  }
  const customerIds = ownerIds.map((owner,n) => Number(db.prepare("INSERT INTO customers(name,phone,salesperson_id,credit_rank,created_at) VALUES(?,?,?,'A1',?)")
    .run(`${prefix} customer ${n+1}`, `0000000000${n}`, owner, now).lastInsertRowid));
  const planIds = ["C", "A"].map((rank,n) => {
    const id = Number(db.prepare("INSERT INTO loan_plans(name,principal_amount,active,created_at) VALUES(?,'10000000',1,?)")
      .run(`${prefix} plan ${n+1}`, now).lastInsertRowid);
    db.prepare("INSERT INTO loan_plan_conditions(plan_id,customer_ranks,needs_guarantor,needs_customer_check,sort_order) VALUES(?,?,0,1,0)")
      .run(id, JSON.stringify([rank]));
    return id;
  });
  const fixture = { prefix, cookies, userIds, ownerIds, customerIds, planIds };
  db.exec("COMMIT");
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  async function request(url, data, key="admin", method=data?"POST":"GET") {
    const response = await fetch(base+url,{method,headers:{Cookie:cookies[key],"Content-Type":"application/json"},body:data?JSON.stringify(data):undefined});
    return { status:response.status, data:await response.json() };
  }
  assert.equal((await request("/auth/session")).data.user.id,userIds[0]);
  const options = (await request("/consult-options")).data;
  for (const key of ["credit_rank","job_type","customer_check_status","has_guarantor","guarantor_check_type","has_customer_salary_deduct","has_guarantor_salary_deduct"])
    assert.ok(options.some(o=>o.fieldKey===key),`Missing dictionary ${key}`);
  const input = {customerId:customerIds[0],questionnaireVersion:1,creditRank:"C",jobType:"business",customerCheckStatus:"physical",hasCustomerSalaryDeduct:false,hasGuarantor:false};
  assert.equal((await request("/consultations",{...input,customerCheckStatus:undefined})).status,400);
  const first = await request("/consultations",input);
  assert.equal(first.status,201);
  assert.equal(first.data.creditRank,"C");
  assert.equal(db.prepare("SELECT credit_rank FROM customers WHERE id=?").get(customerIds[0]).credit_rank,"A1");
  const matching = (await request(`/consultations/${first.data.id}/loan-plan-matches`)).data;
  const matches = Array.isArray(matching) ? matching : matching.matches;
  assert.equal(matches.find(m=>m.plan.id===planIds[0]).status,"eligible");
  assert.equal(matches.find(m=>m.plan.id===planIds[1]).status,"not_eligible");
  assert.ok(matches.find(m=>m.plan.id===planIds[1]).failedRequirements.length);
  const second = await request("/consultations",{...input,hasGuarantor:true,guarantorCheckType:"digital",hasGuarantorSalaryDeduct:true});
  assert.equal(second.status,201);
  assert.notEqual(first.data.id,second.data.id);
  const history = (await request(`/consultations?customerId=${customerIds[0]}&limit=1`)).data;
  assert.equal(history.total,2);
  assert.equal(history.items[0].id,second.data.id);
  assert.equal((await request(`/consultations/${first.data.id}`)).data.hasGuarantor,false);
  assert.equal((await request(`/consultations/${first.data.id}`,{creditRank:"A"},"admin","PATCH")).status,409);
  const foreign = await request("/consultations",{...input,customerId:customerIds[1]});
  assert.equal(foreign.status,201);
  assert.equal((await request(`/consultations/${foreign.data.id}`,undefined,"expert")).status,404);
  assert.equal((await request(`/consultations?customerId=${customerIds[1]}`,undefined,"expert")).data.total,0);
  assert.equal((await request("/consultations",{...input,customerId:customerIds[1]},"expert")).status,404);
  assert.equal((await request(`/consultations/${foreign.data.id}/loan-plan-matches`,undefined,"expert")).status,404);
  console.log("Consultation HTTP checks passed: dictionaries, validation, filtering/reasons, repeated snapshots, verified-rank preservation, scope isolation.");
  console.log("Private browser fixture available at",file);
}
db.close();
