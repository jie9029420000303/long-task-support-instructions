const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const wake=require('../codex/.agents/skills/long-task-supervisor/scripts/execution-wake.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-wake-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ledger=path.join(root,'resources.json'),binding={allowedRoots:[root]},wait={event:{id:'waiting-turn',nextAction:'Read the actual test result',waitMinutes:20}};
  const save=value=>fs.writeFileSync(ledger,JSON.stringify({resources:value})+'\n');
  const resource={id:'r1',kind:'process',wp:'WP-TEST',start:new Date(Date.now()-1000).toISOString()};
  const snapshot={workPackageDirectory:path.join(root,'wp'),packages:{inFlight:[{id:'WP-TEST',handle:'main'}]}};
  save([resource]);return {root,ledger,binding,wait,save,resource,snapshot,inspect(receipts={}){return wake.inspect(binding,wait,snapshot,[],receipts);}};
}
test('a running test does not become ready merely because its declared wait expired',t=>{
  const f=fixture(t);f.wait.deadline=Date.now()-60000;
  const r=f.inspect();assert.equal(r.observable,true);assert.equal(r.ready.length,0);
});
test('the supervisor reviewing a wait sees which sources run, which finished and whether a result already went back',t=>{
  const f=fixture(t);let facts=wake.facts(f.inspect());
  assert.equal(facts.observable,true);assert.deepEqual(facts.finished,[]);
  assert.deepEqual(facts.running,[{kind:'resource',packageId:'WP-TEST',id:'r1',path:f.ledger}]);
  f.save([{...f.resource,stopped_at:new Date().toISOString(),note:'exit 1; secret-value-not-for-the-supervisor'}]);
  const r=f.inspect();facts=wake.facts(r);
  assert.equal(facts.running.length,0);assert.equal(facts.finished.length,1);assert.ok(facts.finished[0].finishedAt);
  assert.equal(facts.finished[0].delivered,undefined);
  facts=wake.facts(f.inspect({[r.ready[0].key]:{deliveredAt:new Date().toISOString()}}));
  assert.equal(facts.finished[0].delivered,true,'a result already sent to the executor is marked, so the supervisor does not resend it');
  assert.doesNotMatch(JSON.stringify(facts),/secret-value-not-for-the-supervisor/,'locations only, never contents');
  assert.deepEqual(wake.facts(wake.inspect(f.binding,{event:{id:'w',nextAction:'Read'}},null,[])),{observable:false,running:[],finished:[],issues:[]});
});
test('a finished process is ready before its estimated waiting time; failure is still an execution result',t=>{
  const f=fixture(t);f.wait.deadline=Date.now()+20*60000;
  f.save([{...f.resource,stopped_at:new Date().toISOString(),note:'exit 1; secret-value-not-for-the-message'}]);
  const r=f.inspect();assert.equal(r.ready.length,1);assert.equal(r.ready[0].packageId,'WP-TEST');
  const text=wake.prompt(f.wait.event,r);assert.match(text,/核對原始結果/);assert.doesNotMatch(text,/secret-value-not-for-the-message/);
});
test('the filesystem completion path reacts to an atomic ledger replacement',async t=>{
  const f=fixture(t),pending=wake.waitChange(3000,()=>f.inspect());
  setTimeout(()=>{const next=f.ledger+'.tmp';fs.writeFileSync(next,JSON.stringify({resources:[{...f.resource,stopped_at:new Date().toISOString()}]}));fs.renameSync(next,f.ledger);},30);
  assert.equal(await pending,'completion');
});
test('the periodic path rediscovers completion even when filesystem notifications are unavailable',async t=>{
  const f=fixture(t),watch=fs.watch;fs.watch=()=>{throw Error('No notification delivery');};
  try{
    const pending=wake.waitChange(80,()=>f.inspect());setTimeout(()=>f.save([{...f.resource,stopped_at:new Date().toISOString()}]),20);
    assert.equal(await pending,'periodic');assert.equal(f.inspect().ready.length,1);
  }finally{fs.watch=watch;}
});
test('a completion delivered by either path is not delivered again; a new run reusing r1 is distinct',t=>{
  const f=fixture(t);f.save([{...f.resource,stopped_at:new Date().toISOString()}]);const first=f.inspect().ready[0];
  const receipts={[first.key]:{deliveredAt:new Date().toISOString()}};
  assert.equal(f.inspect(receipts).ready.length,0);
  f.save([{...f.resource,start:new Date(Date.now()+1000).toISOString(),stopped_at:new Date(Date.now()+2000).toISOString()}]);
  assert.equal(f.inspect(receipts).ready.length,1);
});
test('another package and a finished previous phase cannot wake the current main-line wait',t=>{
  const f=fixture(t);f.snapshot.packages.inFlight[0].baseline={startedAt:new Date().toISOString()};
  f.save([{...f.resource,stopped_at:new Date(Date.now()-500).toISOString()},{...f.resource,id:'r2',wp:'OTHER',stopped_at:new Date().toISOString()}]);
  assert.equal(f.inspect().ready.length,0);
});
test('an explicit result can be absent when the wait starts and wake when it appears',async t=>{
  const f=fixture(t),result=path.join(f.root,'finished.json');f.snapshot.packages.inFlight=[];f.wait.event.waitFor=[{path:result,sha256:null}];
  assert.equal(f.inspect().ready.length,0);const pending=wake.waitChange(3000,()=>f.inspect());
  setTimeout(()=>fs.writeFileSync(result,'{"exit":1}\n'),30);assert.equal(await pending,'completion');assert.equal(f.inspect().ready.length,1);
});
test('explicit resources outside trusted roots, including a symlink escape, are never read as completion',t=>{
  const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'execution-other-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const file=path.join(outside,'result.json');fs.writeFileSync(file,'{"finished":true}\n');
  const link=path.join(f.root,'linked-result.json');fs.symlinkSync(file,link);
  for(const p of [file,link]){f.wait.event.waitFor=[{path:p,sha256:null}];const r=f.inspect();assert.equal(r.ready.length,0);assert.ok(r.issues.length);}
});
test('a completed registered child returns to its main line without treating other children as its result',t=>{
  const f=fixture(t);f.snapshot.packages.inFlight=[{id:'CHILD',handle:'agent:child-id'}];
  const agents=[{id:'child-id',done:true,startedAt:1,lastAt:1000},{id:'other-id',done:true,startedAt:2,lastAt:2000}];
  const r=wake.inspect(f.binding,f.wait,f.snapshot,agents);assert.equal(r.ready.length,1);assert.equal(r.ready[0].id,'child-id');
});

