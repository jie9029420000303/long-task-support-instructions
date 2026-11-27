// v1.21.2 (Jay 2026-11-27「A」). Each test pins a gap found on workspace E that evening:
// - a delivery judged failed and kept in flight for its redo went uncounted (WP-E-WIRING-C59 at 20:15: I23 stayed at 2
//   and the redo went to a new subagent instead of the same one);
// - workers were routed to the Claude API after its month ran out (C67 at 22:18, refused at once);
// - the efficiency check compared raw seconds against a limit the criterion states to one decimal (841 s is 14.0).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const PLATFORMS=[{name:'codex',supervisor:'codex/.agents/skills/long-task-supervisor'},{name:'claude',supervisor:'claude-code/.claude/skills/long-task-supervisor'}];
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a delivery judged failed and kept in flight for its redo counts once, and collecting it again does not count it twice',()=>{
  for(const p of PLATFORMS){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1212-collect-')),run=path.join(root,'run'),state=path.join(root,'state'),wp=path.join(state,'wp');
    fs.mkdirSync(run);fs.mkdirSync(wp,{recursive:true});
    const source=path.join(root,'source');fs.writeFileSync(source,'criterion\n');
    save(path.join(run,'contract.json'),{goal:'collect',authorization:'isolated test',criteria:[{id:'A2',requirement:'two',source:'source:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
    const executorId=p.name==='codex'?'executor-qa':crypto.randomUUID();
    save(path.join(run,'binding.json'),{platform:p.name,projectRoot:root,allowedRoots:[root,run],executorId,supervisorId:p.name==='codex'?'supervisor-qa':crypto.randomUUID(),executorLog:path.join(root,'transcripts',executorId+'.jsonl'),
      contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
    const cli=args=>JSON.parse(execFileSync(process.execPath,[path.join(ROOT,p.supervisor,'scripts/dispatch.cjs'),...args],{stdio:'pipe',encoding:'utf8',env:{...process.env,CODEX_HOME:path.join(root,'empty-home'),CLAUDE_CONFIG_DIR:path.join(root,'empty-config')}}));
    const flight='{"list":"inFlight","handle":"agent:B2","baseline":{"minutes":20,"startedAt":"2026-11-13T01:00:00Z","basis":"pace"}}';
    fs.writeFileSync(path.join(wp,'B2.md'),'[工作包] id=B2；依賴：無\n[狀態] '+flight+'\n[驗收條目] A2\n');
    const base=path.join(root,'base.json');save(base,{capacity:{verified:3,evidence:['platform:list_agents']},acceptance:{revision:'r1',items:[{id:'A2',status:'PENDING',evidence:['plan']}]}});
    try{
      cli(['from-wp',run,state,'--base',base,'--revision','p1']);
      const report=path.join(root,'report.md');fs.writeFileSync(report,'checked\n');
      const result=path.join(root,'r.json'),deliver=reason=>save(result,{verdict:{kind:'fail',reason},status:{list:'inFlight',handle:'agent:B2',evidence:[report]},acceptance:[]});
      const count=()=>require(path.join(ROOT,p.supervisor,'scripts/rework.cjs')).status(run).map(r=>[r.criterionId,r.failures,r.held]);
      deliver('A2 total off by one row');
      cli(['collect',run,state,'B2',result]);
      assert.deepEqual(count(),[['A2',1,false]],p.name+': kept in flight, still counted');
      cli(['collect',run,state,'B2',result]);
      assert.deepEqual(count(),[['A2',1,false]],p.name+': the same delivery collected again');
      deliver('A2 still off after the redo');
      cli(['collect',run,state,'B2',result]);
      assert.deepEqual(count(),[['A2',2,true]],p.name+': the redo failing is the 2nd');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('workers skip the Claude API while its month is out, as the watcher does',t=>{
  const {resolve}=require(path.join(ROOT,'codex/.agents/skills/long-task-supervisor/scripts/model-route.cjs'));
  const item=id=>({id,efforts:['low','medium','high','xhigh']});
  const opus='anthropic/claude-opus-5-5',apiOpus='anthropic-apikey/claude-opus-5-5',apiSonnet='anthropic-apikey/claude-sonnet-5-5',sol='gpt-6.2-sol',terra='gpt-6.1-terra';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v1212-route-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const fallback=path.join(dir,'model-fallback.json');
  const input={supervisorModel:opus,roles:['executor','general'],fallback,catalogs:{executor:[item(apiOpus),item(sol)],subagent:[item(apiSonnet),item(terra)]}};
  const pick=r=>[r.roles.executor.model,r.roles.general.model];
  save(fallback,{limits:{},apiMonth:{until:new Date(Date.now()+86400000).toISOString(),basis:'錯誤訊息寫明的恢復時間'}});
  assert.deepEqual(pick(resolve(input)),[sol,terra]);
  save(fallback,{limits:{},apiMonth:{until:new Date(Date.now()-60000).toISOString(),basis:'past'}});
  assert.deepEqual(pick(resolve(input)),[apiOpus,apiSonnet],'a month that ended is used again');
});

test('the efficiency check reads minutes to one decimal, as the criteria state them',()=>{
  for(const p of PLATFORMS){
    const efficiency=require(path.join(ROOT,p.supervisor,'scripts/efficiency.cjs'));
    const criteria={I23:{maxMinutes:14,basis:'前版 14.0 分'}};
    const run=seconds=>({kind:'attempt',criterionId:'I23',id:'PDS-'+seconds,caseId:'PDS',revision:'r1',outcome:'PASS',reason:'讀完',
      startedAt:'2026-11-27T13:00:00.000Z',finishedAt:new Date(Date.parse('2026-11-27T13:00:00.000Z')+seconds*1000).toISOString()});
    assert.equal(efficiency.judge(criteria,run(841),[]),null,p.name+': 841 s is 14.0 minutes');
    assert.deepEqual(efficiency.blockers(criteria,[run(841)],'I23'),[],p.name);
    assert.throws(()=>efficiency.judge(criteria,run(843)),/不能記 PASS/,p.name+': 843 s is 14.1 minutes');
  }
});

