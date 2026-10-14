const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const roots=process.env.SUPERVISOR_TEST_ROOTS?JSON.parse(process.env.SUPERVISOR_TEST_ROOTS):['codex/.agents/skills/long-task-supervisor','claude-code/.claude/skills/long-task-supervisor'].map(p=>path.resolve(__dirname,'..',p));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
for(const skill of roots){
 const scripts=path.join(skill,'scripts'),{effective,append,attachAcceptance,inherit,startContract}=require(path.join(scripts,'contract-state.cjs')),{validateDecision}=require(path.join(scripts,'guard.cjs'));
 function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'contract-state-')),source=path.join(root,'source.md'),run=path.join(root,'run');fs.mkdirSync(run);
  fs.writeFileSync(source,'User message 1: Delegate visual judgment until completion.\nUser message 2: Exclude the human UAT from this goal; retain the notification requirement.\nUser message 3: Evaluate the revised answer by its correct next step.\n');
  const contract={goal:'Finish the original goal',authorization:'Supervise until independently accepted',criteria:[{id:'A1',requirement:'Correct answer',source:'original spec',verify:'Real client'},{id:'A2',requirement:'Human UAT',source:'original spec',verify:'Human session'},{id:'A3',requirement:'All notifications received',source:'original spec',verify:'Real inboxes'}],sources:[{path:source,sha256:sha(source)}]};
  save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',supervisorId:process.env.CODEX_THREAD_ID||'supervisor',executorId:'executor',allowedRoots:[root],contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
  save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'idle',pending:null,inflight:null});
  const authority=quote=>({role:'user',quote,at:'2026-10-04T12:00:00Z',locator:'user message in original supervisor',source:{path:source,sha256:sha(source)}});
  const row=(id,changes,quote='Exclude the human UAT from this goal; retain the notification requirement.')=>({id,contractSha256:binding.contractSha256,authority:authority(quote),changes});
  return {root,run,source,contract,binding,row};
 }
 test(skill+' preserves delegation through a rejected candidate and applies only explicit scope changes',()=>{
  const f=fixture();try{
   const original=fs.readFileSync(path.join(f.run,'contract.json'));
   append(f.run,f.binding,f.row('delegation',[{action:'authorization',id:'visual',scope:'visual selection',instruction:'Delegate visual judgment until completion.'}],'Delegate visual judgment until completion.'));
   assert.equal(append(f.run,f.binding,f.row('delegation',[{action:'authorization',id:'visual',scope:'visual selection',instruction:'Delegate visual judgment until completion.'}],'Delegate visual judgment until completion.')).alreadyRecorded,true);
   append(f.run,f.binding,f.row('scope',[{action:'exclude',id:'A2'}]));
   const active=effective(f.run,f.binding);
   assert.deepEqual(active.criteria.map(c=>c.id),['A1','A3']);assert.deepEqual(active.excluded.map(c=>c.id),['A2']);assert.equal(active.authorizationUpdates.length,1);
   assert.deepEqual(fs.readFileSync(path.join(f.run,'contract.json')),original);
   append(f.run,f.binding,f.row('judgment',[{action:'replace',id:'A1',requirement:'Correct next step',verify:'Real client answer by approved rubric'}],'Evaluate the revised answer by its correct next step.'));
   assert.equal(effective(f.run,f.binding).criteria[0].requirement,'Correct next step');
   append(f.run,f.binding,f.row('restore',[{action:'restore',id:'A2'}]));assert.equal(effective(f.run,f.binding).criteria.length,3);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 test(skill+' rejects unsourced changes, terminal/live changes and journal removal',()=>{
  const f=fixture();try{
   const bad=f.row('bad',[{action:'exclude',id:'A2'}],'The supervisor proposes skipping notification.');assert.throws(()=>append(f.run,f.binding,bad),/quote is absent/);
   const agent=f.row('agent',[{action:'exclude',id:'A2'}]);agent.authority.role='assistant';assert.throws(()=>append(f.run,f.binding,agent),/human user quote/);
   save(path.join(f.run,'watcher.lock'),{pid:process.pid});assert.throws(()=>append(f.run,f.binding,f.row('busy',[{action:'exclude',id:'A2'}])),/writer is active/);fs.unlinkSync(path.join(f.run,'watcher.lock'));
   save(path.join(f.run,'daemon-state.json'),{phase:'watching',inflight:{key:'saved'}});assert.throws(()=>append(f.run,f.binding,f.row('flight',[{action:'exclude',id:'A2'}])),/reconcile delivery/);
   save(path.join(f.run,'daemon-state.json'),{phase:'idle'});append(f.run,f.binding,f.row('scope',[{action:'exclude',id:'A2'}]));
   fs.renameSync(path.join(f.run,'contract-amendments.jsonl'),path.join(f.run,'saved-journal'));assert.throws(()=>effective(f.run,f.binding),/journal is missing/);
   fs.renameSync(path.join(f.run,'saved-journal'),path.join(f.run,'contract-amendments.jsonl'));fs.appendFileSync(path.join(f.run,'contract-amendments.jsonl'),' ');assert.throws(()=>effective(f.run,f.binding),/journal changed/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 test(skill+' accepts only the revised active scope and still rejects a missing real notification',()=>{
  const f=fixture();try{
   append(f.run,f.binding,f.row('scope',[{action:'exclude',id:'A2'}]));const contract=effective(f.run,f.binding);
   const candidate=path.join(f.root,'candidate.txt'),manifest=path.join(f.root,'candidate.json');fs.writeFileSync(candidate,'Real accepted candidate');save(manifest,{files:[{path:candidate,sha256:sha(candidate)}]});
   const event={id:'submission',kind:'submission',revision:'sha256:'+sha(manifest),manifest};
   const result=id=>({id,status:'PASS',method:'Read independent real evidence',expected:'Complete',actual:'Complete',evidence:[{path:candidate,sha256:sha(candidate)}]});
   const decision={eventId:event.id,disposition:'accept',revision:event.revision,contractStateSha256:contract.contractStateSha256,results:[result('A1'),result('A3')]};
   assert.equal(validateDecision(f.binding,contract,event,decision).disposition,'accept');
   assert.throws(()=>validateDecision(f.binding,contract,event,{...decision,results:[result('A1')]}),/Incomplete acceptance table/);
   assert.throws(()=>validateDecision(f.binding,contract,event,{...decision,results:[result('A1'),{...result('A3'),status:'FAIL'}]}),/not independently passed/);
   assert.throws(()=>validateDecision(f.binding,contract,event,{...decision,contractStateSha256:'old'}),/current effective contract/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 test(skill+' attaches acceptance at a safe point without inventing passes or discarding the executor snapshot',()=>{
  const f=fixture();try{
   append(f.run,f.binding,f.row('scope',[{action:'exclude',id:'A2'}]));
   const snapshot={schemaVersion:1,executorId:f.binding.executorId,planningRevision:'legacy-plan',activity:'waiting',capacity:{verified:0,evidence:['saved executor snapshot']},packages:{ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]}};
   save(path.join(f.run,'dispatch.json'),snapshot);
   const progress={revision:'actual-candidate',items:[{id:'A1',status:'PENDING',evidence:['original result awaits independent judgment']},{id:'A2',status:'EXCLUDED',evidence:['scope amendment source']},{id:'A3',status:'FAIL',evidence:['one of two notifications received']}]};
   assert.equal(attachAcceptance(f.run,f.binding,progress).attached,true);
   const saved=JSON.parse(fs.readFileSync(path.join(f.run,'dispatch.json')));assert.deepEqual(saved.packages,snapshot.packages);assert.deepEqual(saved.acceptance,progress);
   assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'binding.json'))).dispatchAudit.acceptance,true);
   assert.equal(require(path.join(scripts,'acceptance-audit.cjs')).summarize(f.run,progress).items.filter(c=>c.status==='PASS').length,0);
   assert.throws(()=>attachAcceptance(f.run,f.binding,{...progress,items:progress.items.map(c=>({...c,status:'EXCLUDED'}))}),/invalid acceptance status/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 // 2026-10-13 the GDB task moved from Codex to Claude with a contract rebuilt from the effective view: Jay's grants
 // (among them「代我回答所有執行對話」) stayed behind and the new supervisor sent Jay five decision cards in 7.5 hours.
 // A continuing run carries every registered grant with its quote, locator and source hash, and Jay's open questions,
 // or refuses to start and names every broken source at once.
 test(skill+' carries the locked contract, every user grant and the open questions to a continuing run, or names every broken source',()=>{
  const f=fixture();try{
   append(f.run,f.binding,f.row('delegation',[{action:'authorization',id:'visual',scope:'visual selection',instruction:'Delegate visual judgment until completion.'}],'Delegate visual judgment until completion.'));
   append(f.run,f.binding,f.row('scope',[{action:'exclude',id:'A2'}]));
   save(path.join(f.run,'pending-decisions.json'),{schema:1,items:[{key:'r24',kind:'credential',status:'open',ask:'Re-login uat2 and uat3?'}]});
   const before=effective(f.run,f.binding),saved=fs.readdirSync(f.run).map(name=>[name,sha(path.join(f.run,name))]);
   const carried=inherit(f.run,[f.root]);
   assert.deepEqual(carried.summary.amendments,['delegation','scope']);assert.deepEqual(carried.summary.authorizationUpdates,['visual']);
   assert.ok(carried.files.includes('pending-decisions.json'),'an unanswered question moves with the task instead of being asked again');
   const next=path.join(f.root,'next');fs.mkdirSync(next);for(const name of carried.files)fs.copyFileSync(path.join(f.run,name),path.join(next,name));
   const binding={...f.binding,allowedRoots:[f.root],contractSha256:sha(path.join(next,'contract.json')),contractStateSha256:carried.contractStateSha256};
   save(path.join(next,'binding.json'),binding);save(path.join(next,'daemon-state.json'),{phase:'idle',pending:null,inflight:null});
   const after=effective(next,binding);
   assert.equal(after.contractStateSha256,before.contractStateSha256);assert.deepEqual(after.authorizationUpdates,before.authorizationUpdates);
   assert.deepEqual(after.excluded.map(c=>c.id),['A2']);
   // A new grant in the continuing run chains after the carried journal and keeps the carried one.
   append(next,binding,f.row('later',[{action:'authorization',id:'judge',scope:'answers',instruction:'Evaluate the revised answer by its correct next step.'}],'Evaluate the revised answer by its correct next step.'));
   assert.deepEqual(effective(next,binding).authorizationUpdates.map(u=>u.id),['visual','judge']);
   assert.deepEqual(fs.readdirSync(f.run).map(name=>[name,sha(path.join(f.run,name))]),saved,'the old run is left as it was');
   assert.throws(()=>inherit(f.run,[next]),error=>/delegation user source outside allowed roots/.test(error.message)&&/scope user source outside allowed roots/.test(error.message));
   fs.appendFileSync(f.source,'edited after the grant\n');
   assert.throws(()=>inherit(f.run,[f.root]),error=>/locked source missing or changed/.test(error.message)&&/delegation user source missing or changed/.test(error.message)&&/scope user source missing or changed/.test(error.message));
   save(path.join(f.run,'watcher.lock'),{pid:process.pid});assert.throws(()=>inherit(f.run,[f.root]),/writer is active: watcher.lock/);fs.unlinkSync(path.join(f.run,'watcher.lock'));
   // The Codex run-watch parent would relaunch the old watcher after the copy.
   save(path.join(f.run,'runtime-state.json'),{pid:process.pid,launches:[]});assert.throws(()=>inherit(f.run,[f.root]),/writer is active: runtime-state.json/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 test(skill+' starts a run from a new contract or from the run it continues, never from a rebuilt contract',()=>{
  const f=fixture();try{
   append(f.run,f.binding,f.row('delegation',[{action:'authorization',id:'visual',scope:'visual selection',instruction:'Delegate visual judgment until completion.'}],'Delegate visual judgment until completion.'));
   // effective-contract output carries the grants without their journal; the next amendment would drop them.
   assert.throws(()=>startContract({contract:effective(f.run,f.binding),allowedRoots:[f.root]}),/rebuilt from effective-contract \(authorizationUpdates, excluded, contractStateSha256\); continue the old run with inheritFrom/);
   assert.throws(()=>startContract({contract:f.contract,inheritFrom:f.run,allowedRoots:[f.root]}),/either a new contract or inheritFrom/);
   assert.throws(()=>startContract({allowedRoots:[f.root]}),/either a new contract or inheritFrom/);
   assert.deepEqual(startContract({contract:f.contract,allowedRoots:[f.root]}),{contract:f.contract,inherited:null});
   const started=startContract({inheritFrom:f.run,allowedRoots:[f.root]});
   assert.deepEqual(started.contract,f.contract);assert.deepEqual(started.inherited.summary.authorizationUpdates,['visual']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
}