test('statistics appended after a real child task_complete do not become a second result',t=>{
  const f=fixture(t),pace=require('../codex/.agents/skills/long-task-supervisor/scripts/pace.cjs'),old=process.env.CODEX_HOME;
  process.env.CODEX_HOME=path.join(f.root,'codex');t.after(()=>{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;});
  const day=new Date(),dir=path.join(process.env.CODEX_HOME,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  const id=require('node:crypto').randomUUID(),file=path.join(dir,'rollout-'+id+'.jsonl');
  const row=(type,payload,at)=>({type,payload,timestamp:new Date(at).toISOString()});const at=Date.now();
  const rows=[row('session_meta',{id,thread_source:'subagent',session_id:'owner',parent_thread_id:'owner',agent_path:'/root/child'},at-2000),
    row('event_msg',{type:'task_started',turn_id:'first-turn'},at-1500),row('event_msg',{type:'task_complete',turn_id:'first-turn'},at-1000)];
  fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  Object.assign(f.binding,{executorId:'owner',createdAt:new Date(at-3000).toISOString()});f.snapshot.packages.inFlight=[{id:'CHILD',handle:'agent:'+id}];
  const check=receipts=>wake.inspect(f.binding,f.wait,f.snapshot,pace.agentRuns(f.binding),receipts);
  const first=check({}).ready[0];assert.ok(first);
  const receipts={[first.key]:{deliveredAt:new Date().toISOString()}};
  fs.appendFileSync(file,JSON.stringify(row('event_msg',{type:'token_count',info:{total_token_usage:{output_tokens:120}}},at))+'\n');
  assert.equal(check(receipts).ready.length,0);
  fs.appendFileSync(file,[row('event_msg',{type:'task_started',turn_id:'second-turn'},at+1000),row('event_msg',{type:'task_complete',turn_id:'second-turn'},at+2000)].map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(check(receipts).ready.length,1,'a real new child turn is still delivered');
});
