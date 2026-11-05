const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const parallel=require('../codex/.agents/skills/long-task-supervisor/scripts/parallel-test.cjs');
const clock=require('../codex/.agents/skills/long-task-supervisor/scripts/supervisor-clock.cjs');
const at='2026-11-05T00:57:09.000Z',source={path:'/tmp/synthetic-executor.jsonl',offset:120};
const call=(id,command)=>({timestamp:at,type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:id,arguments:JSON.stringify({cmd:command})}});
const output=(id,value)=>({type:'response_item',payload:{type:'function_call_output',call_id:id,output:value}});
const once=()=>{const seen=new Set();return key=>!seen.has(key)&&(seen.add(key),true);};

test('only an actual, identifiable complete gate invocation or explicit test marker is a lead',()=>{
  // De-identified structure of A's 11/05 shell invocation: variable assignments, then bash and a named gate script.
  assert.equal(parallel.recognizable('RESULT_DIR="${TMPDIR}/report" RUN_ID=sample bash scripts/deploy-gate.sh'),true);
  assert.equal(parallel.recognizable('# LONG_TASK_LONG_TEST\nnode --test tests/unit/*.cjs'),true);
  assert.equal(parallel.recognizable("# LONG_TASK_LONG_TEST\nnode - <<'JS'\nconsole.log(1)\nJS"),true);
  for(const command of ['npm test','node --test tests/one.cjs','cat scripts/deploy-gate.sh',
    'rg deploy-gate.sh scripts','echo "bash scripts/deploy-gate.sh"',
    "cat <<'EOF'\nbash scripts/deploy-gate.sh\nEOF",'echo "# LONG_TASK_LONG_TEST"',
    '# LONG_TASK_LONG_TEST\n'])assert.equal(parallel.recognizable(command),false,command);
  assert.equal(parallel.recognizable("# LONG_TASK_LONG_TEST\n<<'EOF'\nnode tests/full-gate.sh\nEOF"),false,'heredoc without an actual command is not a test invocation');
});

test('code-mode examples, comments, dead branches and callbacks are not treated as real tool calls',()=>{
  const bad=[
    'text(\'cmd: "bash scripts/deploy-gate.sh"\')',
    '// await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})\ntext("note")',
    '/* await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"}) */',
    'if(false){await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})}',
    'false && await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})',
    'const f=async()=>await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})',
    'function f(){return tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})}',
    'const example=/await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})/;',
    'const example=`literal ${`await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"})`}`;',
    'const a={cmd:"bash scripts/deploy-gate.sh"}; text(a)',
  ];
  for(const input of bad){const state={},row={timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'not-real',input}};
    parallel.track(state,row,clock.commandsOf(row.payload),source);parallel.track(state,output('not-real','Script running with cell ID fake:code'),[],source);
    assert.deepEqual(parallel.leads(state,once()),[]);}
  assert.deepEqual(parallel.wrapperCommands('const r=await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"});text(r);'),['bash scripts/deploy-gate.sh']);
});

test('quick completion, denial and arbitrary stdout never create a background-test lead',()=>{
  for(const outputValue of [
    'Script completed\nstdout: session id: 123',
    [{type:'text',text:'Script completed'},{type:'text',text:'Script running with cell ID invented'}],
    'Auto-review denied: rejected due to unacceptable risk',
    JSON.stringify({exit_code:0,output:'session id: 123'}),
  ]){
    const state={},row=call('quick','bash scripts/deploy-gate.sh');parallel.track(state,row,clock.commandsOf(row.payload),source);
    assert.deepEqual(parallel.leads(state,once()),[],'a submitted call alone is not proof of execution');
    parallel.track(state,output('quick',outputValue),[],source);
    assert.deepEqual(parallel.leads(state,once()),[]);
  }
});

