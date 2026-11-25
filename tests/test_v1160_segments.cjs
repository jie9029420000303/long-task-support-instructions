// v1.16.0 (Jay 2026-11-25「開始改」): segments. A segment is a group of related acceptance criteria and their dependencies;
// the supervisor writes the table, the mainline loads one segment at a time, submits it once its packages are adopted,
// and the supervisor rules on that segment while the next one is built. 工區 E sent 122 submissions in 11/18～11/24, each
// grouped by scenario, code and test path, and had 1 of its 45 criteria passed after 11 days. What the tests pin: the
// table covers every criterion once without a dependency cycle; a submission is one segment and carries its criteria;
// a package naming an unknown segment is refused; the supervisor's brief and dashboard show each segment's progress.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const platforms=[['codex',path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts')],
  ['claude',path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts')]];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

test('the segment table puts every criterion in exactly one segment, and a segment depends only on others without a cycle',()=>{
  for(const [name,scripts] of platforms){
    const segments=require(path.join(scripts,'segments.cjs')),ids=['E1','E2','E3'];
    assert.deepEqual(segments.validate([{id:'S1',criteria:['E1','E2']},{id:'S2',title:'辨識',criteria:['E3'],dependsOn:['S1']}],ids).map(item=>item.dependsOn),[[],['S1']],name);
    assert.throws(()=>segments.validate([{id:'S1',criteria:['E1','E2']}],ids),/E3/,name+': a criterion left out');
    assert.throws(()=>segments.validate([{id:'S1',criteria:['E1','E2']},{id:'S2',criteria:['E2','E3']}],ids),/E2/,name+': a criterion in two segments');
    assert.throws(()=>segments.validate([{id:'S1',criteria:['E1','E2','E3','X9']}],ids),/X9/,name+': a criterion not in the contract');
    assert.throws(()=>segments.validate([{id:'S1',criteria:['E1'],dependsOn:['S2']},{id:'S2',criteria:['E2','E3'],dependsOn:['S1']}],ids),/循環/,name+': a cycle');
    assert.deepEqual(segments.progress([{id:'S1',criteria:['E1','E2'],dependsOn:[]}],[{id:'E1',status:'PASS'},{id:'E2',status:'PENDING'}])[0].passed,['E1'],name);
  }
});

function isolated(t,scripts){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v1160-segments-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const run=path.join(root,'run'),wp=path.join(root,'wp');fs.mkdirSync(run);fs.mkdirSync(wp);
  const source=path.join(root,'scope.txt');fs.writeFileSync(source,'Read the original documents.');
  const contract={goal:'Read originals',authorization:'Isolated local tests only',sources:[{path:source,sha256:sha(source)}],criteria:[
    {id:'E1',requirement:'Read the PDF',source:'scope.txt:1',verify:'Compare'},{id:'E2',requirement:'Read the scan',source:'scope.txt:1',verify:'Compare'},
    {id:'E3',requirement:'Report the reading',source:'scope.txt:1',verify:'Compare'}]};
  write(path.join(run,'contract.json'),contract);
  write(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root],executorId:'executor',supervisorId:'supervisor',
    contractSha256:sha(path.join(run,'contract.json')),callerTurnId:'test-turn',dispatchAudit:{enabled:true}});
  write(path.join(run,'daemon-state.json'),{phase:'watching',pending:null,inflight:null,seen:[],messages:[]});
  const env={...process.env,CODEX_HOME:root,LONG_TASK_REGISTER:'0'};delete env.CODEX_THREAD_ID;delete env.CLAUDE_SESSION_ID;
  const call=(script,...args)=>spawnSync(process.execPath,[path.join(scripts,script),...args],{encoding:'utf8',timeout:10000,env});
  const base=path.join(root,'base.json');write(base,{capacity:{verified:2,evidence:['isolated fixture']}});
  const makeWP=(id,segment,status)=>fs.writeFileSync(path.join(wp,id+'.md'),
    ['[工作包] id='+id+'；類型=B 實作','[驗收條目] E1 E2',...(segment?['[區段] '+segment]:[]),'[狀態] '+JSON.stringify(status)].join('\n')+'\n');
  const table=path.join(root,'segments-input.json');
  write(table,{segments:[{id:'S1',title:'讀原件',criteria:['E1','E2']},{id:'S2',criteria:['E3'],dependsOn:['S1']}]});
  return {root,run,source,base,table,call,makeWP};
}
const ok=result=>assert.equal(result.status,0,result.stderr||String(result.error));

