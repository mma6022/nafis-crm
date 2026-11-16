// Isolated browser harness: synthetic actors and in-memory database only.
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const root=await mkdtemp(path.join(tmpdir(),"diagnostic-browser-"));
const frontend=path.resolve("../crm-dashboard");
const ui=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{DiagnosticsProvider,DiagnosticsButton}from'./src/diagnostics/DiagnosticsProvider';
import{DiagnosticPageBoundary}from'./src/diagnostics/DiagnosticPageBoundary';
import{Modal}from'./src/components/DataTools';
import{Dialog,DialogContent,DialogTitle}from'./src/components/ui/dialog';
import'./src/index.css';
const query=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
function Boom(){throw new Error('Synthetic page render failure');}
function App(){
 const[actor,setActor]=useState(2),[legacy,setLegacy]=useState(false),[radix,setRadix]=useState(false),[broken,setBroken]=useState(false);
 const switchActor=async()=>{await fetch('/__test/actor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:actor===2?3:2})});setActor(actor===2?3:2)};
 return <QueryClientProvider client={query}><DiagnosticsProvider actorId={actor}><main dir="rtl" style={{padding:40}}>
 <h1>محیط آزمایشی گزارش خطا</h1><p data-testid="actor">کارمند {actor}</p><DiagnosticsButton/>
 <button data-testid="legacy-open" onClick={()=>setLegacy(true)}>فرم قدیمی</button>
 <button data-testid="radix-open" onClick={()=>setRadix(true)}>پنجره رادیکس</button>
 <button data-testid="actor-switch" onClick={switchActor}>تغییر کاربر آزمایشی</button>
 <button data-testid="page-crash" onClick={()=>setBroken(true)}>خطای نمایشی آزمایشی</button>
 <DiagnosticPageBoundary>{broken?<Boom/>:<p>بخش سالم</p>}</DiagnosticPageBoundary>
 {legacy?<Modal title="فرم آزمایشی" testId="fixture" onClose={()=>setLegacy(false)}><input data-testid="legacy-input" aria-label="متن فرم زیرین" defaultValue="متن حفظ شود"/></Modal>:null}
 <Dialog open={radix} onOpenChange={setRadix}><DialogContent><DialogTitle>فرم رادیکس آزمایشی</DialogTitle><input data-testid="radix-input" aria-label="متن رادیکس" defaultValue="رادیکس حفظ شود"/></DialogContent></Dialog>
 </main></DiagnosticsProvider></QueryClientProvider>
}createRoot(document.getElementById('root')).render(<App/>);
`;
await build({stdin:{contents:ui,resolveDir:frontend,loader:"tsx"},bundle:true,platform:"browser",target:"es2022",format:"esm",
  outdir:root+"/public",entryNames:"fixture",jsx:"automatic",alias:{"@":frontend+"/src"},
  define:{"import.meta.env.BASE_URL":'"/"',"import.meta.env.DEV":"false"},loader:{".svg":"file",".png":"file",".woff2":"file"},
  logLevel:"silent"});
await writeFile(root+"/public/index.html",'<html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
const api=`
import express from'express';import{DatabaseSync}from'node:sqlite';
import{createDiagnosticRouter}from'./src/lib/diagnostic-reports';
const db=new DatabaseSync(':memory:');let actor=2,connected=false;
const app=express();app.use(express.json());
app.use('/api',createDiagnosticRouter({db,requireAuth:(_req,res,next)=>{res.locals.authUser={id:actor,role:'staff'};next()},
workerSecret:()=>connected?'synthetic-key-for-browser-harness-only-12345':undefined,currentBuild:()=>null,healthy:async()=>true}));
app.post('/__test/actor',(req,res)=>{actor=req.body.id===3?3:2;res.json({ok:true})});
app.get('/__test/report',(req,res)=>res.json(db.prepare('SELECT id,user_id,status,browser_events_json FROM diagnostic_reports WHERE user_id=? ORDER BY id DESC LIMIT 1').get(actor)??null));
app.post('/__test/status',(req,res)=>{
 const report=db.prepare('SELECT id FROM diagnostic_reports WHERE user_id=? ORDER BY id DESC LIMIT 1').get(actor);
 if(!report){res.status(404).json({error:'no_report'});return;}
 const status=['investigating','fixing','testing','deploying','verifying','resolved','failed'].includes(req.body.status)?req.body.status:'failed';
 db.prepare('UPDATE diagnostic_reports SET status=?,lease_until=?,updated_at=?,version=version+1 WHERE id=?').run(status,Date.now()+600000,new Date().toISOString(),report.id);res.json({ok:true});
});
app.get('/images/repair-gears.gif',(_req,res)=>res.sendFile(${JSON.stringify(frontend+"/public/images/repair-gears.gif")}));
app.use(express.static(${JSON.stringify(root+"/public")}));
const server=app.listen(5604,'0.0.0.0',()=>console.log('Diagnostic synthetic browser harness ready on 5604'));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0)}));
`;
await build({stdin:{contents:api,resolveDir:process.cwd(),loader:"js"},bundle:true,platform:"node",format:"esm",packages:"external",outfile:root+"/server.mjs",
  banner:{js:"import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);"},
  plugins:[{name:"fixture-deps",setup(b){
    b.onResolve({filter:/^express$/},()=>({path:path.resolve("node_modules/express/index.js"),external:true}));
    b.onResolve({filter:/^@workspace\/api-zod$/},()=>({path:path.resolve("../../lib/api-zod/src/index.ts")}));
    b.onResolve({filter:/^zod$/},()=>({path:createRequire(path.resolve("../../lib/api-zod/package.json")).resolve("zod"),external:true}));
  }}],logLevel:"silent"});
await import(root+"/server.mjs");
