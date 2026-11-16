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
  // T664: empty deduct_percents ⇒ installment_terms (frozen when no current terms are passed).
  assert.equal(net(app({deduct_percents:null,installment_terms:[{installments:18,deductionPercent:46.5}]})),"64200000");
  assert.equal(net(app({deduct_percents:"",installment_terms:'[{"installments":18,"deductionPercent":19.5}]'},18,"200000000")),"161000000");
  assert.equal(net(app({deduct_percents:"{}",installment_terms:[{installments:24,deductionPercent:15}]})),"120000000");
  // current plan terms win over the frozen ones (decision 2: open files use today's %)
  const cur=(id,plan,snap,d,amt)=>net({id,approved_amount:amt,duration_months:d,plan_snapshot_json:JSON.stringify(snap)},plan);
  assert.equal(cur(42,'[{"installments":24,"deductionPercent":15}]',{deduct_percents:null,installment_terms:[{installments:24,deductionPercent:40}]},24,"200000000"),"170000000");
  assert.equal(cur(98,'[{"installments":18,"deductionPercent":19.5}]',{deduct_percents:null,installment_terms:[{installments:18,deductionPercent:40}]},18,"88000000"),"70840000");
  assert.equal(cur(143,[{installments:18,deductionPercent:18.8}],{deduct_percents:null},18,"250000000"),"203000000");
  assert.equal(cur(176,[{installments:18,deductionPercent:19.5}],{deduct_percents:null},18,"192000000"),"154560000");
  assert.equal(cur(145,'[{"installments":24,"deductionPercent":0}]',{deduct_percents:null,installment_terms:[{installments:24,deductionPercent:46.5}]},24,"266000000"),"266000000");
  assert.equal(cur(145,null,{deduct_percents:null,installment_terms:[{installments:24,deductionPercent:46.5}]},24,"266000000"),"266000000");
  // 35/37/55 pinned at 46.5 although plan 19 is 0% today
  for(const id of [35,37,55,"55"]) assert.equal(cur(id,'[{"installments":24,"deductionPercent":0}]',{deduct_percents:null,installment_terms:[{installments:24,deductionPercent:0}]},24,"150000000"),"80250000");
  assert.equal(cur(35,'[]',{deduct_percents:null},24,"142736000"),"76363760");
  // legacy map (plan 8) unchanged: map wins over current/frozen terms, pin ignored
  assert.equal(cur(62,'[{"installments":18,"deductionPercent":19.5}]',{deduct_percents:'{"12":"15","18":"18.5","24":"24","36":"35"}'},18,"100000000"),"81500000");
  assert.equal(cur(35,'[{"installments":24,"deductionPercent":0}]',{deduct_percents:'{"24":"24"}'},24,"100000000"),"76000000");
  assert.throws(()=>cur(1,'[{"installments":18,"deductionPercent":18},{"installments":18,"deductionPercent":19}]',{deduct_percents:null},18,"100000000"),/invalid_deduction_percent/);
  assert.throws(()=>cur(1,'broken',{deduct_percents:null},18,"100000000"),/invalid_deduction_percent/);
  assert.throws(()=>cur(1,'[{"installments":18,"deductionPercent":-1}]',{deduct_percents:null},18,"100000000"),/invalid_deduction_percent/);
  assert.equal(net(app({deduct_percents:"0"})),"120000000");
  assert.equal(net(app({deduct_percents:"100"})),"0");
  assert.equal(net(app({installment_terms:[{installments:18,deductionPercent:0}],deduct_percents:{"24":"40"}})),"120000000");
  assert.equal(net(app({installment_terms:[{installments:18,deductionPercent:19.5}],deduct_percents:{"18":"18.5"}})),"97800000");
  for(const snapshot of [
    {deduct_percents:'{"24":"40"}'},
    {deduct_percents:"-1"},{deduct_percents:"100.01"},{deduct_percents:"NaN"},
    {installment_terms:"broken",deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:-1}],deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:"1.234"}],deduct_percents:{"24":"40"}},
    {installment_terms:[{installments:18,deductionPercent:18},{installments:18,deductionPercent:19.5}],deduct_percents:{"24":"40"}},
  ])assert.throws(()=>net(app(snapshot)),/invalid_deduction_percent/);
  assert.throws(()=>net(app({},18,"1,000")),/invalid_financial_value/);
  console.log("PASS: T664 current-plan terms for empty deduct_percents, 35/37/55 pin, frozen duration terms, historical/future percentages, legacy maps, optional zero, strict invalid/duplicate guards and integer money");
} finally { await rm(temp,{recursive:true,force:true}); }