test('a real outer running-cell signal yields one safe, verifiable lead and clears when the cell ends',()=>{
  const state={},secret='synthetic-password-for-test-only',cmd='TOKEN='+secret+' bash scripts/deploy-gate.sh';
  const row={timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'gate-call',input:'const r=await tools.exec_command({cmd:'+JSON.stringify(cmd)+'});'}};
  parallel.track(state,row,clock.commandsOf(row.payload),source);
  parallel.track(state,output('gate-call','Script running with cell ID g7:96'),[],source);
  const claim=once(),first=parallel.leads(state,claim);assert.equal(first.length,1);
  assert.equal(first[0].status,'unknown');assert.deepEqual(first[0].source,{...source,callId:'gate-call'});
  assert.equal(JSON.stringify({state,first}).includes(secret),false,'raw shell commands and test output never enter state or the event');
  assert.deepEqual(parallel.leads(state,claim),[],'the same test call is announced only once');
  const waiting={timestamp:at,type:'response_item',payload:{type:'function_call',name:'wait',call_id:'wait-call',arguments:JSON.stringify({cell_id:'g7:96'})}};
  parallel.track(state,waiting,[],source);parallel.track(state,output('wait-call','Script completed'),[],source);
  assert.equal(parallel.leads(state,claim).length,0,'the already-announced unknown is not sent again');
  assert.deepEqual(parallel.leads(state,once()),[],'the terminal unknown does not linger after it is examined');
});

test('a yielded cell that finishes between polls leaves one unknown lead, not a guessed subprocess id',()=>{
  const state={},row={timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'real-shape',
    input:'const r=await tools.exec_command({cmd:"RESULT=fixture bash scripts/deploy-gate.sh"});'}};
  parallel.track(state,row,clock.commandsOf(row.payload),source);
  parallel.track(state,output('real-shape','Script running with cell ID g7:96'),[],source);
  const waiting={timestamp:at,type:'response_item',payload:{type:'function_call',name:'wait',call_id:'wait-real',arguments:JSON.stringify({cell_id:'g7:96'})}};
  parallel.track(state,waiting,[],source);
  parallel.track(state,output('wait-real',[{type:'text',text:'Script completed'},{type:'text',text:'session id: 123'}]),[],source);
  const claim=once(),pending=parallel.leads(state,claim);assert.equal(pending.length,1);assert.equal(pending[0].status,'unknown');
  assert.equal(JSON.stringify(state).includes('123'),false,'untrusted session text is not recorded as an actual process id');
  assert.deepEqual(parallel.leads(state,claim),[],'the terminal unknown is consumed exactly once');
});

test('a yielded cell that completes without nested output produces no stale lead',()=>{
  const state={},row={timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'finished-cell',
    input:'await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"});'}};
  parallel.track(state,row,clock.commandsOf(row.payload),source);
  parallel.track(state,output('finished-cell','Script running with cell ID cell:finished'),[],source);
  const waiting={timestamp:at,type:'response_item',payload:{type:'function_call',name:'wait',call_id:'finished-wait',arguments:JSON.stringify({cell_id:'cell:finished'})}};
  parallel.track(state,waiting,[],source);parallel.track(state,output('finished-wait','Script completed'),[],source);
  assert.deepEqual(parallel.leads(state,once()),[]);
});

test('a denial returned after the outer cell yielded never becomes a test lead',()=>{
  const state={},row={timestamp:at,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'denied-cell',
    input:'await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"});'}};
  parallel.track(state,row,clock.commandsOf(row.payload),source);
  parallel.track(state,output('denied-cell','Script running with cell ID cell:denied'),[],source);
  const waiting={timestamp:at,type:'response_item',payload:{type:'function_call',name:'wait',call_id:'denied-wait',arguments:JSON.stringify({cell_id:'cell:denied'})}};
  parallel.track(state,waiting,[],source);
  parallel.track(state,output('denied-wait',[{type:'text',text:'Script completed'},{type:'text',text:'Auto-review denied'}]),[],source);
  assert.deepEqual(parallel.leads(state,once()),[]);
});

