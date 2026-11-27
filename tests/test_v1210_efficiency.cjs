// v1.21.0 (Jay 2026-11-27 decisions 46-51). Each test pins why the behaviour matters to the run:
// - a real run slower than its criterion's efficiency expectation is a failure the program counts, so a slow run can
//   no longer pass by rewriting the package baseline from its own time (workspace E: PDS26020017 went from 14.0 minutes
//   to 120.1 minutes unfinished while baselines were rewritten from 22.2 to 224.4 minutes);
// - raising or removing an expectation needs Jay's words, so the limit cannot drift up the same way;
// - the criterion cannot be accepted or turned PASS while its latest run is too slow;
// - skipping research needs the supervisor (the mainline itself waived the 2nd failure of I07 and I23).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const PLATFORMS={codex:path.join(ROOT,'codex/.agents/skills/long-task-supervisor/scripts'),claude:path.join(ROOT,'claude-code/.claude/skills/long-task-supervisor/scripts')};
delete process.env.CODEX_THREAD_ID;delete process.env.CODEX_SESSION_ID;delete process.env.CLAUDE_SESSION_ID;
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const at=minutes=>new Date(Date.parse('2026-11-27T01:00:00Z')+minutes*60000).toISOString();
const attempt=(caseId,minutes,outcome='PASS',revision='r1')=>({kind:'attempt',criterionId:'C1',id:caseId+'-'+revision+'-'+minutes,caseId,revision,outcome,reason:'fixture',startedAt:at(0),finishedAt:at(minutes)});
function fixture(t,platform){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1210-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=name=>path.join(root,name);
  fs.writeFileSync(p('source'),'Isolated contract');fs.writeFileSync(p('executor-prompt.txt'),'Isolated executor');
  save(p('contract.json'),{goal:'fixture',authorization:'test only',sources:[{path:p('source'),sha256:sha(p('source'))}],
    criteria:[{id:'C1',requirement:'reads every page',source:'source:1',verify:'run the case'},{id:'C2',requirement:'second',source:'source:1',verify:'read'}]});
  save(p('binding.json'),{platform,supervisorId:'supervisor-chat',executorId:'executor-chat',projectRoot:root,allowedRoots:[root],
    contractSha256:sha(p('contract.json')),promptSha256:sha(p('executor-prompt.txt')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
  save(p('daemon-state.json'),{phase:'watching',pending:null,inflight:null});
  return {root,p,binding:JSON.parse(fs.readFileSync(p('binding.json'),'utf8'))};
}
const known=new Set(['C1','C2']);
const table={C1:{maxMinutes:20,basis:'前版同單號 14.0 分',cases:{A:14}}};
for(const [platform,scripts] of Object.entries(PLATFORMS)){
  const efficiency=require(path.join(scripts,'efficiency.cjs'));
  const cli=(name,args,env={})=>spawnSync(process.execPath,[path.join(scripts,name),...args],{encoding:'utf8',env:{...process.env,...env}});

  test(platform+': raising or removing an expectation needs Jay\'s words, tightening does not',t=>{
    const f=fixture(t,platform);
    efficiency.write(f.root,f.binding,{criteria:table},known);
    assert.throws(()=>efficiency.write(f.root,f.binding,{criteria:{C9:table.C1}},known),/沒有的條文/);
    assert.throws(()=>efficiency.write(f.root,f.binding,{criteria:{C1:{maxMinutes:20}}},known),/basis/);
    assert.throws(()=>efficiency.write(f.root,f.binding,{criteria:{C1:{...table.C1,cases:{A:30}}}},known),/Jay 的原話/,'a looser case limit');
    assert.throws(()=>efficiency.write(f.root,f.binding,{remove:['C1']},known),/Jay 的原話/,'removing is loosening');
    efficiency.write(f.root,f.binding,{criteria:{C1:{...table.C1,cases:{A:12}}}},known);
    assert.equal(efficiency.expectations(f.root).C1.cases.A,12);
    const quote='I23 放寬到 30 分',source=f.p('jay.md');fs.writeFileSync(source,quote);
    const authority={role:'user',quote,locator:'chat',at:'2026-11-27T01:00:00Z',source:{path:source,sha256:sha(source)}};
    assert.deepEqual(efficiency.write(f.root,f.binding,{criteria:{C1:{...table.C1,cases:{A:30}}},authority},known).loosened,['C1']);
  });

  test(platform+': a run over its limit cannot be PASS, and a slow FAIL counts once per criterion and revision',()=>{
    const criteria={C1:table.C1};
    assert.equal(efficiency.judge(criteria,attempt('A',13),[]),null,'within the limit adds nothing');
    assert.throws(()=>efficiency.judge(criteria,attempt('A',15)),/不能記 PASS/);
    assert.equal(efficiency.judge(criteria,attempt('B',25,'BLOCKED'),[]),null,'BLOCKED says nothing about the work');
    const verdict=efficiency.judge(criteria,attempt('B',25,'FAIL'),[]);
    assert.deepEqual([verdict.source,verdict.limit,verdict.minutes],['efficiency',20,25],'a case without its own limit takes the criterion\'s');
    assert.equal(efficiency.judge(criteria,attempt('A',16,'FAIL'),[verdict]),null,'the same revision already counted');
    assert.ok(efficiency.judge(criteria,attempt('A',16,'FAIL','r2'),[verdict]),'a new revision counts again');
  });

  test(platform+': the criterion may pass only when the latest run of every case passed within its limit',()=>{
    const criteria={C1:table.C1};
    assert.match(efficiency.blockers(criteria,[],'C1')[0],/沒有實跑紀錄/);
    assert.match(efficiency.blockers(criteria,[attempt('B',5)],'C1').join(),/案例 A 沒有實跑紀錄/,'a case named in the table must be run');
    const slow={...attempt('A',30,'FAIL'),finishedAt:at(30)},fast={...attempt('A',10),startedAt:at(40),finishedAt:at(50)};
    assert.equal(efficiency.blockers(criteria,[slow],'C1').length,1);
    assert.deepEqual(efficiency.blockers(criteria,[slow,fast],'C1'),[],'the latest run decides');
    assert.deepEqual(efficiency.blockers(criteria,[],'C2'),[],'criteria without an expectation are untouched');
  });

  test(platform+': the mainline records a slow run and the criterion is then held from acceptance',t=>{
    const f=fixture(t,platform);efficiency.write(f.root,f.binding,{criteria:table},known);
    const input={criterionId:'C1',caseId:'A',revision:'r1',outcome:'FAIL',reason:'7 份未讀完',evidence:[f.p('source')],startedAt:at(0),finishedAt:at(120)};
    save(f.p('run.json'),input);
    const sub=cli('efficiency.cjs',['run',f.root,f.p('run.json')],{CODEX_THREAD_ID:'sub-1',CODEX_SESSION_ID:'top-1'});
    assert.equal(sub.status,1);assert.match(sub.stderr,/子代理不能登記實跑/);
    const main=cli('efficiency.cjs',['run',f.root,f.p('run.json')],{CODEX_THREAD_ID:'top-1',CODEX_SESSION_ID:'top-1'});
    assert.equal(main.status,0,main.stderr);assert.match(JSON.parse(main.stdout).counted,/超過效率預期 14 分/);
    assert.equal(cli('efficiency.cjs',['run',f.root,f.p('run.json')]).status,0,'recording the same run again is idempotent');
    const rows=fs.readFileSync(f.p('acceptance-history.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r=>r.kind+':'+(r.source||'')),['attempt:','verdict:efficiency']);
    const rework=require(path.join(scripts,'rework.cjs'));
    assert.equal(rework.tally(rows).get('C1').failures.length,1,'the slow run is one failure of C1');
    save(f.p('dispatch.json'),{packages:{inFlight:[{id:'P1',acceptanceIds:['C1'],submission:{revision:'r1',manifest:'m'}}]}});
    const event={kind:'submission',revision:'r1',manifest:'m'};
    assert.throws(()=>rework.scope(f.root,f.binding,event,{disposition:'reply',packageRulings:[{id:'P1',accepted:['C1'],remaining:[]}]}),/C1 不能採認/);
    rework.scope(f.root,f.binding,event,{disposition:'reject',packageRulings:[{id:'P1',accepted:[],failed:['C1'],remaining:[]}]});
  });

  test(platform+': a real-run package of a criterion with an expectation takes the expectation as its baseline',t=>{
    const f=fixture(t,platform);efficiency.write(f.root,f.binding,{criteria:table},known);
    const pkg=baseline=>({packages:{inFlight:[{id:'P1',acceptanceIds:['C1'],baseline}]}});
    assert.throws(()=>efficiency.dispatchCheck(f.root,pkg({minutes:224.4,basis:'本場實測'}),null),/時程基準改用效率預期/);
    const b=efficiency.baseline(f.root,'C1',['A','B']);
    assert.equal(b.minutes,34);assert.match(b.basis,/^效率預期 C1/);
    efficiency.dispatchCheck(f.root,pkg(b),null);
    efficiency.dispatchCheck(f.root,pkg({minutes:30,basis:'Sonnet medium',model:'anthropic/claude-sonnet-5-5'}),null);
  });
}

