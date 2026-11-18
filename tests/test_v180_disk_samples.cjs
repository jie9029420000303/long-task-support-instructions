// v1.8.0 (Jay 2026-11-18 chose "record and remind" for low disk, nothing is held back). That morning the data volume
// fell to 0.14GiB, Docker stopped itself on "no space left on device" at 08:41 and every container, test databases
// included, went down; no sample had recorded free space and nobody was warned. Each test guards one of: free space is
// in every sample; a low disk reaches the supervisor's brief and a critical one reaches the phone at most once per 6
// hours; the thresholds are Jay's to change; and none of it limits or delays any dispatch.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const codex=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claude=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const tool=require(path.join(codex,'machine.cjs'));
const GiB=2**30;
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Settings that keep the other signals quiet, so only the disk can raise a hint.
const quiet={slowCommandMs:1e9,slowRouteMs:1e9,restartSwapFiles:1e9,restartUptimeDays:1e9};
function home(settings,freeGiB){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v180-')),dir=path.join(root,'home');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'capacity.json'),JSON.stringify({...quiet,...settings}));
  const run=path.join(root,'run');fs.mkdirSync(run);
  const saved={home:process.env.LONG_TASK_HOME,free:process.env.LONG_TASK_DISK_FREE_BYTES,log:process.env.LONG_TASK_USAGE_LOG};
  process.env.LONG_TASK_HOME=dir;process.env.LONG_TASK_DISK_FREE_BYTES=String(freeGiB*GiB);process.env.LONG_TASK_USAGE_LOG=path.join(root,'none.jsonl');
  const restore=(key,value)=>{if(value===undefined)delete process.env[key];else process.env[key]=value;};
  return {root,dir,run,set(free){process.env.LONG_TASK_DISK_FREE_BYTES=String(free*GiB);},
    close(){restore('LONG_TASK_HOME',saved.home);restore('LONG_TASK_DISK_FREE_BYTES',saved.free);restore('LONG_TASK_USAGE_LOG',saved.log);fs.rmSync(root,{recursive:true,force:true});}};
}

test('every sample records free disk space, and the two default levels are 20 and 8 GiB',()=>{
  const h=home({},50);try{
    const now=Date.now();
    const healthy=tool.sample(now);
    assert.deepEqual([healthy.diskFreeGiB,healthy.diskLow,healthy.diskCritical],[50,false,false]);
    assert.equal(tool.hint(h.run,now),null,'50 GiB free adds nothing to the brief');
    h.set(15);const low=tool.sample(now+61000);
    assert.deepEqual([low.diskFreeGiB,low.diskLow,low.diskCritical],[15,true,false]);
    const brief=tool.hint(h.run,now+61000);
    assert.deepEqual([brief.diskFreeGiB,brief.diskLow,brief.diskCritical],[15,true,false],'below 20 GiB the supervisor tells Jay at a safe point');
    assert.equal(tool.diskNotice(low),null,'between 8 and 20 GiB nothing goes to the phone');
    h.set(0.14);const critical=tool.sample(now+122000);
    assert.equal(critical.diskCritical,true,'the 2026-11-18 morning: 0.14 GiB');
    const notice=tool.diskNotice(critical);
    assert.match(notice.text,/只剩 0\.1 GiB（低於 8 GiB）/);
    assert.match(notice.text,/不會自動停工或刪檔/,'the notice says the skill itself deletes and stops nothing');
    assert.match(notice.key,/^disk-critical-\d{4}-\d\d-\d\d-[0-3]$/,'one notice per 6-hour block, not one every 3 minutes');
  }finally{h.close();}
});

test('Jay can move both levels in capacity.json',()=>{
  const h=home({lowDiskGiB:50,criticalDiskGiB:30},40);try{
    const entry=tool.sample(Date.now());
    assert.deepEqual([entry.diskLow,entry.diskCritical],[true,false]);
    h.set(25);assert.equal(tool.sample(Date.now()+61000).diskCritical,true);
  }finally{h.close();}
});

test('a low or critical disk limits nothing: the dispatch limit and stagger are what they were',()=>{
  const h=home({totalAgents:8},0.5);try{
    tool.sample(Date.now());
    const binding={executorId:'executor-x'};
    fs.writeFileSync(path.join(h.run,'binding.json'),JSON.stringify(binding));
    assert.equal(tool.dispatchLimit(binding,path.join(os.homedir(),'not-a-temp-run'),5).limit,5,'nothing else in flight: the run keeps its own 5');
    assert.equal(tool.staggerWait(h.run),0);
  }finally{h.close();}
});

test('the launchd guard pushes a critical disk once per block and records the outcome; a second check does not send again',()=>{
  const h=home({},1);try{
    const env={...process.env,LONG_TASK_HOME:h.dir,LONG_TASK_DISK_FREE_BYTES:String(1*GiB),LONG_TASK_NOTIFY_DISABLE:'1'};
    execFileSync(process.execPath,[path.join(codex,'watch-guard.cjs'),'check'],{env,stdio:'pipe'});
    const claims=()=>fs.readdirSync(path.join(h.dir,'notifications')).filter(name=>name.startsWith('disk-critical-'));
    assert.equal(claims().length,1);
    const record=JSON.parse(fs.readFileSync(path.join(h.dir,'notifications',claims()[0]),'utf8'));
    assert.equal(record.ok,false,'a test home under the temp directory never reaches the phone');
    assert.match(record.text,/只剩 1 GiB/);
    fs.utimesSync(path.join(h.dir,'samples',fs.readdirSync(path.join(h.dir,'samples'))[0]),new Date(0),new Date(0));
    execFileSync(process.execPath,[path.join(codex,'watch-guard.cjs'),'check'],{env,stdio:'pipe'});
    assert.equal(claims().length,1,'the same 6-hour block: no second notice');
  }finally{h.close();}
});

test('both platforms ship the same machine and guard programs',()=>{
  for(const file of ['machine.cjs','watch-guard.cjs'])assert.equal(sha(path.join(codex,file)),sha(path.join(claude,file)),file);
});