test('actual process-start and completion events distinguish long foreground calls from completed calls',()=>{
  const state={},cmd='# LONG_TASK_LONG_TEST\nnode --test tests/*.cjs',row=call('foreground',cmd);
  parallel.track(state,row,clock.commandsOf(row.payload),source);
  const event=type=>({timestamp:at,type:'event_msg',payload:{type,item:{type:'CommandExecution',process_id:'synthetic-1',command:['/bin/sh','-c',cmd]}}});
  parallel.track(state,event('item_started'),[],source);assert.equal(parallel.leads(state,once())[0].status,'running');
  parallel.track(state,event('item_completed'),[],source);assert.deepEqual(parallel.leads(state,once()),[]);
});

test('two identical commands cannot let one process completion erase another test',()=>{
  const state={},cmd='bash scripts/deploy-gate.sh';
  for(const id of ['A','B']){const row=call(id,cmd);parallel.track(state,row,clock.commandsOf(row.payload),source);}
  const processRow=(type,id)=>({timestamp:at,type:'event_msg',payload:{type,item:{type:'CommandExecution',process_id:id,command:['/bin/sh','-c',cmd]}}});
  parallel.track(state,processRow('item_started','proc-A'),[],source);parallel.track(state,processRow('item_started','proc-B'),[],source);
  parallel.track(state,output('A',JSON.stringify({session_id:101,output:''})),[],source);
  parallel.track(state,output('B',JSON.stringify({session_id:102,output:''})),[],source);
  parallel.track(state,processRow('item_completed','proc-A'),[],source);
  assert.ok(state.parallelTestCalls.B,'a hash match is insufficient to close another simultaneous call');
  assert.equal(state.parallelTestCalls.B.status,'unknown');
  const sequential={},rowA=call('A',cmd),rowB=call('B',cmd);
  parallel.track(sequential,rowA,clock.commandsOf(rowA.payload),source);
  parallel.track(sequential,processRow('item_started','proc-A'),[],source);
  parallel.track(sequential,rowB,clock.commandsOf(rowB.payload),source);
  parallel.track(sequential,processRow('item_started','proc-B'),[],source);
  parallel.track(sequential,processRow('item_completed','proc-A'),[],source);
  assert.equal(sequential.parallelTestCalls.A,undefined);assert.equal(sequential.parallelTestCalls.B.status,'running',
    'one-to-one process identification closes A while keeping B');
});

test('a directly returned, structured live session is supported; incomplete metadata remains unknown',()=>{
  const state={},row=call('direct','bash scripts/full-gate.sh');parallel.track(state,row,clock.commandsOf(row.payload),source);
  parallel.track(state,output('direct',JSON.stringify({session_id:123,output:'',wall_time_seconds:1})),[],source);
  assert.equal(parallel.leads(state,once())[0].status,'unknown');
  const waiting={timestamp:at,type:'response_item',payload:{type:'function_call',name:'write_stdin',call_id:'poll',arguments:JSON.stringify({session_id:123})}};
  parallel.track(state,waiting,[],source);parallel.track(state,output('poll',JSON.stringify({exit_code:0,output:'done'})),[],source);
  assert.deepEqual(parallel.leads(state,once()),[]);
});

test('stale or invalid agent records and zero capacity cannot suppress an independent clue',()=>{
  const item={startedAt:at,source:{...source,callId:'full'},status:'unknown'},state={parallelTestCalls:{full:item}};
  const snapshot={updatedAt:'2026-11-05T00:57:10.000Z',capacity:{verified:2},packages:{inFlight:[{handle:'/root/a'},{handle:'/root/b'}]}};
  const agents=[{path:'/root/a',active:true,lastAt:1},{path:'/root/b',active:true,lastAt:1}];
  assert.equal(parallel.leads(state,once(),snapshot,agents).length,1,'even matching historical records cannot prove the platform still has active agents');
  assert.equal(parallel.leads(state,once(),{capacity:{verified:0}},[]).length,1,'an invalid capacity-only snapshot is not proof of zero usable seats');
  assert.equal(parallel.leads(state,once(),null,null).length,1,'unreadable agents remain unknown');
});

