// v1.21.5 (Jay 2026-11-28): research means the research subagent searches the web first. 「他要把這遇到的問題定位了
// 以後，一定要開啟上網，搜尋 GitHub，各種技術論壇，或是他們使用的語言，或是情境的外部技術文件，找到可能可行的方案了以後，
// 回來分析，然後再回給執行主線，派子代理去做實作」. Workspace E's research C69 ran 112 commands with two searches and
// proposed a design no source held; C71 was an experiment with no search at all. So registering research reads the
// research subagent's own transcript: no search, a source that only appears before the search, or a candidate without
// an outside source is refused, and the time each source was seen comes from the transcript, not from the mainline.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {researchTranscript}=require('./fixtures/research-transcript.cjs');
const ROOT=path.resolve(__dirname,'..');
const CODEX=path.join(ROOT,'codex/.agents/skills/long-task-supervisor/scripts');
const CLAUDE=path.join(ROOT,'claude-code/.claude/skills/long-task-supervisor/scripts');
delete process.env.CODEX_THREAD_ID;delete process.env.CODEX_SESSION_ID;delete process.env.CLAUDE_SESSION_ID;
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const URL_A='https://github.com/example/ocr/issues/42',URL_B='https://docs.example.org/tiles#batch';
function fixture(t,platform,scripts){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1215-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=name=>path.join(root,name);
  fs.writeFileSync(p('source'),'Isolated contract');fs.writeFileSync(p('executor-prompt.txt'),'Isolated executor');
  save(p('contract.json'),{goal:'fixture',authorization:'test only',sources:[{path:p('source'),sha256:sha(p('source'))}],
    criteria:[{id:'C1',requirement:'tiles finish in time',source:'source:1',verify:'timed run'}]});
  save(p('binding.json'),{platform,supervisorId:'supervisor-chat',executorId:'executor-chat',projectRoot:root,allowedRoots:[root],
    contractSha256:sha(p('contract.json')),promptSha256:sha(p('executor-prompt.txt')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
  save(p('dispatch.json'),{schemaVersion:1,executorId:'executor-chat',packages:{ready:[{id:'P3'}],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]}});
  const failedAt=Date.now()-5000;
  for(const [index,id] of ['P1','P2'].entries())
    fs.appendFileSync(p('acceptance-history.jsonl'),JSON.stringify({kind:'verdict',criterionId:'C1',outcome:'FAIL',source:'executor',packageId:id,reason:'too slow',at:new Date(failedAt+index).toISOString()})+'\n');
  const base={criterionId:'C1',directCauses:['P1 too slow','P2 too slow'],commonCause:'tiles run one by one',excluded:'machine load excluded',
    environment:'Mac Studio, local run',software:'node 22, ocr 3.1',workPackage:'P3',sources:[{url:URL_A},{url:URL_B}],
    candidates:[{approach:'batch tiles',conditions:'ocr 3.1 or later',risks:'more memory',sources:[URL_A,URL_B]}],selected:'batch tiles',selectionReason:'fits the version in use'};
  const register=value=>{save(p('research.json'),value);
    return spawnSync(process.execPath,[path.join(scripts,'rework.cjs'),'research',root,p('research.json')],{encoding:'utf8',timeout:15000});};
  const history=()=>fs.readFileSync(p('acceptance-history.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {root,base,register,history,failedAt};
}
const searched=[{search:'ocr tiles slow batch'},{text:'Result: '+URL_A+' batch mode'},{text:'Opened '+URL_B}];
for(const [platform,scripts] of [['codex',CODEX],['claude',CLAUDE]]){
  test(platform+': research whose subagent never searched is refused, even when its sources are in the transcript',t=>{
    const f=fixture(t,platform,scripts);
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:[{text:'From memory: '+URL_A+' '+URL_B}]});
    const r=f.register({...f.base,researchAgent});
    assert.equal(r.status,1);assert.match(r.stderr,/沒有任何網路搜尋/);
    assert.equal(f.history().filter(row=>row.kind==='reset').length,0);
  });
  test(platform+': a search made before the latest failure does not count for this research',t=>{
    const f=fixture(t,platform,scripts);
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:searched,startAt:f.failedAt-60000});
    const r=f.register({...f.base,researchAgent});
    assert.equal(r.status,1);assert.match(r.stderr,/最近一次不合格/);
  });
  test(platform+': a source written before the first search, or never seen, is refused',t=>{
    const f=fixture(t,platform,scripts);
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:[{text:'Planned: '+URL_B},{search:'ocr tiles slow batch'},{text:'Result: '+URL_A}]});
    const r=f.register({...f.base,researchAgent});
    assert.equal(r.status,1);assert.match(r.stderr,/沒有出現在/);assert.match(r.stderr,/docs\.example\.org/);assert.doesNotMatch(r.stderr,/issues\/42/);
  });
  test(platform+': every candidate names its outside sources and the choice is one of the candidates',t=>{
    const f=fixture(t,platform,scripts);
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:searched});
    let r=f.register({...f.base,researchAgent,candidates:[{...f.base.candidates[0],sources:['https://elsewhere.example/x']}]});
    assert.equal(r.status,1);assert.match(r.stderr,/sources 列它依據的外部網址/);
    r=f.register({...f.base,researchAgent,candidates:[{approach:'batch tiles',conditions:'',risks:'more memory',sources:[URL_A]}]});
    assert.equal(r.status,1);assert.match(r.stderr,/conditions/);
    r=f.register({...f.base,researchAgent,selected:'something the research did not find'});
    assert.equal(r.status,1);assert.match(r.stderr,/selected/);
    r=f.register({...f.base,researchAgent,candidates:[]});
    assert.equal(r.status,1);assert.match(r.stderr,/notFound/);
  });
  test(platform+': registered research keeps the searches, when each source was seen and the chosen candidate',t=>{
    const f=fixture(t,platform,scripts);
    const start=Date.now()+1000;
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:platform==='codex'?[{terra:'ocr tiles slow batch'},...searched.slice(1)]:searched,startAt:start});
    const r=f.register({...f.base,researchAgent});
    assert.equal(r.status,0,r.stderr);
    assert.match(JSON.parse(r.stdout).next,/驗證小實驗/,'the redo starts with the confirming experiment');
    const row=f.history().find(item=>item.kind==='reset');
    assert.equal(row.researchAgent,researchAgent);
    assert.equal(row.searches.length,1);
    assert.deepEqual(row.sources,[{url:URL_A,seenAt:new Date(start+1000).toISOString()},{url:URL_B,seenAt:new Date(start+2000).toISOString()}]);
    assert.deepEqual([row.selected,row.solution,row.selectionReason],['batch tiles','batch tiles','fits the version in use']);
    assert.equal('experiment' in row,false);
  });
  test(platform+': research that searched and found nothing workable registers with notFound',t=>{
    const f=fixture(t,platform,scripts);
    const researchAgent=researchTranscript({t,root:f.root,scripts,steps:searched});
    const {candidates,selected,selectionReason,...rest}=f.base;
    const r=f.register({...rest,researchAgent,notFound:'issue 42 and the docs only cover ocr 4, we run 3.1'});
    assert.equal(r.status,0,r.stderr);
    const row=f.history().find(item=>item.kind==='reset');
    assert.match(row.solution,/^查不到可行方案/);assert.deepEqual(row.candidates,[]);
  });
  test(platform+': researchAgent has to be a subagent of this execution mainline',t=>{
    const f=fixture(t,platform,scripts);
    researchTranscript({t,root:f.root,scripts,steps:searched});
    const r=f.register({...f.base,researchAgent:'someone_else'});
    assert.equal(r.status,1);assert.match(r.stderr,/不是這個執行主線派出的子代理/);
  });
}
