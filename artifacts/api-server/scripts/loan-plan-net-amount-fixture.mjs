import assert from "node:assert/strict";
import {build} from "esbuild";
import {pathToFileURL} from "node:url";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const temp=await mkdtemp(path.join(os.tmpdir(),"loan-net-amount-"));
try {
  await build({entryPoints:[path.resolve("src/lib/loan-plan-net-amount.ts")],bundle:true,platform:"node",format:"esm",outfile:path.join(temp,"net.mjs")});
  const {loanPlanNetAmount:net}=await import(pathToFileURL(path.join(temp,"net.mjs")));
  const app=(snapshot,duration=18,amount="120000000")=>({approved_amount:amount,duration_months:duration,plan_snapshot_json:JSON.stringify(snapshot)});
  assert.equal(net(app({deduct_percents:'{"24":"40"}',installment_terms:'[{"installments":18,"deductionPercent":18}]'})),"98400000");
  assert.equal(net(app({deduct_percents:'{"24":"40"}',installment_terms:'[{"installments":18,"deductionPercent":19.5}]'})),"96600000");
  assert.equal(net(app({deduct_percents:'{"12":"15","18":"18.5","24":"24"}'},12,"100000000")),"85000000");
  assert.equal(net(app({deduct_percents:'{"12":"15","18":"18.5","24":"24"}'},24,"100000000")),"76000000");
  assert.equal(net(app({})),"120000000");
  assert.equal(net(app({deduct_percents:null})),"120000000");
  assert.equal(net(app({deduct_percents:null,installment_terms:[{installments:18,deductionPercent:46.5}]})),"120000000");
  assert.equal(net(app({deduct_percents:"0"})),"120000000");
  assert.equal(net(app({deduct_percents:"100"})),"0");
  assert.equal(net(app({installment_terms:[{installments:18,deductionPercent:0}],deduct_percents:{"24":"40"}})),"120000000");
  assert.equal(net(app({installment_terms:[{installments:18,deductionPercent:19.5}],deduct_percents:{"18":"18.5"}})),"97800000");
  for(const snapshot of [
    {deduct_percents:'{"24":"40"}'},
    {deduct_percents:"-1"},{deduct_percents:"100.01"},{deduct_percents:"NaN"},{deduct_percents:""},
    {installment_terms:"broken",deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:-1}],deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:"1.234"}],deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:18},{installments:18,deductionPercent:19.5}],deduct_percents:{"24":"40"}},
  ])assert.throws(()=>net(app(snapshot)),/invalid_deduction_percent/);
  assert.throws(()=>net(app({},18,"1,000")),/invalid_financial_value/);
  console.log("PASS: frozen duration terms, historical/future percentages, legacy maps, optional zero, strict invalid/duplicate guards and integer money");
} finally { await rm(temp,{recursive:true,force:true}); }