test('record reordering alone does not generate another review',()=>{
  const a={packages:{inFlight:[{id:'A',handle:'/root/a',exclusiveResources:[{key:'b',kind:'worktree'},{key:'a',kind:'browser'}]}],
    ready:[{id:'B',dependencies:['Y','X'],independent:true,safe:true,exclusiveResources:[]}]},capacity:{verified:2}};
  const b={...a,packages:{...a.packages,inFlight:[{...a.packages.inFlight[0],exclusiveResources:[...a.packages.inFlight[0].exclusiveResources].reverse()}],
    ready:[{...a.packages.ready[0],dependencies:['X','Y']}]}};
  const agents=[{path:'/root/a',active:true,lastAt:2},{path:'/root/b',active:true,lastAt:1}];
  assert.equal(parallel.fingerprint(a,agents),parallel.fingerprint(b,[...agents].reverse()));
});

test('a live test clue enters progress review even when an unrelated user approval is pending',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-clock-')),oldHome=process.env.CODEX_HOME;
  const stamp=new Date(),day=path.join(root,'sessions',String(stamp.getFullYear()),String(stamp.getMonth()+1).padStart(2,'0'),String(stamp.getDate()).padStart(2,'0'));
  try{
    process.env.CODEX_HOME=root;fs.mkdirSync(day,{recursive:true});const run=path.join(root,'run');fs.mkdirSync(run);
    const now=new Date().toISOString(),executor='parallel-test-executor',file=path.join(day,'rollout-qa-'+executor+'.jsonl');
    const start={timestamp:now,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'test-live',
      input:'const r=await tools.exec_command({cmd:"bash scripts/deploy-gate.sh"});'}};
    fs.writeFileSync(file,[{timestamp:now,type:'session_meta',payload:{id:executor}},start,
      output('test-live','Script running with cell ID cell:live')].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const binding={executorId:executor,supervisorId:'synthetic-supervisor',createdAt:new Date(Date.now()-1000).toISOString()},state={
      checkedWait:{kind:'user_approval'},lastRealEventAt:Date.now(),lastLoginCheckAt:Date.now(),lastAutomationCheckAt:Date.now(),lastHealthAt:Date.now()};
    const review=clock.check(run,binding,state);
    assert.ok(review.reasons.includes('parallel_test_review'),'a single unrelated pending user choice must not mask other authorized work');
    assert.equal(review.parallelTestReview.tests.length,1);assert.equal(review.parallelTestReview.tests[0].status,'unknown');
    assert.equal(review.reasons.includes('idle_with_work'),false,'the existing waiting/idle suppression is unchanged');
    assert.equal(JSON.stringify(review).includes('deploy-gate.sh'),false);
  }finally{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});

test('decision preflight retains unrelated review reasons, removes completed tests and keeps unreadable sources unknown',()=>{
  const one={source:{...source,callId:'done'},startedAt:at,status:'running'},two={source:{...source,callId:'unknown'},startedAt:at,status:'unknown'};
  const event={id:'old-event',reasons:['parallel_test_review','overdue'],parallelTestReview:{tests:[one,two],fingerprint:parallel.fingerprint(null,[])}},before=JSON.stringify(event);
  const state={parallelTestFinished:{done:true},parallelTestCalls:{unknown:{...two,status:'unknown'}}};
  const result=parallel.reassess(event,state,null,[]);assert.equal(result.changed,true);
  assert.deepEqual(result.reasons,['parallel_test_review','overdue']);assert.deepEqual(result.tests,[two]);
  assert.equal(JSON.stringify(event),before,'the event and its submitted decision must stay immutable');
  const only={...event,reasons:['parallel_test_review'],parallelTestReview:{tests:[one]}};
  assert.deepEqual(parallel.reassess(only,state,null,[]).reasons,[],'no old advice survives a confirmed completion');
  const unreadable=parallel.reassess(only,state,null,[],{readable:false});
  assert.equal(unreadable.tests[0].status,'unknown','a missing source cannot be silently marked complete');
  assert.deepEqual(unreadable.reasons,['parallel_test_review']);
  assert.equal(parallel.reassess({...only,parallelTestReview:{tests:[two],fingerprint:parallel.fingerprint(null,null)}},{},null,null).changed,false,
    'after restart a missing candidate remains unknown, not falsely obsolete');
  const fullState={parallelTestCalls:{done:{...one,status:'running'}}};
  const fullSnapshot={updatedAt:'2026-11-05T00:57:10.000Z',capacity:{verified:1},packages:{inFlight:[{handle:'/root/filled'}]}};
  const fullAgents=[{path:'/root/filled',active:true,lastAt:Date.parse(at)+1}];
  const updated=parallel.reassess(only,fullState,fullSnapshot,fullAgents);
  assert.equal(updated.changed,true);assert.deepEqual(updated.reasons,['parallel_test_review'],
    'agent changes require a fresh review, but stale transcripts do not prove a seat is truly occupied');
});

