// v1.2.1 (Jay 2026-11-09「修」): at 16:39 the App moved WEB's supervisor chat to a new log segment and killed the exec
// session holding run-watch.cjs, and the watcher died with it (same process group). Questions the executor asked at
// 17:15, 17:29 and 17:52 never reached the supervisor, and the supervisor answered Jay three times without remounting.
// Now the watcher runs in its own process group and keeps watching; the supervisor runs the start command at the start
// of every turn, which takes over a watcher still running and never starts a second one.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const scripts=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{if(check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out');}
const pgid=pid=>Number(execFileSync('ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8'}).trim());
// lsof prints non-ASCII bytes as \xNN.
const cwdOf=pid=>Buffer.from(execFileSync('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('n')).slice(1)
  .replace(/\\x([0-9a-f]{2})/gi,(match,hex)=>String.fromCharCode(parseInt(hex,16))),'latin1').toString('utf8');
// Every native watcher on this run, read from the process table.
const watchers=run=>execFileSync('ps',['-axww','-o','pid=,command='],{encoding:'utf8'}).split('\n')
  .filter(line=>line.includes('native-watch.cjs')&&line.includes(run)).map(line=>Number(line.trim().split(/\s+/)[0]));
function codexRun(root,state={}){
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep watching\n');
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),{goal:'Keep watching',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Watch',source:'source.txt:1',verify:'Read'}],sources:[{path:source,sha256:sha(source)}]});
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'qa-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,...state});
  save(path.join(root,'mock.json'),{supervisorId:'supervisor-qa',executorId:'executor-qa',noTurn:true});
  return run;
}
function env(root){
  const value={...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:path.join(root,'mock.json'),
    MOCK_CODEX_SENT:path.join(root,'sent.json'),CODEX_HOME:path.join(root,'isolated-codex'),LONG_TASK_REGISTER:'0',CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  for(const name of ['LONG_TASK_NOTIFY_CONFIG','LONG_TASK_HOME','LONG_TASK_TELEGRAM_TOKEN'])delete value[name];
  return value;
}
// A parent in its own group, so the test can kill that group the way the App does without touching the test runner.
const parentOf=(run,root)=>spawn(process.execPath,[path.join(scripts,'run-watch.cjs'),run],{env:env(root),detached:true,stdio:'ignore'});
const status=run=>JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'status',run],{encoding:'utf8'}));

test('the watcher outlives a parent the App kills, and the next start takes it over instead of starting a second',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-survival-')),run=codexRun(root),pids=[];
  try{
    const first=parentOf(run,root);pids.push(first.pid);
    await until(()=>fs.existsSync(path.join(run,'native-ready.json'))&&read(path.join(run,'daemon-state.json')).reads>=2);
    const watcher=read(path.join(run,'runtime-state.json')).launches[0].pid;pids.push(watcher);
    assert.equal(read(path.join(run,'watcher.lock')).pid,watcher);
    assert.equal(pgid(watcher),watcher,'the watcher leads its own process group');assert.notEqual(pgid(watcher),pgid(first.pid));
    // Left to launchd it must not sit in the task: the executor's resource check lists such processes as unregistered.
    assert.equal(cwdOf(watcher),fs.realpathSync(scripts));
    // The App ends the exec session: SIGKILL to the parent's whole process group (exit 137 on 2026-11-09 16:39).
    process.kill(-first.pid,'SIGKILL');
    await until(()=>!alive(first.pid));
    const before=read(path.join(run,'daemon-state.json')).reads;
    await until(()=>read(path.join(run,'daemon-state.json')).reads>=before+3);
    assert.ok(alive(watcher),'the watcher keeps reading after its parent is gone');
    // Not an outage while the watcher works; status says how to put a parent back over it.
    delete require.cache[path.join(scripts,'watch-health.cjs')];
    const outage=require(path.join(scripts,'watch-health.cjs')).outageOf(run);
    assert.equal(outage.kind,undefined);assert.equal(outage.processUnknown,undefined);
    const orphan=status(run);
    assert.equal(orphan.active,true);assert.equal(orphan.watch.parentAlive,false);assert.equal(orphan.watch.orphaned,true);
    assert.equal(orphan.watch.restartCommand,null,'nothing to restart: the watcher still runs');
    assert.match(orphan.watch.remountCommand,/run-watch\.cjs' '/);
    // The supervisor's next turn starts a parent: it takes the running watcher over and starts no second one.
    const second=parentOf(run,root);pids.push(second.pid);
    await until(()=>read(path.join(run,'runtime-state.json')).pid===second.pid);
    await new Promise(resolve=>setTimeout(resolve,2500));
    const runtime=read(path.join(run,'runtime-state.json'));
    assert.deepEqual(runtime.launches.map(item=>({pid:item.pid,adopted:item.adopted})),[{pid:watcher,adopted:true}]);
    assert.deepEqual(watchers(run),[watcher],'one watcher on the run');assert.equal(read(path.join(run,'watcher.lock')).pid,watcher);
    const remounted=status(run);assert.equal(remounted.watch.parentAlive,true);assert.equal(remounted.watch.orphaned,false);assert.equal(remounted.watch.remountCommand,null);
    // A third start in a later turn leaves the live parent alone.
    const third=spawnSync(process.execPath,[path.join(scripts,'run-watch.cjs'),run],{env:env(root),encoding:'utf8',timeout:10000});
    assert.equal(third.status,0);assert.equal(JSON.parse(third.stdout).alreadyRunning,second.pid);
    // Stopping the new parent stops the watcher it took over.
    process.kill(second.pid,'SIGTERM');
    await until(()=>!alive(watcher)&&!alive(second.pid));
    assert.equal(read(path.join(run,'runtime-state.json')).phase,'stopped');
  }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});}
});

