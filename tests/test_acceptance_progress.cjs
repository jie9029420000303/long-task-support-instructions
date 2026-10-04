const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const roots=['claude-code/.claude','codex/.agents'].map(p=>path.resolve(__dirname,'..',p,'skills/long-task-supervisor/scripts'));
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)+'\n');
function fixture(scripts){
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-progress-'));
  const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const source=path.join(run,'source.txt');fs.writeFileSync(source,'isolated acceptance fixture');
  save(path.join(run,'contract.json'),{goal:'isolated audit',authorization:'temporary test only',criteria:[{id:'A1',requirement:'test',source:'source:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
  const prompt=path.join(run,'executor-prompt.txt');fs.writeFileSync(prompt,'isolated test');
  const binding={platform:'claude-code',executorId:'executor',executorDesktopId:'local_'+crypto.randomUUID(),projectRoot:run,allowedRoots:[run],contractSha256:sha(path.join(run,'contract.json')),promptSha256:sha(prompt),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
  save(path.join(run,'binding.json'),binding);
  const snapshot={schemaVersion:1,executorId:'executor',planningRevision:'plan-1',activity:'working',capacity:{verified:0,evidence:['platform']},packages:{ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]},acceptance:{revision:'r1',items:[{id:'A1',status:'PENDING',evidence:['contract:A1']}]}};
  const input=path.join(run,'input.json');
  const write=()=>{save(input,snapshot);return execFileSync(process.execPath,[path.join(scripts,'dispatch.cjs'),'write',run,input],{stdio:'pipe'});};
  const attempt=(id,outcome='INCONCLUSIVE',caseId='Q09')=>{snapshot.acceptance.items[0].lastAttempt={id,caseId,revision:snapshot.acceptance.revision,outcome,reason:'measured result',evidence:['result:'+id],startedAt:'2026-10-03T10:00:00Z',finishedAt:'2026-10-03T10:02:00Z'};write();};
  return {run,binding,snapshot,write,attempt,close:()=>fs.rmSync(run,{recursive:true,force:true})};
}
test('both adapters ship the same deterministic acceptance audit',()=>assert.deepEqual(fs.readFileSync(path.join(roots[0],'acceptance-audit.cjs')),fs.readFileSync(path.join(roots[1],'acceptance-audit.cjs'))));
for(const scripts of roots){
  const label=scripts.includes('claude-code')?'Claude':'Codex';
  test(label+': retries persist once, results cannot be rewritten, and inconclusive runs cannot become passes',()=>{
    const f=fixture(scripts),a=require(path.join(scripts,'acceptance-audit.cjs'));
    try{f.attempt('t1');f.write();const row=a.summarize(f.run,f.snapshot.acceptance).items[0].cases[0];assert.equal(row.attempts,1);assert.equal(row.passAttempts,0);assert.equal(row.consecutivePasses,0);assert.equal(row.medianSeconds,120);
      f.snapshot.acceptance.items[0].lastAttempt.outcome='PASS';assert.throws(f.write,/Command failed/);assert.equal(a.summarize(f.run,JSON.parse(fs.readFileSync(path.join(f.run,'dispatch.json'))).acceptance).items[0].cases[0].passAttempts,0);
    }finally{f.close();}
  });
  test(label+': changing plan wording and package IDs cannot conceal recurring failures; different cases stay separate',()=>{
    const f=fixture(scripts),audit=require(path.join(scripts,'dispatch-audit.cjs')),state={};
    try{f.attempt('t1');f.attempt('t2','FAIL','Q10');assert.equal(audit.inspect(f.run,f.binding,state).issues.length,0);
      f.snapshot.planningRevision='renamed';f.attempt('t3');const result=audit.inspect(f.run,f.binding,state);assert.equal(result.newIssues[0].kind,'acceptance_rework');assert.equal(result.newIssues[0].detail.caseId,'Q09');
      audit.markAnnounced(state,audit.eventFor(result));f.attempt('t4');assert.equal(audit.inspect(f.run,f.binding,state).newIssues.length,0);
      f.attempt('t5','PASS');assert.equal(audit.inspect(f.run,f.binding,state).issues.length,0);
      f.attempt('t6');f.attempt('t7');assert.equal(audit.inspect(f.run,f.binding,state).newIssues.length,1);
    }finally{f.close();}
  });
  test(label+': withdrawing PASS is actionable and stale advice is cancelled after evidence is restored',()=>{
    const f=fixture(scripts),audit=require(path.join(scripts,'dispatch-audit.cjs')),state={};
    try{f.snapshot.acceptance.items[0].status='PASS';f.attempt('t1','PASS');audit.inspect(f.run,f.binding,state);
      f.snapshot.acceptance.items[0].status='PENDING';f.write();const e=audit.eventFor(audit.inspect(f.run,f.binding,state));assert.equal(e.issues[0].kind,'acceptance_withdrawn');audit.markAnnounced(state,e);
      f.snapshot.acceptance.items[0].status='PASS';f.write();assert.equal(audit.stillCurrent(f.run,f.binding,state,e).current,false);
    }finally{f.close();}
  });
  test(label+': a candidate change resets affected continuous passes and retains unaffected counts with an impact record',()=>{
    const f=fixture(scripts),a=require(path.join(scripts,'acceptance-audit.cjs'));
    try{f.attempt('q9','PASS');f.attempt('q10','PASS','Q10');f.snapshot.acceptance.revision='r2';assert.throws(f.write,/Command failed/);
      f.snapshot.acceptance.change={id:'change-1',fromRevision:'r1',toRevision:'r2',affectedCaseIds:['Q09'],requiredRegressionCaseIds:[],impactEvidence:['diff:r1..r2'],policyEvidence:['approved:test-policy']};f.write();
      const cases=a.summarize(f.run,f.snapshot.acceptance).items[0].cases;assert.equal(cases.find(c=>c.caseId==='Q09').consecutivePasses,0);assert.equal(cases.find(c=>c.caseId==='Q10').consecutivePasses,1);
      f.snapshot.acceptance.change.affectedCaseIds=[];assert.throws(f.write,/Command failed/);
    }finally{f.close();}
  });
  test(label+': legacy runs remain compatible, while enabled progress cannot silently disappear or omit criteria',()=>{
    const f=fixture(scripts);
    try{delete f.snapshot.acceptance;f.write();f.binding.dispatchAudit.acceptance=true;save(path.join(f.run,'binding.json'),f.binding);assert.throws(f.write,/Command failed/);
      f.snapshot.acceptance={revision:'r1',items:[]};assert.throws(f.write,/Command failed/);
    }finally{f.close();}
  });
  test(label+': delayed results from invalidated revisions cannot satisfy new passes or clear new failures',()=>{
    const f=fixture(scripts),a=require(path.join(scripts,'acceptance-audit.cjs'));
    try{f.attempt('old-pass','PASS');f.snapshot.acceptance.revision='r2';f.snapshot.acceptance.change={id:'change-1',fromRevision:'r1',toRevision:'r2',affectedCaseIds:['Q09'],requiredRegressionCaseIds:['Q10'],impactEvidence:['diff:r1..r2'],policyEvidence:['contract']};f.write();
      f.attempt('new-fail','FAIL');f.snapshot.acceptance.items[0].lastAttempt={...f.snapshot.acceptance.items[0].lastAttempt,id:'late-pass',revision:'r1',outcome:'PASS'};f.write();
      let cases=a.summarize(f.run,f.snapshot.acceptance).items[0].cases;assert.equal(cases[0].consecutivePasses,0);assert.equal(cases[0].unresolvedCount,1);assert.equal(cases[0].staleAttempts,1);
      f.snapshot.acceptance.items[0].status='PASS';assert.throws(f.write,/Command failed/);f.snapshot.acceptance.items[0].status='PENDING';
      f.snapshot.acceptance.items[0].lastAttempt={...f.snapshot.acceptance.items[0].lastAttempt,id:'late-regression',caseId:'Q10'};f.write();assert.equal(a.summarize(f.run,f.snapshot.acceptance).items[0].cases.find(c=>c.caseId==='Q10').consecutivePasses,0);
      f.attempt('new-pass','PASS');cases=a.summarize(f.run,f.snapshot.acceptance).items[0].cases;assert.equal(cases[0].consecutivePasses,1);assert.equal(cases[0].unresolvedCount,0);
    }finally{f.close();}
  });
  test(label+': missing or truncated history is diagnosed without replacing saved evidence or silently restarting counts',()=>{
    const f=fixture(scripts),a=require(path.join(scripts,'acceptance-audit.cjs')),audit=require(path.join(scripts,'dispatch-audit.cjs'));
    try{f.attempt('t1');f.attempt('t2');const journal=path.join(f.run,'acceptance-history.jsonl'),saved=fs.readFileSync(journal),snapshot=fs.readFileSync(path.join(f.run,'dispatch.json'));
      fs.unlinkSync(journal);assert.throws(()=>a.summarize(f.run,f.snapshot.acceptance),/history is missing/);assert.equal(audit.inspect(f.run,f.binding,{}).issues[0].kind,'snapshot_invalid');assert.throws(f.write,/Command failed/);assert.equal(fs.existsSync(journal),false);assert.deepEqual(fs.readFileSync(path.join(f.run,'dispatch.json')),snapshot);
      const progress=f.snapshot.acceptance;delete f.snapshot.acceptance;assert.throws(f.write,/Command failed/);f.snapshot.acceptance=progress;
      fs.writeFileSync(journal,saved.toString().split('\n').slice(0,2).join('\n')+'\n');assert.throws(()=>a.summarize(f.run,f.snapshot.acceptance),/does not cover saved attempt/);assert.throws(f.write,/Command failed/);
      fs.writeFileSync(journal,saved);f.write();assert.equal(a.summarize(f.run,f.snapshot.acceptance).items[0].cases[0].attempts,2);assert.equal(audit.inspect(f.run,f.binding,{}).issues[0].kind,'acceptance_rework');
    }finally{f.close();}
  });
  test(label+': custom snapshot paths enforce the same impact mapping and recovery checks',()=>{
    const f=fixture(scripts);
    try{f.binding.dispatchAudit.snapshot='custom-progress.json';save(path.join(f.run,'binding.json'),f.binding);f.attempt('t1','PASS');f.snapshot.acceptance.revision='r2';assert.throws(f.write,/Command failed/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'custom-progress.json'))).acceptance.revision,'r1');}
    finally{f.close();}
  });
  test(label+': recovery and a new rework episode remain actionable even when no poll sees the intermediate PASS',()=>{
    const f=fixture(scripts),audit=require(path.join(scripts,'dispatch-audit.cjs')),state={};
    try{f.attempt('t1');f.attempt('t2');const first=audit.eventFor(audit.inspect(f.run,f.binding,state));audit.markAnnounced(state,first);
      f.snapshot.acceptance.items[0].status='PASS';f.attempt('t3','PASS');f.snapshot.acceptance.items[0].status='INCONCLUSIVE';f.attempt('t4');f.attempt('t5');const second=audit.eventFor(audit.inspect(f.run,f.binding,state));assert.ok(second);assert.notEqual(first.id,second.id);assert.ok(second.issues.some(i=>i.kind==='acceptance_rework'));audit.markAnnounced(state,second);
      f.attempt('t6');assert.equal(audit.eventFor(audit.inspect(f.run,f.binding,state)),null);
      f.snapshot.acceptance.items[0].status='PASS';f.attempt('t7','PASS');f.snapshot.acceptance.items[0].status='PENDING';f.write();assert.ok(audit.inspect(f.run,f.binding,state).newIssues.some(i=>i.kind==='acceptance_withdrawn'));
    }finally{f.close();}
  });
  test(label+': concurrent retries preserve one result and resume idempotently after overlap is rejected',async()=>{
    const f=fixture(scripts),a=require(path.join(scripts,'acceptance-audit.cjs'));
    try{f.attempt('t1','PASS');const input=path.join(f.run,'input.json');f.snapshot.acceptance.items[0].lastAttempt={...f.snapshot.acceptance.items[0].lastAttempt,id:'t2'};save(input,f.snapshot);
      const results=await Promise.all(Array.from({length:12},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(scripts,'dispatch.cjs'),'write',f.run,input],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);child.once('error',reject);const timer=setTimeout(()=>{child.kill();reject(Error('writer timeout'));},10000);child.once('exit',code=>{clearTimeout(timer);resolve({code,errors});});})));
      assert.ok(results.some(r=>r.code===0));assert.ok(results.every(r=>r.code===0||/Dispatch writer is active/.test(r.errors)));f.write();const trial=a.summarize(f.run,f.snapshot.acceptance).items[0].cases[0];assert.equal(trial.attempts,2);assert.equal(trial.consecutivePasses,2);assert.equal(fs.existsSync(path.join(f.run,'dispatch-write.lock')),false);
      fs.writeFileSync(path.join(f.run,'dispatch-write.lock'),JSON.stringify({pid:process.pid}));assert.throws(f.write,/Command failed/);assert.equal(a.summarize(f.run,f.snapshot.acceptance).items[0].cases[0].attempts,2);
    }finally{f.close();}
  });
  test(label+': a multi-case summary remains complete JSON when read through a process pipe',()=>{
    const f=fixture(scripts);
    try{for(let i=0;i<40;i++)f.attempt('attempt-'+i,'PASS','real-client-journey-'+i);
      const output=execFileSync(process.execPath,[path.join(scripts,'dispatch.cjs'),'summary',f.run],{encoding:'utf8'});const summary=JSON.parse(output);assert.equal(summary.items[0].cases.length,40);assert.ok(summary.items[0].cases.every(c=>c.consecutivePasses===1&&c.attempts===1));
    }finally{f.close();}
  });
}
test('real Claude watcher emits a review for journal-derived rework with an empty self-reported rework array',async()=>{
  const f=fixture(roots[0]),log=path.join(f.run,'executor.jsonl');fs.writeFileSync(log,'');f.binding.executorLog=log;save(path.join(f.run,'binding.json'),f.binding);save(path.join(f.run,'daemon-state.json'),{phase:'idle',executorOffset:0,seen:[],pending:null,reads:0});
  f.attempt('t1');f.attempt('t2');
  const child=spawn(process.execPath,[path.join(roots[0],'claude-watch.cjs'),f.run],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('watcher timeout'));},10000);child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('watcher failed '+code+': '+errors));});});assert.match(output,/LONG_TASK_WAKE/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending.issues[0].kind,'acceptance_rework');}
  finally{child.kill();f.close();}
});
