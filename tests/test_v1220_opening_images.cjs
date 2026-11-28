// v1.22.0 (Jay 2026-11-28). Each test pins why the behaviour matters to the run:
// - Sol and Terra subagents start one step higher: from Nov 14 to 28, 16% of Terra Medium subagents came back unfinished
//   from their first turn against Sonnet Medium's 1% (「SOL Terra起步都升一檔」);
// - a new run records the supervisor's opening research of outside references and the environment, and the record is
//   checked against the research subagent's own transcript, like a rework study;
// - an image a subagent builds is seen in its transcript, and a repeat in the same turn becomes a dispatch review;
// - the dashboard counts the image builds that went into each segment submission (one per segment is the rule).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {researchTranscript}=require('./fixtures/research-transcript.cjs');
const ROOT=path.resolve(__dirname,'..');
const CODEX=path.join(ROOT,'codex/.agents/skills/long-task-supervisor/scripts');
const CLAUDE=path.join(ROOT,'claude-code/.claude/skills/long-task-supervisor/scripts');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

test('Sol and Terra subagents start one step above the role baseline; other models and the executor do not',()=>{
  const {workerBaseline}=require(path.join(CODEX,'model-catalog.cjs'));
  assert.equal(workerBaseline('general','gpt-6.1-terra'),'high');
  assert.equal(workerBaseline('general','openai-apikey/gpt-6.2-sol'),'high');
  assert.equal(workerBaseline('ui','gpt-6.1-terra'),'medium');
  assert.equal(workerBaseline('general','anthropic/claude-sonnet-5-5'),'medium');
  assert.equal(workerBaseline('ui','anthropic/claude-sonnet-5-5'),'low');
  assert.equal(workerBaseline('executor','gpt-6.2-sol'),null,'the executor keeps its own xhigh');
  const route=require(path.join(CODEX,'model-route.cjs'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v1220-route-'));
  try{
    const file=path.join(dir,'model-fallback.json');save(file,{limits:{}});
    const efforts=['low','medium','high','xhigh','max'],catalogs={subagent:[{id:'gpt-6.1-terra',efforts}]};
    const ask=input=>route.resolve({supervisorModel:'anthropic/claude-opus-5-5',executorModel:'anthropic/claude-opus-5-5',roles:['general'],fallback:file,catalogs,...input}).roles.general;
    assert.equal(ask({}).effort,'high');
    // The raise after the 2nd failure counts from the raised start: High two steps up is max.
    assert.equal(ask({failures:2,previousModel:'gpt-6.1-terra',previousEffort:'high'}).effort,'max');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const [platform,scripts] of [['codex',CODEX],['claude',CLAUDE]]){
  const rework=require(path.join(scripts,'rework.cjs'));
  function opening(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1220-open-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    // The research subagent belongs to the supervisor; the fixture writes it as a subagent of the bound conversation.
    const conversation={executorId:'supervisor-chat',platform,createdAt:new Date(Date.now()-3600000).toISOString()};
    save(path.join(root,'binding.json'),conversation);
    const write=steps=>researchTranscript({t,root,scripts,agent:'open_research',steps});
    const bound=()=>JSON.parse(fs.readFileSync(path.join(root,'binding.json'),'utf8'));
    // Away from the system temp directory a run is a real one, so the record is required.
    const notTemp=fn=>withEnv({LONG_TASK_TEMP_ROOT:path.join(root,'elsewhere')},fn);
    const input=researchAgent=>({documented:true,researchAgent,environment:'Staging Docker, Postgres 17, Node 22',
      references:[{url:'https://github.com/example/ocr',license:'MIT',maintenance:'last release 2026-10, 4k stars',fit:'reuse the tile batcher'}]});
    return {root,write,bound,notTemp,input,run:path.join(root,'runs','run')};
  }
  test(platform+': a new run needs the opening research; a continued run and a test run do not',t=>{
    const f=opening(t);
    assert.throws(()=>f.notTemp(()=>rework.openingResearch(f.run,f.bound(),undefined)),/priorArt is required/);
    assert.equal(f.notTemp(()=>rework.openingResearch(f.run,f.bound(),undefined,{inherited:true})),null);
    assert.equal(rework.openingResearch(path.join(os.tmpdir(),'x','run'),f.bound(),undefined),null);
  });
  test(platform+': opening research without a web search, or with a reference never seen after it, is refused',t=>{
    const f=opening(t);
    const silent=f.write([{text:'From the document: https://github.com/example/ocr'}]);
    assert.throws(()=>f.notTemp(()=>rework.openingResearch(f.run,f.bound(),f.input(silent))),/沒有任何網路搜尋/);
    const early=f.write([{text:'Planned https://github.com/example/ocr'},{search:'ocr tile batch'},{text:'nothing'}]);
    assert.throws(()=>f.notTemp(()=>rework.openingResearch(f.run,f.bound(),f.input(early))),/沒有出現在/);
    assert.throws(()=>f.notTemp(()=>rework.openingResearch(f.run,f.bound(),{...f.input(early),references:[{url:'https://github.com/example/ocr'}]})),/license/);
  });
  test(platform+': checked opening research keeps the searches and when each reference was seen',t=>{
    const f=opening(t),start=Date.now()+1000;
    const agent=researchTranscript({t,root:f.root,scripts,agent:'open_research',startAt:start,
      steps:[{search:'ocr tile batch github'},{text:'Found https://github.com/example/ocr MIT'}]});
    const record=f.notTemp(()=>rework.openingResearch(f.run,f.bound(),f.input(agent)));
    assert.equal(record.researchAgent,agent);assert.equal(record.documented,true);assert.equal(record.searches.length,1);
    assert.equal(record.references[0].seenAt,new Date(start+1000).toISOString());
    const none=f.notTemp(()=>rework.openingResearch(f.run,f.bound(),{...f.input(agent),references:[],notFound:'searched GitHub and the vendor docs, nothing reusable'}));
    assert.match(none.notFound,/nothing reusable/);
  });
}

test('an image built in a subagent turn is read from its transcript with the turn it belongs to',()=>{
  const pace=require(path.join(CODEX,'pace.cjs'));
  assert.ok(pace.imageCommand({type:'custom_tool_call',input:'await tools.exec_command({cmd:"cd app && docker buildx build -t bpm-app:1 ."})'}));
  assert.ok(pace.imageCommand({type:'function_call',arguments:'{"cmd":"docker save bpm-app:1 | ssh ops-staging sudo docker load"}'}));
  assert.equal(pace.imageCommand({type:'function_call',arguments:'{"cmd":"docker ps -a && docker logs x"}'}),null);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1220-pace-'));
  try{
    const d=new Date(),pad=n=>String(n).padStart(2,'0'),dir=path.join(root,'sessions',String(d.getFullYear()),pad(d.getMonth()+1),pad(d.getDate()));
    fs.mkdirSync(dir,{recursive:true});
    const at=n=>new Date(Date.now()+n*1000).toISOString();
    const rows=[{timestamp:at(0),type:'session_meta',payload:{id:'agent-1',thread_source:'subagent',parent_thread_id:'executor',agent_path:'/root/builder'}},
      {timestamp:at(1),type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}},
      {timestamp:at(2),type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"docker build -t bpm-app:2 ."}',call_id:'c1'}},
      {timestamp:at(3),type:'event_msg',payload:{type:'task_complete',turn_id:'turn-1'}}];
    fs.writeFileSync(path.join(dir,'rollout-x-agent-1.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const runs=withEnv({CODEX_HOME:root},()=>pace.agentRuns({executorId:'executor',createdAt:new Date().toISOString()}));
    assert.equal(runs[0].builds.length,1);assert.equal(runs[0].builds[0].turnId,'turn-1');assert.match(runs[0].builds[0].command,/docker build/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the dashboard shows the image builds of each segment submission',()=>{
  const dashboard=require(path.join(CODEX,'dashboard.cjs'));
  const segments=[{id:'S1',title:'讀法',criteria:['I01'],passed:[],dependsOn:[]},{id:'S4',title:'九張',criteria:['I23'],passed:[],dependsOn:['S1']}];
  const page=dashboard.render({binding:{executorId:'e',supervisorId:'s'},state:{},snapshot:{acceptance:{items:[]}},paced:{packages:[]},alive:true,paused:false,
    segments,imageBuilds:{bySegment:{S4:3},pending:1,total:4}});
  assert.match(page,/\| 區段 \| 通過／條文 \| 依賴 \| 封裝映像 \|/);
  assert.match(page,/\| S4 九張 \| 0／1 \| S1 \| 3 \|/);
  assert.match(page,/封裝映像共 4 次.*還沒送驗的候選已封裝 1 次/);
});
