const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts/supervise.cjs');
const run=fs.mkdtempSync(path.join(os.tmpdir(),'claude-activity-decision-'));
const put=(name,value)=>fs.writeFileSync(path.join(run,name),JSON.stringify(value)+'\n');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
try{
  const source=path.join(run,'source.txt');fs.writeFileSync(source,'source');
  put('contract.json',{goal:'goal',authorization:'authorization',criteria:[{id:'A1',requirement:'r',source:'s',verify:'v'}],sources:[{path:source,sha256:sha(fs.readFileSync(source))}]});
  put('binding.json',{contractSha256:sha(fs.readFileSync(path.join(run,'contract.json'))),allowedRoots:[run],executorId:'executor'});
  const item={kind:'main_write_review',key:'key-1',affected:[],detail:{observations:[{callId:'reviewed'}]}};
  const event={id:'event-1',kind:'dispatch_review',issues:[item],dispatchIssueKeys:['key-1']};
  put('daemon-state.json',{phase:'awaiting_decision',pending:event,resolved:{},seen:[],activityAudit:{mainWrites:[{callId:'reviewed'},{callId:'newer'}]},dispatchAudit:{active:['key-1'],announced:['key-1']}});
  put('decision.json',{eventId:event.id,disposition:'observe',reason:'Source checked'});
  const result=spawnSync(process.execPath,[script,'decision',run,path.join(run,'decision.json')],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'),'utf8'));
  assert.deepEqual(state.activityAudit.mainWrites,[{callId:'newer'}],'only observations included in the reviewed event are consumed');
  assert.deepEqual(state.dispatchAudit.active,[]);assert.deepEqual(state.dispatchAudit.announced,[]);
  assert.equal(state.pending,null);
  console.log('PASS: reviewed activity clues consumed, newer clues preserved and next episode re-armed');
}finally{fs.rmSync(run,{recursive:true,force:true});}
