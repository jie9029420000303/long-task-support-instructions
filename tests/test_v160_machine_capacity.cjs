// v1.6.0 (Jay 2026-11-16: "技能都先修完，重開……直接開始量測是否有達到預期設計效果").
// 2026-11-14 a 16GB machine crashed while three long tasks dispatched on their own. Each run knew only its own
// subagents; the total of 8 Jay then set was split 4/2/2 by hand, so a waiting run's seats stayed idle. 34 subagents
// started at once at 00:46 and the platform refused 11 starts in 13 minutes. Nothing recorded the hours before.
// Every test here guards one of: the total is shared and seats flow to the run with work; a run is never left with no
// seat; starts are spread by the program, not by model turns; samples only record; a machine without the settings
// file behaves exactly as before.
const test=require('node:test');
const assert=require('node:assert/strict');
process.env.LONG_TASK_DISPATCH_HOLD_MS='0';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const codex=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claude=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const agents=count=>Array.from({length:count},(_,i)=>({id:'P'+i,handle:'agent:'+i,exclusiveResources:[],evidence:['plan']}));
function snapshot(executorId,inFlight=[],capacity={verified:19,evidence:['platform:list_agents']}){
  return {schemaVersion:1,executorId,planningRevision:'p1',activity:'working',capacity,updatedAt:'2026-11-16T00:00:00Z',
    packages:{ready:[],inFlight,returned:[],blocked:[],completed:[],recurringRework:[]}};
}
// A machine home with one or more supervised runs registered in it, the way the watcher registers them.
function machine(settings){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v160-')),home=path.join(root,'home');fs.mkdirSync(home);
  if(settings)save(path.join(home,'capacity.json'),settings);
  const previous=process.env.LONG_TASK_HOME;process.env.LONG_TASK_HOME=home;
  const run=(name,inFlight=[],capacity)=>{
    const dir=path.join(root,name);fs.mkdirSync(dir);
    const source=path.join(dir,'source');fs.writeFileSync(source,'criterion\n');
    save(path.join(dir,'contract.json'),{goal:'g',authorization:'isolated test',criteria:[{id:'A1',requirement:'r',source:'source:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
    const binding={platform:'codex',projectRoot:root,allowedRoots:[root,dir],executorId:'executor-'+name,supervisorId:'supervisor-'+name,
      contractSha256:sha(path.join(dir,'contract.json')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
    save(path.join(dir,'binding.json'),binding);save(path.join(dir,'dispatch.json'),snapshot(binding.executorId,inFlight,capacity));
    require(path.join(codex,'watch-guard.cjs')).register(dir);
    return {dir,binding,snapshot:()=>JSON.parse(fs.readFileSync(path.join(dir,'dispatch.json'),'utf8')),set:list=>save(path.join(dir,'dispatch.json'),snapshot(binding.executorId,list,capacity))};
  };
  return {root,home,run,close(){if(previous===undefined)delete process.env.LONG_TASK_HOME;else process.env.LONG_TASK_HOME=previous;fs.rmSync(root,{recursive:true,force:true});}};
}
const throttle=limit=>({verified:19,evidence:['platform:list_agents'],throttle:{limit,reason:'Jay 2026-11-14 合計上限',source:'supervisor'}});

for(const [name,scripts] of [['codex',codex],['claude',claude]]){
  const audit=require(path.join(scripts,'dispatch-audit.cjs'));
  // Free seats as each platform reports them to its dispatch review.
  const free=(r)=>name==='codex'?audit.planReview(r.snapshot(),r.binding,r.dir).capacity.free:audit.freeCapacity(r.snapshot(),r.binding,r.dir);
  test(name+': the machine total is shared, so seats another run is not using flow to the run that has work',()=>{
    const m=machine({totalAgents:8});try{
      const waiting=m.run('accounting-d'),busy=m.run('accounting-e',[...agents(6),{id:'MAIN',handle:'main',exclusiveResources:[],evidence:['plan']},{id:'TESTS',handle:'resource:suite',exclusiveResources:[],evidence:['plan']}]);
      assert.equal(free(waiting),2,'8 in total, the other run has 6 subagents: main-line work and resource processes take no seat');
      assert.equal(free(busy),2,'the busy run itself: 8 minus its own 6, the idle run takes nothing from it');
      busy.set(agents(1));assert.equal(free(waiting),7,'the other run finished 5: those seats are free here at once, with no hand-split to revise');
      waiting.set(agents(7));assert.equal(free(busy),0);assert.equal(free(waiting),0);
    }finally{m.close();}
  });
  test(name+': a run keeps its own smaller limit, and is never left without a seat',()=>{
    const m=machine({totalAgents:8});try{
      const small=m.run('small',[],throttle(2)),full=m.run('full',agents(8));
      assert.equal(free(small),1,'the others hold all 8: one seat stays, so every running task can still move');
      full.set([]);assert.equal(free(small),2,'the run\'s own limit of 2 still holds when the machine has room');
    }finally{m.close();}
  });
  test(name+': a stopped run, or one whose snapshot nobody has written for hours, holds no seats',()=>{
    const m=machine({totalAgents:8});try{
      const mine=m.run('mine'),other=m.run('other',agents(6));
      assert.equal(free(mine),2);
      const old=new Date(Date.now()-7*3600000);fs.utimesSync(path.join(other.dir,'dispatch.json'),old,old);
      assert.equal(free(mine),8,'an executor that died mid-flight must not keep seats from every other run for good');
      other.set(agents(6));assert.equal(free(mine),2);
      fs.writeFileSync(path.join(other.dir,'STOP'),'');assert.equal(free(mine),8);
    }finally{m.close();}
  });
  test(name+': without the settings file a run uses its platform seats exactly as before',()=>{
    const m=machine(null);try{
      const mine=m.run('mine',agents(3));m.run('other',agents(12));
      assert.equal(free(mine),16,'19 verified seats minus its own 3; other runs are not counted');
      if(name==='codex')assert.equal('machine' in audit.planReview(mine.snapshot(),mine.binding,mine.dir).capacity,false);
    }finally{m.close();}
  });
}
test('the missed-dispatch review and the executor see the same shared limit',()=>{
  const m=machine({totalAgents:8});try{
    const audit=require(path.join(codex,'dispatch-audit.cjs'));
    const mine=m.run('mine',agents(1)),other=m.run('other',agents(6));
    const s=mine.snapshot();s.packages.ready=['R1','R2','R3'].map(id=>({id,independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan']}));
    const lead=audit.derive(s,mine.binding,mine.dir).find(item=>item.kind==='ready_capacity');
    assert.equal(lead.detail.freeCapacity,1,'8 - 6 others - 1 own: asking for three more would push the machine past its total');
    const review=audit.planReview(s,mine.binding,mine.dir).capacity;
    assert.deepEqual([review.dispatchLimit,review.free,review.machine],[2,1,{total:8,others:6}]);
    other.set(agents(7));assert.equal(audit.derive(s,mine.binding,mine.dir).some(item=>item.kind==='ready_capacity'),false,'at the shared limit nothing is reported as missed dispatch');
  }finally{m.close();}
});

function packages(m,ids){
  const r=m.run('mine'),state=path.join(m.root,'state'),wp=path.join(state,'wp');fs.mkdirSync(wp,{recursive:true});
  for(const id of ids)fs.writeFileSync(path.join(wp,id+'.md'),'[工作包] id='+id+'；類型＝B 技術；依賴：無；目前錯誤次數 0\n[狀態] {"list":"ready"}\n[共用資源] worktree:'+id+'\n\n## 共同規則\n');
  const base=path.join(m.root,'base.json');save(base,{capacity:{verified:19,evidence:['platform:list_agents']}});
  const cli=args=>execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),...args],{stdio:'pipe',encoding:'utf8'});
  cli(['from-wp',r.dir,state,'--base',base,'--revision','p1']);
  const mark=(id,status)=>{const began=Date.now(),out=JSON.parse(cli(['mark',r.dir,state,id,JSON.stringify(status)]));return {out,ms:Date.now()-began};};
  return {...r,mark};
}
const going=id=>({list:'inFlight',handle:'agent:'+id,baseline:{minutes:20,startedAt:new Date().toISOString(),basis:'test'}});
test('starts beyond one batch are spread out inside the command; a refill of one never waits',()=>{
  const m=machine({stagger:{batch:2,seconds:2}});try{
    const p=packages(m,['B1','B2','B3','B4','MAIN']);
    const first=p.mark('B1',going('B1')),second=p.mark('B2',going('B2'));
    assert.equal(first.out.staggeredSeconds,undefined);assert.equal(second.out.staggeredSeconds,undefined);
    const main=p.mark('MAIN',{list:'inFlight',handle:'main'});
    assert.equal(main.out.staggeredSeconds,undefined,'main-line work starts no subagent');assert.ok(main.ms<1500,'took '+main.ms+' ms');
    const third=p.mark('B3',going('B3'));
    assert.ok(third.out.staggeredSeconds>=1&&third.ms>=1000,'the third start within the window waits for it: '+JSON.stringify([third.out.staggeredSeconds,third.ms]));
    assert.deepEqual(p.snapshot().packages.inFlight.map(item=>item.id).sort(),['B1','B2','B3','MAIN'],'the wait delays the start, it never drops it');
    const again=p.mark('B3',going('B3'));
    assert.equal(again.out.staggeredSeconds,undefined,'a new baseline for a package already in flight is not a start');
    execFileSync('/bin/sleep',['2.1']);
    const refill=p.mark('B4',going('B4'));
    assert.equal(refill.out.staggeredSeconds,undefined,'one package handed back, one dispatched: no delay');assert.ok(refill.ms<1500,'took '+refill.ms+' ms');
  }finally{m.close();}
});
test('without a stagger setting marking adds no wait and leaves no file',()=>{
  const m=machine({totalAgents:8});try{
    const p=packages(m,['B1','B2','B3','B4']);
    for(const id of ['B1','B2','B3','B4'])assert.equal(p.mark(id,going(id)).out.staggeredSeconds,undefined);
    assert.equal(fs.existsSync(path.join(p.dir,'dispatch-starts.json')),false);
  }finally{m.close();}
});

const tool=require(path.join(codex,'machine.cjs'));
function usage(m,delays,at=Date.now()){
  const file=path.join(m.root,'usage.jsonl');
  fs.writeFileSync(file,delays.map((ms,i)=>JSON.stringify({timestamp:at-i*1000,routeDecision:{createdAt:at-i*1000+ms}})).join('\n')+'\n');
  process.env.LONG_TASK_USAGE_LOG=file;
}
test('one sample a minute however many callers; it records the signals and limits nothing',()=>{
  const m=machine({totalAgents:8,slowCommandMs:1e9,restartSwapFiles:1e9,restartUptimeDays:1e9});try{
    const mine=m.run('mine',agents(3));m.run('other',agents(2));
    const now=Date.now();usage(m,[20,30,40],now);
    const first=tool.sample(now);
    assert.deepEqual([first.route,first.agentsInFlight,first.slow,first.restartHint],[{requests:3,medianMs:30},5,false,false]);
    assert.ok(first.commandMs>0&&first.uptimeDays>0);
    assert.equal(tool.sample(now+20000),null,'a second caller within the minute writes nothing');
    usage(m,[400,500,600],now+61000);
    const second=tool.sample(now+61000);
    assert.equal(second.slow,true,'routing at 500 ms is the stuck range measured on 2026-11-14 (225-2,161 ms)');
    const file=fs.readdirSync(path.join(m.home,'samples')).filter(name=>name.startsWith('machine-'));
    assert.equal(fs.readFileSync(path.join(m.home,'samples',file[0]),'utf8').trim().split('\n').length,2);
    const audit=require(path.join(codex,'dispatch-audit.cjs'));
    assert.equal(audit.planReview(mine.snapshot(),mine.binding,mine.dir).capacity.free,3,'a slow sample changes no limit: 8 - 2 others - 3 own');
  }finally{delete process.env.LONG_TASK_USAGE_LOG;m.close();}
});
test('the supervisor hears about a slow or restart-due machine only from a recent sample; old sample files are dropped',()=>{
  const m=machine({slowCommandMs:1e9,restartSwapFiles:1e9,restartUptimeDays:0.000001});try{
    const mine=m.run('mine'),now=Date.now();usage(m,[20],now);
    fs.mkdirSync(path.join(m.home,'samples'));
    fs.writeFileSync(path.join(m.home,'samples','machine-2020-01-01.jsonl'),'{}\n');fs.writeFileSync(path.join(m.home,'samples','heavy-2020-01.jsonl'),'{}\n');
    assert.equal(tool.hint(mine.dir,now),null,'no sample yet');
    const entry=tool.sample(now);assert.equal(entry.restartHint,true);
    assert.deepEqual(Object.keys(tool.hint(mine.dir,now)).sort(),['at','commandMs','restartHint','routeMedianMs','slow','swapFiles','uptimeDays']);
    assert.equal(tool.hint(mine.dir,now+16*60000),null,'a sample older than 15 minutes says nothing about now');
    assert.deepEqual(fs.readdirSync(path.join(m.home,'samples')).filter(name=>name.includes('2020')),['heavy-2020-01.jsonl'],'machine samples keep 30 days; other records are not this function\'s to delete');
    save(path.join(m.home,'capacity.json'),{slowCommandMs:1e9,restartSwapFiles:1e9,restartUptimeDays:1e9});
    tool.sample(now+61000);assert.equal(tool.hint(mine.dir,now+61000),null,'a healthy machine adds nothing to the brief');
  }finally{delete process.env.LONG_TASK_USAGE_LOG;m.close();}
});
test('the launchd guard records the sample and keeps its own log from growing without end',()=>{
  const m=machine({totalAgents:8});try{
    const log=path.join(m.home,'watch-guard.log');fs.writeFileSync(log,Buffer.alloc(5*1024*1024+1,'x'));fs.writeFileSync(log+'.1','older');
    execFileSync(process.execPath,[path.join(codex,'watch-guard.cjs'),'check'],{env:{...process.env,LONG_TASK_HOME:m.home},stdio:'pipe'});
    assert.equal(fs.statSync(log+'.1').size,5*1024*1024+1,'the full log becomes the one earlier copy');assert.equal(fs.existsSync(log),false);
    const samples=fs.readdirSync(path.join(m.home,'samples'));assert.equal(samples.length,1);
    const small=path.join(m.home,'small.log');fs.writeFileSync(small,'x');assert.equal(tool.rotate(small),false);assert.equal(fs.existsSync(small),true);
  }finally{m.close();}
});
test('both platforms ship the same shared-limit program',()=>{
  for(const file of ['machine.cjs','dispatch.cjs','watch-guard.cjs'])assert.equal(sha(path.join(codex,file)),sha(path.join(claude,file)),file);
});

