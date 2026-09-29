const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
async function until(check,ms=12000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {if(check()) return;await new Promise(resolve=>setTimeout(resolve,80));}
  throw Error('Timed out waiting for watcher state');
}

test('resident Codex watcher reads exact final, confirms one delivery, and accepts one revision',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-watch-'));
  const source=path.join(root,'source.txt'),candidate=path.join(root,'candidate.txt'),manifest=path.join(root,'manifest.json');
  fs.writeFileSync(source,'Required output: alpha LF beta LF\n');fs.writeFileSync(candidate,'alpha\nbeta\n');
  save(manifest,{files:[{path:candidate,sha256:sha(candidate)}]});
  const contract={goal:'Produce exact two-line file',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Exact two-line file',source:'source.txt:1',verify:'Read bytes'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),contract);
  const supervisorId='supervisor-qa',executorId='executor-qa';
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],
    supervisorId,executorId,callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json'))});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const final='QA result submitted.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest});
  const fixture=path.join(root,'mock.json'),sentFile=path.join(root,'sent.json');
  save(fixture,{supervisorId,executorId,final});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{
    env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sentFile},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  try {
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    await until(()=>{const s=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));return s.pending?.kind==='submission' && s.messages.length===1;});
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.revision,'sha256:'+sha(manifest));
    assert.equal(state.pid,child.pid);
    const receipt=JSON.parse(fs.readFileSync(path.join(run,'receipt-review-executor-turn-1.json')));
    assert.equal(receipt.confirmed,true);
    assert.equal(JSON.parse(fs.readFileSync(sentFile)).length,1);
    save(path.join(run,'decision-executor-turn-1.json'),{eventId:'executor-turn-1',disposition:'accept',revision:state.pending.revision,
      results:[{id:'A1',status:'PASS',method:'Read exact bytes',expected:'alpha LF beta LF',actual:'alpha LF beta LF',evidence:[{path:candidate,sha256:sha(candidate)}]}]});
    try {
      await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).phase==='accepted');
    } catch (error) {
      throw Error(error.message+'; state='+fs.readFileSync(path.join(run,'daemon-state.json'),'utf8')+'; stderr='+stderr);
    }
    const checked=JSON.parse(require('node:child_process').execFileSync(process.execPath,
      [path.join(scripts,'supervise.cjs'),'decision',run,path.join(run,'decision-executor-turn-1.json')],{encoding:'utf8'}));
    assert.equal(checked.valid,true);
    assert.equal(checked.processed,true);
    assert.equal(JSON.parse(fs.readFileSync(sentFile)).length,1);
  } finally {child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});