test('missing parallel-test details remain unknown instead of silently resolving the event',()=>{
  for(const parallelTestReview of [undefined,{}, {tests:[]},{tests:'corrupt'}]){
    const event={reasons:['parallel_test_review','overdue'],...(parallelTestReview===undefined?{}:{parallelTestReview})};
    const first=parallel.reassess(event,{},null,null);
    assert.equal(first.changed,true);assert.equal(first.missingDetails,true);
    assert.deepEqual(first.reasons,['parallel_test_review','overdue']);
    const replacement={reasons:first.reasons,parallelTestReview:{tests:[],fingerprint:null,sourceCoverage:'unknown'}};
    const second=parallel.reassess(replacement,{},null,null);
    assert.equal(second.changed,false,'explicit unknown does not create an endless reissue loop');
    assert.deepEqual(second.reasons,['parallel_test_review','overdue']);
  }
});

test('executor source missing, truncated, corrupt or switched is explicitly unknown across reviews',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-source-')),oldHome=process.env.CODEX_HOME;
  const stamp=new Date(),dir=path.join(root,'sessions',String(stamp.getFullYear()),String(stamp.getMonth()+1).padStart(2,'0'),String(stamp.getDate()).padStart(2,'0'));
  const id='missing-source-test',binding={executorId:id,createdAt:new Date(Date.now()-1000).toISOString()},line=x=>JSON.stringify(x)+'\n';
  try{
    process.env.CODEX_HOME=root;fs.mkdirSync(dir,{recursive:true});
    assert.deepEqual(clock.readExecutor({},binding),{readable:false,reason:'missing'});
    const old=path.join(dir,'rollout-1-'+id+'.jsonl');fs.writeFileSync(old,line({type:'session_meta',payload:{id}}));
    const state={executorLog:old,executorOffset:fs.statSync(old).size+10,parallelTestCalls:{x:{source:{path:old,callId:'x'},status:'running'}},
      parallelTestFinished:{x:true},pending:{parallelTestReview:{tests:[{source:{path:old,callId:'x'},status:'running'}]}}};
    assert.equal(clock.readExecutor(state,binding).reason,'truncated');assert.equal(state.parallelTestSourceUncertain.x,true);
    assert.equal(state.parallelTestFinished.x,undefined,'an old finished flag cannot override a truncated source');
    const next=path.join(dir,'rollout-2-'+id+'.jsonl');fs.writeFileSync(next,line({type:'session_meta',payload:{id}}));
    assert.equal(clock.readExecutor(state,binding).reason,'segment_changed');
    fs.appendFileSync(next,'{"type":');assert.equal(clock.readExecutor(state,binding).reason,'incomplete');
    fs.appendFileSync(next,'broken}\n');assert.equal(clock.readExecutor(state,binding).reason,'invalid_record');
    const original={reasons:['parallel_test_review'],parallelTestReview:{tests:[{source:{path:old,callId:'x'},status:'running'}],fingerprint:parallel.fingerprint(null,[])}};
    const checked=parallel.reassess(original,state,null,[],{readable:true});assert.equal(checked.tests[0].status,'unknown');
    assert.deepEqual(checked.reasons,['parallel_test_review'],'source uncertainty survives the next apparently readable poll');
    parallel.clear(state,original,{retain:['x']});
    const replacement={reasons:checked.reasons,parallelTestReview:{tests:checked.tests,fingerprint:checked.fingerprint}};
    const rechecked=parallel.reassess(replacement,state,null,[],{readable:true});
    assert.equal(rechecked.tests[0].status,'unknown');assert.equal(rechecked.changed,false,'source uncertainty survives reissuing the review event');
  }finally{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});

