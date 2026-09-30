const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const versions = [
  ['codex', path.join(repo,'codex/.agents/skills/long-task-supervisor/scripts')],
  ['claude', path.join(repo,'claude-code/.claude/skills/long-task-supervisor/scripts')]
];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-task-supervisor-'));
  const source=path.join(root,'decision-source.md'),candidate=path.join(root,'candidate.txt');
  fs.writeFileSync(source,'Original criterion: output must be correct.\n');
  fs.writeFileSync(candidate,'verified candidate\n');
  const manifest=path.join(root,'candidate.json');
  fs.writeFileSync(manifest,JSON.stringify({files:[{path:candidate,sha256:sha(candidate)}]}));
  const contract={goal:'Deliver the verified candidate',authorization:'User authorized this isolated QA',
    criteria:[{id:'A1',requirement:'Output matches the source',source:'source.md:1',verify:'Open candidate and compare'}],
    sources:[{path:source,sha256:sha(source)}]};
  const config={allowedRoots:[root]};
  const event={id:'turn-one',kind:'submission',revision:'sha256:'+sha(manifest),manifest};
  const decision={eventId:'turn-one',disposition:'accept',revision:event.revision,
    results:[{id:'A1',status:'PASS',method:'Opened candidate and compared the source',expected:'correct',actual:'correct',
      evidence:[{path:candidate,sha256:sha(candidate)}]}]};
  return {root,source,candidate,manifest,contract,config,event,decision};
}

