const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const base=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const {observeSelfWork,correlate,selfWorkOf}=require(path.join(base,'activity-correlation.cjs'));
const audit=require(path.join(base,'dispatch-audit.cjs'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-activity-test-'));
const tool=(name,input,id='call')=>({type:'tool_use',name,id,input});
const said=(uuid,text)=>({type:'user',uuid,timestamp:'2026-11-26T10:00:00Z',message:{content:text}});
const did=(id,block,at='2026-11-26T10:01:00Z')=>({type:'assistant',uuid:'row-'+id,timestamp:at,message:{content:[{...block,id}]}});
// Runs the hook the way Claude Code does: the hook JSON on stdin, the decision on stdout.
function hookOut(input){
  const result=spawnSync(process.execPath,[path.join(base,'activity-correlation.cjs'),'hook'],{input:JSON.stringify(input),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim()?JSON.parse(result.stdout):null;
}
try{
  // Jay 2026-11-26 decision 31: the mainline does not edit code or configuration, run tests or sleep; documents, status
  // and work package files, evidence and supervisor run inputs are its own paperwork, and Git merges are its own job.
  const run=path.join(dir,'run');fs.mkdirSync(run);fs.writeFileSync(path.join(run,'binding.json'),'{}');fs.writeFileSync(path.join(run,'contract.json'),'{}');
  assert.equal(selfWorkOf(tool('Edit',{file_path:'/repo/src/app.ts'})).kind,'edit');
  assert.equal(selfWorkOf(tool('Write',{file_path:'/repo/config/app.json'})).kind,'edit','configuration counts');
  assert.equal(selfWorkOf(tool('Write',{file_path:'/repo/.claude/long-task/qa/state.md'})),null);
  assert.equal(selfWorkOf(tool('Write',{file_path:'/repo/.claude/long-task/qa/wp/B1.json'})),null,'work package files are not code');
  assert.equal(selfWorkOf(tool('Write',{file_path:path.join(run,'events','e1.json')})),null,'event inputs in the run are not code');
  assert.equal(selfWorkOf(tool('Bash',{command:'cd /repo && npm test'})).kind,'test');
  assert.equal(selfWorkOf(tool('Bash',{command:'sleep 120'})).kind,'sleep');
  assert.equal(selfWorkOf(tool('Bash',{command:"sed -i '' s/a/b/ src/x.ts"})).kind,'edit');
  assert.equal(selfWorkOf(tool('Bash',{command:'git merge --no-ff wp-b1 && git commit -m x'})),null,'merging and committing stay with the mainline');
  assert.equal(selfWorkOf(tool('Read',{file_path:'/repo/src/app.ts'})),null);
  assert.equal(selfWorkOf(tool('Write',{file_path:'/repo/docs/說明.md'})),null,'documents are not code');
  // Looking for a runner is not running it (2026-11-26 工區 E: a process check was taken for a test run and would have
  // woken the supervisor on the next one): quoted text, here-document bodies and other commands' arguments are data.
  const LOOKUPS=["ps aux | grep -E 'buildx|vitest|v12_shoot|playwright' | grep -v grep | head -20",'pgrep -fl vitest',
    'git commit -m "fix npm test flake"',"rg -n 'sed -i' scripts",'echo "sleep 5 while waiting"',
    "cat > notes.sh <<'EOF'\nnpm test\nsleep 30\nEOF\nchmod +x notes.sh"];
  const RUNS={test:['CI=1 npx vitest run src','bash -lc "cd /repo && pytest -q"','timeout 600 make check','python3 /skills/test-run.py --run R'],
    sleep:['cd "/repo dir" && sleep 30','while true; do curl -s localhost:3000/health; sleep 5; done'],edit:["perl -pi -e 's/a/b/' src/x.ts",'git checkout --theirs -- src/x.ts']};
  for(const command of LOOKUPS)assert.equal(selfWorkOf(tool('Bash',{command})),null,command);
  for(const [kind,cmds] of Object.entries(RUNS))for(const command of cmds)assert.equal(selfWorkOf(tool('Bash',{command}))?.kind,kind,command);

  // The watcher counts per turn and keeps no paths or commands; the second hand-done call of a turn is the review.
  const binding={executorId:'executor',executorLog:path.join(dir,'executor.jsonl'),createdAt:'2026-11-02T00:00:00Z',dispatchAudit:{enabled:true}};
  const snapshot={schemaVersion:1,executorId:'executor',planningRevision:'v1',activity:'working',capacity:{verified:2,evidence:['test']},
    packages:{ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]}};
  const state={};
  observeSelfWork(state,did('early',tool('Edit',{file_path:'/private/early.py'})));
  assert.equal(state.selfWork,undefined,'nothing is counted before the first turn the watcher sees');
  observeSelfWork(state,said('turn-1','繼續'));
  observeSelfWork(state,did('first',tool('Edit',{file_path:'/private/TOP-SECRET.py'})));
  observeSelfWork(state,did('first',tool('Edit',{file_path:'/private/TOP-SECRET.py'})));
  observeSelfWork(state,{...did('side',tool('Bash',{command:'npm test'})),isSidechain:true});
  assert.deepEqual(correlate(snapshot,state,binding,[]),[],'the first one only got the hook note');
  observeSelfWork(state,did('second',tool('Bash',{command:'npm test -- TOP-SECRET'})));
  const clue=correlate(snapshot,state,binding,[])[0];
  assert.equal(clue.kind,'self_work');assert.deepEqual(clue.affected,['turn:turn-1']);
  assert.deepEqual(clue.detail.hits.map(hit=>[hit.kind,hit.callId]),[['edit','first'],['test','second']]);
  assert(!JSON.stringify(state).includes('TOP-SECRET'),'no file paths or commands are stored');
  // One review per turn: the audit announces it once, and a new turn starts a new count.
  fs.writeFileSync(path.join(dir,'dispatch.json'),JSON.stringify(snapshot));
  const own={selfWork:state.selfWork};let found=audit.inspect(dir,binding,own);
  assert.equal(found.newIssues.filter(x=>x.kind==='self_work').length,1);
  audit.markAnnounced(own,audit.eventFor(found));
  observeSelfWork(own,did('third',tool('Bash',{command:'sleep 30'})));
  found=audit.inspect(dir,binding,own);assert.equal(found.newIssues.filter(x=>x.kind==='self_work').length,0,'more work in the same turn does not wake again');
  observeSelfWork(own,said('turn-2','監督回覆'));
  assert.equal(audit.inspect(dir,binding,own).issues.filter(x=>x.kind==='self_work').length,0);

  // The hook is the first notice (decision 35): it answers only the bound executor's own calls, once per turn.
  const transcript=path.join(dir,'executor-hook.jsonl');
  const write=rows=>fs.writeFileSync(transcript,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const ask=(id,name,input,extra={})=>hookOut({hook_event_name:'PreToolUse',tool_name:name,tool_input:input,tool_use_id:id,transcript_path:transcript,...extra});
  const bind=said('bind','LONG_TASK_BIND:12345678-1234-1234-1234-123456789abc\n依契約執行');
  // The hook reads the transcript backwards in 1 MB chunks. Here the turn's first message itself straddles the 1 MB edge,
  // so it is found only when the two halves are joined; missing it would count the previous turn's test against this one.
  const longTurn=said('turn-1','繼續'+'續'.repeat(3000)),call=did('t1',tool('Bash',{command:'npm test'}));
  const sized=bytes=>({type:'assistant',uuid:'filler',timestamp:'2026-11-26T09:59:00Z',message:{content:[{type:'text',text:'a'.repeat(bytes)}]}});
  const overhead=Buffer.byteLength(JSON.stringify(sized(0))+'\n'+JSON.stringify(call)+'\n');
  write([bind,did('t0',tool('Bash',{command:'npm test'})),sized(1500000),longTurn,sized(1024*1024-overhead-4000),call]);
  const first=ask('t1','Bash',{command:'npm test'});
  assert.match(first.hookSpecificOutput.additionalContext,/^LONG_TASK_SELF_WORK/);
  assert.match(first.hookSpecificOutput.additionalContext,/跑測試：npm test/);
  assert.equal(first.hookSpecificOutput.hookEventName,'PreToolUse');
  write([bind,said('turn-1','繼續'),did('t1',tool('Bash',{command:'npm test'})),did('t2',tool('Bash',{command:'sleep 60'}))]);
  assert.equal(ask('t2','Bash',{command:'sleep 60'}),null,'the second in a turn is left to the watcher');
  // On a fresh turn, where a hand-done call would get the note, a subagent's call and a document write get none.
  write([bind,said('turn-1','繼續'),did('t9',tool('Bash',{command:'npm test'}))]);
  assert.equal(ask('t9','Bash',{command:'npm test'},{agent_id:'agent-1'}),null,'a subagent call is not the mainline');
  write([bind,said('turn-1','繼續'),did('t9',tool('Write',{file_path:'/repo/docs/說明.md'}))]);
  assert.equal(ask('t9','Write',{file_path:'/repo/docs/說明.md'}),null,'documents are not code');
  write([bind,said('turn-1','繼續'),did('t1',tool('Bash',{command:'npm test'})),said('turn-2','監督回覆'),did('t3',tool('Edit',{file_path:'/repo/src/a.ts'}))]);
  assert.match(ask('t3','Edit',{file_path:'/repo/src/a.ts'}).hookSpecificOutput.additionalContext,/改程式或設定：\/repo\/src\/a.ts/,'a new turn gets its own note');
  write([said('plain','一般對話'),did('t4',tool('Bash',{command:'npm test'}))]);
  assert.equal(ask('t4','Bash',{command:'npm test'}),null,'sessions that are not a supervised executor are untouched');

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
  console.log('PASS: hand-done work classification, one note and one review per turn, privacy, hook scope, agent status and stale-event checks');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