test('unreadable executor source preserves its cursor, records a safe error, and leaves other events operational',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-eacces-')),oldHome=process.env.CODEX_HOME;
  const originalStat=fs.statSync,originalOpen=fs.openSync,stamp=new Date();
  const dir=path.join(root,'sessions',String(stamp.getFullYear()),String(stamp.getMonth()+1).padStart(2,'0'),String(stamp.getDate()).padStart(2,'0'));
  try{
    process.env.CODEX_HOME=root;fs.mkdirSync(dir,{recursive:true});const run=path.join(root,'run');fs.mkdirSync(run);
    const id='eacces-executor',file=path.join(dir,'rollout-qa-'+id+'.jsonl');
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
    const binding={executorId:id,supervisorId:'synthetic-supervisor',createdAt:new Date(Date.now()-62*60000).toISOString()};
    const state={executorLog:file,executorOffset:0,executorSettings:{approvalPolicy:'never'},history:[{old:'preserve'}],
      parallelTestCalls:{x:{source:{path:file,callId:'x'},status:'running'}},parallelTestFinished:{x:true},
      pending:{parallelTestReview:{tests:[{source:{path:file,callId:'x'},status:'running'}]}},
      lastRealEventAt:Date.now()-61*60000,lastLoginCheckAt:Date.now(),lastAutomationCheckAt:Date.now(),lastHealthAt:Date.now()};
    fs.statSync=function(name,...args){if(String(name)===file){const e=Error('synthetic-secret-not-for-logs');e.code='EACCES';throw e;}return originalStat.call(this,name,...args);};
    assert.deepEqual(clock.readExecutor(state,binding),{readable:false,reason:'unreadable'});
    assert.equal(state.executorOffset,0);assert.equal(state.executorLog,file);assert.equal(state.parallelTestSourceUncertain.x,true);
    assert.equal(state.parallelTestFinished.x,undefined);assert.equal(state.executorSourceReadError.code,'EACCES');
    assert.deepEqual(state.history[0],{old:'preserve'});assert.equal(state.history.length,2);
    clock.readExecutor(state,binding);assert.equal(state.history.length,2,'the same unreadable condition is recorded once');
    assert.equal(JSON.stringify(state).includes('synthetic-secret-not-for-logs'),false);
    delete require.cache[require.resolve('../codex/.agents/skills/long-task-supervisor/scripts/supervisor-clock.cjs')];
    const fresh=require('../codex/.agents/skills/long-task-supervisor/scripts/supervisor-clock.cjs');
    const review=fresh.check(run,binding,state);assert.ok(review.reasons.includes('no_event_hour'),'other progress events continue');
    assert.ok(review.reasons.includes('parallel_test_review'));assert.equal(review.parallelTestReview.tests[0].status,'unknown');
    fs.statSync=originalStat;
    const end=fs.statSync(file).size,unchanged={executorLog:file,executorOffset:end};
    fs.openSync=function(name,...args){if(String(name)===file){const e=Error('no permission');e.code='EACCES';throw e;}return originalOpen.call(this,name,...args);};
    assert.deepEqual(clock.readExecutor(unchanged,binding),{readable:false,reason:'unreadable'});
    assert.equal(unchanged.executorOffset,end,'even an unchanged source must be readable before reporting success');
  }finally{fs.statSync=originalStat;fs.openSync=originalOpen;if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});
