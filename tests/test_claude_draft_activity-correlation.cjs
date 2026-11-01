const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const base=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const {observeMainWrite,correlate,readHistory}=require(path.join(base,'activity-correlation.cjs'));
const audit=require(path.join(base,'dispatch-audit.cjs'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-activity-test-'));
try{
  const binding={executorId:'executor',executorLog:path.join(dir,'executor.jsonl'),createdAt:'2026-11-02T00:00:00Z',dispatchAudit:{enabled:true}};
  const snapshot={schemaVersion:1,executorId:'executor',planningRevision:'v1',activity:'working',capacity:{verified:2,evidence:['test']},
    packages:{ready:[],inFlight:[{id:'B',handle:'main',exclusiveResources:[],evidence:['test']}],returned:[],blocked:[],completed:[],recurringRework:[]}};
  fs.writeFileSync(path.join(dir,'dispatch-history.jsonl'),[
    {at:'2026-11-02T00:00:30Z',inFlight:[{id:'A',handle:'main'}]},
    {at:'2026-11-02T00:01:30Z',inFlight:[{id:'B',handle:'main'}]}
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const history=readHistory(dir),state={};
  const row=(callId,at)=>({type:'assistant',timestamp:at,uuid:'row-'+callId,message:{content:[{type:'tool_use',name:'Edit',id:callId,input:{file_path:'/private/example.py',old_string:'TOP-SECRET',new_string:'TOP-SECRET'}}]}});
  observeMainWrite(state,row('first','2026-11-02T00:01:00Z'),history);
  observeMainWrite(state,row('second','2026-11-02T00:02:00Z'),history);
  observeMainWrite(state,row('unknown','2026-11-02T00:00:10Z'),history);
  observeMainWrite(state,row('first','2026-11-02T00:01:00Z'),history);
  assert.equal(state.activityAudit.mainWrites.length,3,'multiple historical writes retained without duplicates');
  assert.deepEqual(state.activityAudit.mainWrites[0].precedingMainIds,['A']);
  assert.deepEqual(state.activityAudit.mainWrites[1].precedingMainIds,['B']);
  assert.equal(state.activityAudit.mainWrites[2].precedingMainIds,null,'no earlier historical snapshot is unknown');
  assert(!JSON.stringify(state).includes('TOP-SECRET'));
  assert(!JSON.stringify(state).includes('/private/example.py'));
  assert.equal(correlate(snapshot,state,binding,[])[0].detail.observations.length,3,'later snapshot cannot overwrite prior attribution clues');
  const sidechain={...row('side','2026-11-02T00:02:00Z'),isSidechain:true};observeMainWrite(state,sidechain,history);
  const unknown={};observeMainWrite(unknown,{...row('bash','2026-11-02T00:02:00Z'),message:{content:[{type:'tool_use',name:'Bash',id:'x',input:{command:'edit code'}}]}},history);
  assert.equal(unknown.activityAudit,undefined);
  const started=Date.parse('2026-11-02T00:02:00Z'),runs=[{id:'a',startedAt:started,lastAt:started,done:false},{id:'b',startedAt:started,lastAt:started,done:true}];
  snapshot.packages.inFlight=[{id:'P',handle:'agent:b',exclusiveResources:[],evidence:['test']}];
  assert.deepEqual(correlate(snapshot,{},binding,runs).map(x=>x.kind).sort(),['agent_finished_inflight','agent_untracked']);
  snapshot.packages.inFlight.push({id:'A',handle:'agent:a',exclusiveResources:[],evidence:['test']});
  assert.deepEqual(correlate(snapshot,{},binding,runs).map(x=>x.kind),['agent_finished_inflight']);
  fs.mkdirSync(path.join(dir,'executor','subagents'),{recursive:true});
  fs.writeFileSync(path.join(dir,'executor','subagents','agent-a.jsonl'),JSON.stringify({type:'assistant',timestamp:'2026-11-02T00:02:00Z',message:{model:'model',stop_reason:'tool_use'}})+'\n');
  snapshot.packages.inFlight=[];fs.writeFileSync(path.join(dir,'dispatch.json'),JSON.stringify(snapshot));
  const monitor={};let result=audit.inspect(dir,binding,monitor);
  assert.equal(result.newIssues.filter(x=>x.kind==='agent_untracked').length,1);
  const event=audit.eventFor(result);audit.markAnnounced(monitor,event);
  result=audit.inspect(dir,binding,monitor);assert.equal(result.newIssues.filter(x=>x.kind==='agent_untracked').length,0);
  snapshot.packages.inFlight=[{id:'A',handle:'agent:a',exclusiveResources:[],evidence:['test']}];
  fs.writeFileSync(path.join(dir,'dispatch.json'),JSON.stringify(snapshot));
  assert.equal(audit.stillCurrent(dir,binding,monitor,event).current,false);
  fs.appendFileSync(path.join(dir,'executor','subagents','agent-a.jsonl'),JSON.stringify({type:'assistant',timestamp:'2026-11-02T00:03:00Z',message:{model:'model',stop_reason:'end_turn'}})+'\n');
  result=audit.inspect(dir,binding,monitor);
  assert.equal(result.issues.filter(x=>x.kind==='agent_finished_inflight').length,1,'changed transcript must invalidate cache');
  console.log('PASS: historic snapshot ordering, missing history, multiple pending writes, privacy, agent status and stale-event checks');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
