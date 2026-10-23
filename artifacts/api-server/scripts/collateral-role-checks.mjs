import assert from "node:assert/strict";

// Runs against the synthetic identity fixture, never CRM data or providers.
export async function checkCollateralRoleTransfer({ db, request, applicationId, page }) {
  const base = `/loan-applications/${applicationId}`;
  const upload = (role, status = 201, key = "customer:check:front") => {
    const body = new FormData();
    body.set("requirementKey", key);
    body.set("file", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])], { type: "image/jpeg" }), "synthetic.jpg");
    return request(role, "POST", `${base}/collateral`, body, status);
  };
  db.prepare("UPDATE loan_applications SET condition_snapshot_json=? WHERE id=?")
    .run(JSON.stringify({ needs_customer_check: true }), applicationId);
  for (const role of ["salesperson", "accounting"]) await upload(role, 403);
  await upload("other", 400); // Out-of-scope case is not exposed to the uploader.
  await upload("registrar", 400, "not-a-required-slot");
  const front = await upload("registrar");
  assert.ok(front.id);
  await request("salesperson", "DELETE", `${base}/collateral/${front.id}`, undefined, 403);
  await request("registrar", "DELETE", `${base}/collateral/${front.id}`, undefined, 204);
  const saved = await upload("registrar");
  await upload("admin", 201, "customer:check:back");
  db.prepare("UPDATE loan_applications SET stage='funder_documents_correction' WHERE id=?").run(applicationId);
  await upload("salesperson", 403);
  await upload("registrar", 409); // Only explicitly returned collateral may be replaced.
  db.prepare("INSERT INTO loan_funder_defects(application_id,source,source_id) VALUES(?,'collateral',?)")
    .run(applicationId, saved.id);
  assert.equal((await upload("registrar")).id, saved.id);
  assert.ok(db.prepare("SELECT resolved_at FROM loan_funder_defects WHERE source_id=?").get(saved.id).resolved_at);
  db.prepare("UPDATE loan_applications SET stage='collateral_review' WHERE id=?").run(applicationId);
  await upload("registrar", 403);
  db.prepare("UPDATE loan_applications SET stage='collateral_upload',status='rejected' WHERE id=?").run(applicationId);
  await upload("registrar", 403);
  await upload("admin", 403);
  assert.match(page, /canUpload=\{Boolean\(canUpdate && canRegistrarAct && app\.stage === 'collateral_upload'\)\}/);
  assert.match(page, /canSubmit=\{Boolean\(canUpdate && canRegistrarAct && app\.stage === 'collateral_upload'\)\}/);
  const correctionPanel = page.split("{funderDefects.some((d: any) => d.source === 'collateral')")[1]?.split("\n")[0];
  assert.ok(correctionPanel?.includes("canUpdate && canRegistrarAct"));
  assert.ok(!correctionPanel?.includes("canSalespersonAct"));
  console.log("PASS collateral transfer: registrar/admin upload, registrar delete, sales forbidden including corrections, required slots/stages/terminal status preserved; UI controls match API.");
}