test('a submission is one segment and names its criteria, so the supervisor rules on that segment',t=>{
  for(const [name,scripts] of platforms){
    const f=isolated(t,scripts);
    ok(f.call('supervise.cjs','segments',f.run,f.table));
    assert.deepEqual(read(path.join(f.run,'segments.json')).segments.map(item=>item.id),['S1','S2'],name);
    f.makeWP('WP-A','S1',{list:'inFlight',handle:'/root/a'});f.makeWP('WP-B','S1',{list:'inFlight',handle:'/root/b'});f.makeWP('WP-C','S2',{list:'ready'});
    ok(f.call('dispatch.cjs','from-wp',f.run,f.root,'--base',f.base));
    assert.equal(read(path.join(f.run,'dispatch.json')).packages.inFlight.find(item=>item.id==='WP-A').segment,'S1',name);
    const manifest=path.join(f.root,'submit-1.json'),result=f.call('candidate.cjs',f.run,f.root,'WP-A,WP-B',manifest,f.source);ok(result);
    const event=JSON.parse(result.stdout.trim().slice('LONG_TASK_EVENT '.length));
    assert.deepEqual([event.kind,event.segment,event.criteria],['submission','S1',['E1','E2']],name);
    const mixed=f.call('candidate.cjs',f.run,f.root,'WP-A,WP-C',path.join(f.root,'submit-2.json'),f.source);
    assert.notEqual(mixed.status,0,name+': two segments in one submission');assert.match(mixed.stderr,/一次只送一個區段/);
  }
});

test('a package naming a segment that is not in the table is refused before anything is written',t=>{
  for(const [name,scripts] of platforms){
    const f=isolated(t,scripts);
    ok(f.call('supervise.cjs','segments',f.run,f.table));
    f.makeWP('WP-X','S9',{list:'ready'});
    const result=f.call('dispatch.cjs','from-wp',f.run,f.root,'--base',f.base);
    assert.notEqual(result.status,0,name);assert.match(result.stderr,/S9/);
    assert.equal(fs.existsSync(path.join(f.run,'dispatch.json')),false,name);
  }
});

test('without a segment table a submission works as before',t=>{
  for(const [name,scripts] of platforms){
    const f=isolated(t,scripts);
    f.makeWP('WP-A',null,{list:'inFlight',handle:'/root/a'});
    ok(f.call('dispatch.cjs','from-wp',f.run,f.root,'--base',f.base));
    const result=f.call('candidate.cjs',f.run,f.root,'WP-A',path.join(f.root,'submit-1.json'),f.source);ok(result);
    const event=JSON.parse(result.stdout.trim().slice('LONG_TASK_EVENT '.length));
    assert.equal(event.segment,undefined,name);
  }
});

test('the dashboard lists each segment with the criteria passed so far',()=>{
  for(const [name,scripts] of platforms){
    const progress=require(path.join(scripts,'segments.cjs')).progress([{id:'S1',title:'讀原件',criteria:['E1','E2'],dependsOn:[]},{id:'S2',criteria:['E3'],dependsOn:['S1']}],
      [{id:'E1',status:'PASS'},{id:'E2',status:'PASS'},{id:'E3',status:'PENDING'}]);
    const dashboard=require(path.join(scripts,'dashboard.cjs'));
    const page=dashboard.render({binding:{executorId:'e',supervisorId:'s'},state:{},snapshot:{acceptance:{items:[]}},paced:{packages:[]},alive:true,paused:false,segments:progress});
    assert.match(page,/## 區段進度（共 2 段，已全部通過 1 段）/,name);
    assert.match(page,/\| S1 讀原件 \| 2／2 \| — \|/,name);assert.match(page,/\| S2 \| 0／1 \| S1 \|/,name);
  }
});

test('the Codex watcher hands the supervisor the segment and its criteria with a submission',async()=>{
  const scripts=platforms[0][1],root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v1160-watch-'))),{spawn}=require('node:child_process');
  const source=path.join(root,'source.txt'),manifest=path.join(root,'manifest.json');
  fs.writeFileSync(source,'E1 E2\n');write(manifest,{files:[{path:source,sha256:sha(source)}]});
  const run=path.join(root,'run');fs.mkdirSync(run);
  write(path.join(run,'contract.json'),{goal:'Read originals',authorization:'Isolated QA',criteria:[{id:'E1',requirement:'Read',source:'source.txt:1',verify:'Replay'},{id:'E2',requirement:'Read',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]});
  write(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()});
  write(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const final='S1 ready.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest,segment:'S1',criteria:['E1','E2']});
  write(path.join(root,'mock.json'),{supervisorId:'supervisor-qa',executorId:'executor-qa',final});
  const env={...process.env,CODEX_HOME:path.join(root,'codex-home'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:path.join(root,'mock.json'),MOCK_CODEX_SENT:path.join(root,'sent.json')};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  try{
    const end=Date.now()+12000;let pending=null;
    while(Date.now()<end&&!(pending=read(path.join(run,'daemon-state.json')).pending))await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(pending,'the submission reached the supervisor');
    assert.deepEqual([pending.kind,pending.segment,pending.criteria],['submission','S1',['E1','E2']]);
  }finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});}
});

