import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
const dir=await mkdtemp(path.join(tmpdir(),"customer-payout-"));
try{
 await build({entryPoints:["src/lib/customer-application-payout.ts"],bundle:true,platform:"node",format:"esm",outfile:path.join(dir,"payout.mjs"),logLevel:"silent"});
 const {customerApplicationPayout:payout}=await import(path.join(dir,"payout.mjs"));
 const row={requested_amount:"100000000",duration_months:12,plan_snapshot_json:JSON.stringify({deposit_percents:'{"12":80,"24":70}'})};
 assert.deepEqual(payout(row),{cashPayoutAmount:"80000000",cashPayoutEstimated:true});
 assert.equal(payout({...row,duration_months:24}).cashPayoutAmount,"70000000");
 assert.equal(payout({...row,approved_amount:"50000000"}).cashPayoutAmount,"40000000");
 assert.equal(payout({...row,plan_snapshot_json:JSON.stringify({installment_terms:[{installments:12,depositPercent:65}],deposit_percents:99})}).cashPayoutAmount,"65000000");
 assert.equal(payout({...row,plan_snapshot_json:JSON.stringify({installment_terms:[{installments:24,depositPercent:65}],deposit_percents:99})}).cashPayoutAmount,null,"missing chosen term does not use unrelated default");
 for(const value of [null,"{}",'{"deposit_percents":"bad"}','{"deposit_percents":101}','{"deposit_percents":-1}','{"deposit_percents":null}']){
   assert.equal(payout({...row,plan_snapshot_json:value}).cashPayoutAmount,null);
 }
 assert.equal(payout({...row,net_amount:"999999",plan_snapshot_json:null}).cashPayoutAmount,null,"loan credit is never substituted for customer cash");
 assert.equal(payout({...row,requested_amount:"100000001",plan_snapshot_json:'{"deposit_percents":50}'}).cashPayoutAmount,"50000001","whole-toman half-up rounding");
 assert.equal(payout({...row,requested_amount:"999999999999999999",plan_snapshot_json:'{"deposit_percents":80}'}).cashPayoutAmount,"799999999999999999","large integer stays exact");
 assert.equal(payout({...row,plan_snapshot_json:'{"deposit_percents":"{\\"12\\":\\"۸۰\\"}"}'}).cashPayoutAmount,"80000000");
 assert.equal(payout({...row,plan_snapshot_json:'{"deposit_percents":0}'}).cashPayoutAmount,"0");
 console.log("PASS customer request payout: case snapshots, chosen duration, approved/requested principal, unknown/malformed rates, no credit fallback, exact rounding and Persian percentages");
}finally{await rm(dir,{recursive:true,force:true})}