test('a reused parent PID does not block the start, and a finished run is never started',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-start-')),pids=[];
  try{
    // The recorded parent PID now belongs to another program: a fresh heartbeat does not make it the parent.
    const stranger=spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});pids.push(stranger.pid);
    const run=codexRun(root);
    save(path.join(run,'runtime-state.json'),{pid:stranger.pid,heartbeatAt:new Date().toISOString(),phase:'running',launches:[]});
    const parent=parentOf(run,root);pids.push(parent.pid);
    await until(()=>read(path.join(run,'runtime-state.json')).pid===parent.pid&&fs.existsSync(path.join(run,'native-ready.json')));
    pids.push(read(path.join(run,'runtime-state.json')).launches[0].pid);
    process.kill(parent.pid,'SIGTERM');await until(()=>!alive(parent.pid));
    // STOP, acceptance, a stop and a delivery that waits for manual reconciliation: the start leaves the run down.
    for(const [name,state,stop] of [['STOP',{phase:'watching'},true],['accepted',{phase:'accepted'}],['stopped',{phase:'stopped'}],['needs_reconcile',{phase:'needs_reconcile',inflight:null}]]){
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watch-ended-')),done=codexRun(dir,state);
      if(stop)fs.writeFileSync(path.join(done,'STOP'),'stop\n');
      const before=fs.readFileSync(path.join(done,'daemon-state.json'));
      const result=spawnSync(process.execPath,[path.join(scripts,'run-watch.cjs'),done],{env:env(dir),encoding:'utf8',timeout:10000});
      assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ended:name,run:done});
      assert.equal(fs.existsSync(path.join(done,'runtime-state.json')),false,name+': no parent record');
      assert.deepEqual(fs.readFileSync(path.join(done,'daemon-state.json')),before,name+': watcher state untouched');
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});}
});

test('the run is reported down only when parent and watcher are both gone, timed from the watcher\'s last work',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-down-'));
  try{
    const dead=Number(spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim());
    // The parent died two hours ago; the watcher it left kept working until three minutes ago.
    const run=codexRun(root,{phase:'watching',updatedAt:minutesAgo(3)});
    save(path.join(run,'runtime-state.json'),{pid:dead,heartbeatAt:minutesAgo(120),phase:'running',launches:[]});
    save(path.join(run,'watcher.lock'),{pid:dead});
    delete require.cache[path.join(scripts,'watch-health.cjs')];
    const health=require(path.join(scripts,'watch-health.cjs'));
    const down=health.outageOf(run);
    assert.equal(down.kind,'watcher_dead');assert.ok(Math.abs(down.since-Date.parse(minutesAgo(3)))<5000,'timed from the watcher, not the parent');
    // A lock PID now used by another program is not a running watcher.
    save(path.join(run,'watcher.lock'),{pid:process.pid});
    assert.equal(health.outageOf(run).kind,'watcher_dead');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
