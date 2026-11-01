'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),child=require('node:child_process');
const scripts=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'safe-clock-'));
process.env.CODEX_HOME=tmp;
const day=new Date(),id='fixture-thread',dir=path.join(tmp,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
const log=path.join(dir,'rollout-2026-11-02T000000-'+id+'.jsonl');
const secret='synth-secret-8zy7x6w5v4u3',oldSecret='legacy-secret-9ab8cd7ef6';
const recent=new Date().toISOString(),past=new Date(Date.now()-10*60000).toISOString();
const command='deploy-tool '+secret+' --apply';
const rows=[{type:'session_meta',payload:{id,title:'中文測試'}},
  {timestamp:past,type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'blocked-call',arguments:JSON.stringify({cmd:command})}},
  {timestamp:recent,type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'denied-call',arguments:JSON.stringify({cmd:'auth-tool '+secret})}},
  {timestamp:recent,type:'response_item',payload:{type:'function_call_output',call_id:'denied-call',output:'rejected due to unacceptable risk\nReason: '+secret}},
  ...[1,2,3].map(()=>({timestamp:recent,type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/sh','-c',command],exit_code:1,status:'failed'}}}))];
// Put the blocked call last: completion marks earlier calls as run, but not this one.
rows.push({...rows[1],payload:{...rows[1].payload,call_id:'late-blocked'}});
fs.writeFileSync(log,rows.map(JSON.stringify).join('\n')+'\n');
const binding={executorId:id,supervisorId:'supervisor',createdAt:new Date(Date.now()-3600000).toISOString()};
const state={executorSettings:{approvalPolicy:'on-request',reviewer:'auto_review',at:recent},lastAutomationCheckAt:Date.now(),lastRealEventAt:Date.now(),lastExecutorActivityAt:Date.now(),lastExecutorWorkAt:Date.now(),lastDecisionAt:Date.now()};
const originalExec=child.execFileSync;
let processOutput=command;
child.execFileSync=(program,...args)=>program==='ps'?processOutput:originalExec(program,...args);
function check(){const file=path.join(scripts,'supervisor-clock.cjs');delete require.cache[require.resolve(file)];return require(file).check(tmp,binding,state);}
try{
  let result=check();
  assert.ok(result.reasons.includes('permission_review'));assert.ok(result.reasons.includes('repeat'));
  assert.ok(!result.reasons.includes('executor_blocked'),'matching active process is not blocked');
  assert.equal(result.failedCommands[0].count,3);assert.match(result.failedCommands[0].commandHash,/^sha256:[a-f0-9]{64}$/);
  assert.equal(result.failedCommands[0].source.path,log);assert.ok(Number.isInteger(result.failedCommands[0].source.offset));
  assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(state.openTools).includes(secret));
  assert.ok(!JSON.stringify(state.callItems).includes(secret));assert.ok(!JSON.stringify(state.failedCommands).includes(secret));
  processOutput='some unrelated process';state.lastHealthAt=0;result=check();
  assert.ok(result.reasons.includes('executor_blocked'));assert.equal(result.executorBlocked[0].id,'late-blocked');
  assert.equal(result.executorBlocked[0].source.path,log);assert.ok(Number.isInteger(result.executorBlocked[0].source.offset));
  assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!fs.readFileSync(path.join(tmp,'clock.jsonl'),'utf8').includes(secret));
  const offset=result.executorBlocked[0].source.offset,bytes=fs.readFileSync(log);
  assert.equal(JSON.parse(bytes.subarray(offset).toString().split('\n')[0]).payload.call_id,'late-blocked');

  const clock=require(path.join(scripts,'supervisor-clock.cjs'));
  const old={callId:'old-call',at:recent,item:oldSecret,reason:oldSecret,source:{path:log,callId:'old-call',outputSha256:'abcd'}};
  assert.ok(!JSON.stringify(clock.safeRejection(old)).includes(oldSecret));
  const dashboard=require(path.join(scripts,'dashboard.cjs')).render({binding,state:{phase:'watching',rejectionCount:1,reviewRejections:[old]},snapshot:null,paced:{packages:[]},alive:true,paused:false});
  assert.ok(!dashboard.includes(oldSecret));
  const view=require(path.join(scripts,'review-context.cjs')).summary({kind:'progress_review',permission:{newRejections:[old]},executorBlocked:[{id:'old',command:oldSecret}],failedCommands:[{command:oldSecret,count:3}]});
  assert.ok(!JSON.stringify(view).includes(oldSecret));
  // The public brief also reads an old run's refusal and pending progress event without printing raw values.
  const briefRun=path.join(tmp,'brief-run');fs.mkdirSync(briefRun);
  const source=path.join(briefRun,'source.txt');fs.writeFileSync(source,'test');
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const contract={goal:'test',authorization:'test',criteria:[{id:'A',requirement:'a',source:'a',verify:'a'}],sources:[{path:source,sha256:hash('test')}]};
  const contractBytes=JSON.stringify(contract);fs.writeFileSync(path.join(briefRun,'contract.json'),contractBytes);
  fs.writeFileSync(path.join(briefRun,'binding.json'),JSON.stringify({executorId:'brief-executor',supervisorId:'supervisor',projectRoot:briefRun,allowedRoots:[briefRun],contractSha256:hash(contractBytes)}));
  fs.writeFileSync(path.join(briefRun,'daemon-state.json'),JSON.stringify({phase:'watching',messages:[],reviewRejections:[old],pending:{id:'old-event',kind:'progress_review',permission:{newRejections:[old]},executorBlocked:[{id:'old',command:oldSecret}],failedCommands:[{command:oldSecret,count:3}]}}));
  const brief=originalExec(process.execPath,[path.join(scripts,'supervise.cjs'),'brief',briefRun],{encoding:'utf8',env:{...process.env,CODEX_HOME:tmp}});
  assert.ok(!brief.includes(oldSecret));assert.equal(JSON.parse(brief).reviewRejections[0].callId,'old-call');
  // A resumed old run keeps its prior failures, and the next identical failure still reaches three.
  const oldState={...state,executorOffset:fs.statSync(log).size,clockAnnounced:{},failedCommands:{[command]:{count:2,lastAt:recent}},reviewRejections:[old],lastHealthAt:0};
  fs.appendFileSync(log,JSON.stringify(rows[4])+'\n');result=(function(){const file=path.join(scripts,'supervisor-clock.cjs');delete require.cache[require.resolve(file)];return require(file).check(tmp,binding,oldState);})();
  assert.equal(result.failedCommands[0].count,3);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes(oldSecret));
  const success=JSON.parse(JSON.stringify(rows[4]));success.payload.item.exit_code=0;success.payload.item.status='completed';
  fs.appendFileSync(log,JSON.stringify(success)+'\n'+JSON.stringify(rows[4])+'\n');
  result=(function(){const file=path.join(scripts,'supervisor-clock.cjs');delete require.cache[require.resolve(file)];return require(file).check(tmp,binding,oldState);})();
  assert.equal(Object.values(oldState.failedCommands)[0].count,1);assert.ok(!result?.reasons.includes('repeat'),'success resets the failure streak');
  console.log('PASS: new and legacy rejection, repeated failure, blocked/running command, safe source offsets, clock and dashboard');
}finally{child.execFileSync=originalExec;fs.rmSync(tmp,{recursive:true,force:true});}