for (const [platform,dir] of versions) {
  const guard=require(path.join(dir,'guard.cjs'));
  test(platform+' confirms the same decision after the watcher has processed it',()=>{
    const f=fixture(),run=path.join(f.root,'run'),decisionFile=path.join(run,'decision-turn-one.json');
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run,'contract.json'),JSON.stringify(f.contract));
    fs.writeFileSync(path.join(run,'binding.json'),JSON.stringify({allowedRoots:[f.root],contractSha256:sha(path.join(run,'contract.json'))}));
    fs.writeFileSync(decisionFile,JSON.stringify(f.decision));
    fs.writeFileSync(path.join(run,'daemon-state.json'),JSON.stringify({phase:'accepted',pending:null,
      resolved:{'turn-one':{event:f.event,decisionSha256:sha(decisionFile)}}}));
    const command=[path.join(dir,'supervise.cjs'),'decision',run,decisionFile];
    const checked=JSON.parse(execFileSync(process.execPath,command,{encoding:'utf8'}));
    assert.equal(checked.valid,true);
    assert.equal(checked.processed,true);
    fs.writeFileSync(decisionFile,JSON.stringify({...f.decision,unexpected:'changed'}));
    assert.throws(()=>execFileSync(process.execPath,command,{stdio:'pipe'}),/Command failed/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' refuses acceptance when candidate changes after submission',()=>{
    const f=fixture();
    assert.doesNotThrow(()=>guard.validateDecision(f.config,f.contract,f.event,f.decision));
    fs.writeFileSync(f.candidate,'changed after submission');
    assert.throws(()=>guard.validateDecision(f.config,f.contract,f.event,f.decision),/Candidate file missing or changed/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' refuses incomplete or mismatched acceptance',()=>{
    const f=fixture();
    assert.throws(()=>guard.validateDecision(f.config,f.contract,f.event,{...f.decision,revision:'sha256:'+'0'.repeat(64)}),/version differs/);
    assert.throws(()=>guard.validateDecision(f.config,f.contract,f.event,{...f.decision,results:[]}),/Incomplete acceptance/);
    assert.throws(()=>guard.validateDecision(f.config,f.contract,{...f.event,kind:'progress'},f.decision),/Only a submitted/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' observe records a reason without reply, delivery, or acceptance fields',()=>{
    const f=fixture(),event={id:'rillet-known-block',kind:'blocked'};
    const observe={eventId:event.id,disposition:'observe',reason:'The merge remains pending explicit user approval; no repeated executor message is useful.',
      pendingApprovals:['Merge PR #26 into develop']};
    assert.doesNotThrow(()=>guard.validateDecision(f.config,f.contract,event,observe));
    assert.throws(()=>guard.validateDecision(f.config,f.contract,event,{...observe,reason:'  '}),/Missing observe reason/);
    for (const field of ['reply','delivery','revision','results']) {
      assert.throws(()=>guard.validateDecision(f.config,f.contract,event,{...observe,[field]:field==='results'?[]:'x'}),/Observe cannot include/);
    }
    assert.throws(()=>guard.validateDecision(f.config,f.contract,event,{...observe,pendingApprovals:[]}),/Invalid pending approvals/);
    assert.throws(()=>guard.validateDecision(f.config,f.contract,event,{...observe,pendingApprovals:['']}),/Invalid pending approvals/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' confirms the original observe decision and rejects later edits',()=>{
    const f=fixture(),run=path.join(f.root,'run'),event={id:'rillet-known-block',kind:'blocked'};
    const decision={eventId:event.id,disposition:'observe',reason:'The approval is already pending.',pendingApprovals:['Merge PR #26 into develop']};
    const decisionFile=path.join(run,'decision-rillet-known-block.json');fs.mkdirSync(run);
    fs.writeFileSync(path.join(run,'contract.json'),JSON.stringify(f.contract));
    fs.writeFileSync(path.join(run,'binding.json'),JSON.stringify({allowedRoots:[f.root],contractSha256:sha(path.join(run,'contract.json'))}));
    fs.writeFileSync(decisionFile,JSON.stringify(decision));
    fs.writeFileSync(path.join(run,'daemon-state.json'),JSON.stringify({phase:'idle',pending:null,
      resolved:{[event.id]:{event,decision,decisionSha256:sha(decisionFile)}}}));
    const command=[path.join(dir,'supervise.cjs'),'decision',run,decisionFile];
    const checked=JSON.parse(execFileSync(process.execPath,command,{encoding:'utf8'}));
    assert.equal(checked.processed,true);
    fs.writeFileSync(decisionFile,JSON.stringify({...decision,reason:'Changed after resolution'}));
    assert.throws(()=>execFileSync(process.execPath,command,{stdio:'pipe'}),/Command failed/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' locks the original acceptance source',()=>{
    const f=fixture();
    fs.writeFileSync(f.source,'weakened criterion');
    assert.throws(()=>guard.validateContract(f.contract),/changed/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
  test(platform+' generates a complete submission marker from actual files',()=>{
    const f=fixture(),newManifest=path.join(f.root,'generated.json');
    const output=execFileSync(process.execPath,[path.join(dir,'candidate.cjs'),newManifest,f.candidate],{encoding:'utf8'}).trim();
    const event=JSON.parse(output.slice('LONG_TASK_EVENT '.length));
    assert.equal(output.startsWith('LONG_TASK_EVENT '),true);
    assert.equal(event.revision,'sha256:'+sha(newManifest));
    assert.equal(event.manifest,newManifest);
    assert.throws(()=>execFileSync(process.execPath,[path.join(dir,'candidate.cjs'),newManifest,f.candidate],{stdio:'pipe'}),/Command failed/);
    fs.rmSync(f.root,{recursive:true,force:true});
  });
}

test('Codex run binds two exact threads and is not active before a verified read',()=>{
  const f=fixture(),run=path.join(f.root,'run'),input=path.join(f.root,'input.json');
  fs.writeFileSync(input,JSON.stringify({projectRoot:f.root,allowedRoots:[f.root],
    supervisorId:'supervisor-thread',executorId:'executor-thread',contract:f.contract}));
  const script=versions[0][1]+'/supervise.cjs';
  const env={...process.env,CODEX_THREAD_ID:'supervisor-thread',CODEX_TURN_ID:'supervisor-turn'};
  const initialized=JSON.parse(execFileSync(process.execPath,[script,'init',run,input],{env}).toString());
  assert.equal(initialized.executorId,'executor-thread');
  const status=JSON.parse(execFileSync(process.execPath,[script,'status',run],{env}).toString());
  assert.equal(status.active,false);
  assert.equal(status.readVerified,false);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('Codex existing executor requires a baseline turn as well as a cursor',()=>{
  const f=fixture(),run=path.join(f.root,'run'),input=path.join(f.root,'input.json');
  const value={projectRoot:f.root,allowedRoots:[f.root],supervisorId:'supervisor-thread',
    executorId:'executor-thread',executorCursor:'cursor-7',contract:f.contract};
  fs.writeFileSync(input,JSON.stringify(value));
  const script=versions[0][1]+'/supervise.cjs',env={...process.env,CODEX_THREAD_ID:'supervisor-thread',CODEX_TURN_ID:'supervisor-turn'};
  assert.throws(()=>execFileSync(process.execPath,[script,'init',run,input],{env,stdio:'pipe'}),/Command failed/);
  fs.writeFileSync(input,JSON.stringify({...value,executorBaselineTurnId:'old-turn'}));
  execFileSync(process.execPath,[script,'init',run,input],{env});
  const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
  assert.deepEqual(state.seen,['old-turn']);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('Claude binds two verified desktop chats and does not claim startup early',()=>{
  const f=fixture(),run=path.join(f.root,'run'),input=path.join(f.root,'input.json');
  const config=path.join(f.root,'claude-config'),project=path.join(config,'projects','qa');
  fs.mkdirSync(project,{recursive:true});
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const log=path.join(project,supervisorId+'.jsonl');
  fs.writeFileSync(log,JSON.stringify({type:'user',cwd:f.root,sessionId:supervisorId,entrypoint:'claude-desktop'})+'\n');
  fs.writeFileSync(path.join(project,executorId+'.jsonl'),JSON.stringify({type:'user',cwd:f.root,sessionId:executorId,
    entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker+' QA prompt'}]}})+'\n');
  fs.writeFileSync(input,JSON.stringify({projectRoot:f.root,allowedRoots:[f.root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,
    executorPrompt:marker+' Use long-task-orchestrator for this isolated QA.',contract:f.contract}));
  const script=versions[1][1]+'/supervise.cjs';
  const env={...process.env,CLAUDE_CONFIG_DIR:config,CLAUDE_SESSION_ID:supervisorId};
  const initialized=JSON.parse(execFileSync(process.execPath,[script,'init',run,input],{env}).toString());
  assert.equal(initialized.executorId,executorId);
  assert.match(initialized.executorDesktopId,/^local_/);
  const binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json')));
  assert.equal(binding.executorLog,path.join(project,executorId+'.jsonl'));
  const status=JSON.parse(execFileSync(process.execPath,[script,'status',run],{env}).toString());
  assert.equal(status.active,false);
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('Claude auto tool session resolves back to the visible supervisor session',()=>{
  const f=fixture(),run=path.join(f.root,'run'),input=path.join(f.root,'input.json');
  const config=path.join(f.root,'claude-config'),project=path.join(config,'projects','qa');
  fs.mkdirSync(project,{recursive:true});
  const inner=crypto.randomUUID(),outer=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  fs.writeFileSync(path.join(project,inner+'.jsonl'),JSON.stringify({type:'user',cwd:path.join(f.root,'scratch'),sessionId:inner})+'\n');
  fs.writeFileSync(path.join(project,outer+'.jsonl'),JSON.stringify({type:'user',cwd:f.root,sessionId:outer,entrypoint:'claude-desktop',message:{content:[{type:'text',text:inner}]}})+'\n');
  fs.writeFileSync(path.join(project,executorId+'.jsonl'),JSON.stringify({type:'user',cwd:f.root,sessionId:executorId,
    entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}})+'\n');
  fs.writeFileSync(input,JSON.stringify({projectRoot:f.root,allowedRoots:[f.root],supervisorId:inner,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,
    executorPrompt:marker+' QA executor prompt; supervisor '+inner,contract:f.contract}));
  const script=versions[1][1]+'/supervise.cjs';
  const env={...process.env,CLAUDE_CONFIG_DIR:config,CLAUDE_SESSION_ID:inner};
  const initialized=JSON.parse(execFileSync(process.execPath,[script,'init',run,input],{env}).toString());
  assert.equal(initialized.supervisorId,outer);
  assert.equal(initialized.toolSessionId,inner);
  assert.match(fs.readFileSync(path.join(run,'executor-prompt.txt'),'utf8'),new RegExp(outer));
  fs.rmSync(f.root,{recursive:true,force:true});
});

test('Claude rejects a CLI-created executor as a desktop mainline',()=>{
  const f=fixture(),run=path.join(f.root,'run'),input=path.join(f.root,'input.json');
  const config=path.join(f.root,'claude-config'),project=path.join(config,'projects','qa');
  fs.mkdirSync(project,{recursive:true});
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  fs.writeFileSync(path.join(project,supervisorId+'.jsonl'),JSON.stringify({type:'user',cwd:f.root,sessionId:supervisorId,entrypoint:'claude-desktop'})+'\n');
  fs.writeFileSync(path.join(project,executorId+'.jsonl'),JSON.stringify({type:'user',cwd:f.root,sessionId:executorId,
    entrypoint:'cli',message:{content:[{type:'text',text:marker}]}})+'\n');
  fs.writeFileSync(input,JSON.stringify({projectRoot:f.root,allowedRoots:[f.root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,
    executorPrompt:marker+' QA',contract:f.contract}));
  assert.throws(()=>execFileSync(process.execPath,[versions[1][1]+'/supervise.cjs','init',run,input],
    {env:{...process.env,CLAUDE_CONFIG_DIR:config,CLAUDE_SESSION_ID:supervisorId},stdio:'pipe'}),/Command failed/);
  fs.rmSync(f.root,{recursive:true,force:true});
});
