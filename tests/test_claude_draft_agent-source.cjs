'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const scripts=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const {localRuns}=require(path.join(scripts,'activity-correlation.cjs'));
const audit=require(path.join(scripts,'dispatch-audit.cjs'));
const deferred=require(path.join(scripts,'deferred-dispatch.cjs'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-source-'));
const dir=path.join(root,'exec','subagents');fs.mkdirSync(dir,{recursive:true});
const fileA=path.join(dir,'agent-a.jsonl'),fileB=path.join(dir,'agent-b.jsonl');
const row={type:'assistant',timestamp:'2026-11-02T00:01:00Z',message:{stop_reason:'tool_use'}};
fs.writeFileSync(fileA,JSON.stringify(row)+'\n');fs.writeFileSync(fileB,JSON.stringify(row)+'\n');
const binding={executorId:'exec',executorLog:path.join(root,'exec.jsonl'),createdAt:'2026-11-02T00:00:00Z',dispatchAudit:{enabled:true}};
const snapshot={schemaVersion:1,executorId:'exec',planningRevision:'v1',activity:'working',capacity:{verified:2,evidence:['test']},packages:{ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]}};
const realOpen=fs.openSync,realRead=fs.readSync,realClose=fs.closeSync,fdFiles=new Map(),bytes={};
fs.openSync=function(file,...args){const fd=realOpen.call(this,file,...args);fdFiles.set(fd,String(file));return fd;};
fs.readSync=function(fd,...args){const n=realRead.call(this,fd,...args),f=fdFiles.get(fd);if(f)bytes[f]=(bytes[f]||0)+n;return n;};
fs.closeSync=function(fd){fdFiles.delete(fd);return realClose.call(this,fd);};
try{
  let source=localRuns(binding);assert.equal(source.available,true);assert.equal(source.runs.length,2);
  const aRead=bytes[fileA],bRead=bytes[fileB];assert.ok(aRead>0&&bRead>0);
  source=localRuns(binding);assert.equal(bytes[fileA],aRead);assert.equal(bytes[fileB],bRead);
  const next=JSON.stringify({...row,timestamp:'2026-11-02T00:02:00Z',message:{stop_reason:'end_turn'}})+'\n';
  fs.appendFileSync(fileA,next);source=localRuns(binding);
  assert.equal(bytes[fileA]-aRead,Buffer.byteLength(next));assert.equal(bytes[fileB],bRead);
  assert.equal(source.runs.find(item=>item.id==='a').done,true);
  // A temporary source failure cannot erase or obsolete a previously reported discrepancy.
  fs.writeFileSync(path.join(root,'dispatch.json'),JSON.stringify(snapshot));
  const state={};let result=audit.inspect(root,binding,state);
  const event=audit.eventFor(result);assert.ok(event.issues.some(item=>item.kind==='agent_untracked'));
  audit.markAnnounced(state,event);
  const readDir=fs.readdirSync;fs.readdirSync=function(file,...args){if(String(file)===dir)throw Object.assign(Error('private path must not escape'),{code:'EACCES'});return readDir.call(this,file,...args);};
  try{
    result=audit.inspect(root,binding,state);assert.equal(result.agentSource.available,false);assert.equal(result.agentSource.error,'EACCES');
    assert.equal(audit.stillCurrent(root,binding,state,event).current,null);
    assert.ok(event.dispatchIssueKeys.every(key=>state.dispatchAudit.active.includes(key)));
    assert.ok(!JSON.stringify(result.agentSource).includes('private path'));
  }finally{fs.readdirSync=readDir;}
  result=audit.inspect(root,binding,state);assert.equal(result.agentSource.available,true);
  assert.equal(audit.stillCurrent(root,binding,state,event).current,true);
  fs.renameSync(fileB,fileB+'-offline');
  result=audit.inspect(root,binding,state);
  assert.equal(result.agentSource.available,true,'directory can remain readable after one file disappears');
  assert.equal(audit.stillCurrent(root,binding,state,event).current,null,'missing specific transcript is unknown');
  assert.ok(event.dispatchIssueKeys.every(key=>state.dispatchAudit.active.includes(key)));
  fs.renameSync(fileB+'-offline',fileB);
  assert.equal(audit.stillCurrent(root,binding,state,event).current,true);
  // Real CLI preflight: missing source is unknown; pending and evidence remain intact.
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
  const sourceFile=path.join(root,'source.txt');fs.writeFileSync(sourceFile,'test');
  const contract={goal:'test',authorization:'test',criteria:[{id:'A',requirement:'a',source:'a',verify:'a'}],sources:[{path:sourceFile,sha256:hash('test')}]};
  const body=JSON.stringify(contract);fs.writeFileSync(path.join(root,'contract.json'),body);
  Object.assign(binding,{platform:'claude',projectRoot:root,allowedRoots:[root],supervisorId:'super',contractSha256:hash(body)});
  fs.writeFileSync(path.join(root,'binding.json'),JSON.stringify(binding));
  Object.assign(state,{phase:'awaiting_decision',pending:event,seen:[],resolved:{}});
  fs.writeFileSync(path.join(root,'daemon-state.json'),JSON.stringify(state));
  fs.renameSync(dir,dir+'-offline');
  const run=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'dispatch-preflight',root,event.id],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).current,null);
  const readback=JSON.parse(fs.readFileSync(path.join(root,'daemon-state.json')));
  assert.equal(readback.pending,null);assert.equal(readback.deferredDispatchEvents[event.id].id,event.id);
  assert.equal(readback.phase,'watching');assert.equal(readback.resolved[event.id],undefined);
  assert.equal(deferred.recheck(root,binding,readback),null,'unavailable source must not block the watcher');
  assert.ok(readback.deferredDispatchEvents[event.id]);
  fs.renameSync(dir+'-offline',dir);
  assert.equal(deferred.recheck(root,binding,readback).id,event.id,'recovered source reissues the saved review');
  assert.equal(readback.deferredDispatchEvents[event.id],undefined);
  console.log('PASS: incremental per-file reads, preserved events on unavailable source, safe diagnostics and CLI preflight');
}finally{fs.openSync=realOpen;fs.readSync=realRead;fs.closeSync=realClose;fs.rmSync(root,{recursive:true,force:true});}
