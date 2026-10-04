// Preserve the locked contract; replay source-backed user amendments separately.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim();
function inside(file,root){const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function safePoint(run,binding){
  const state=read(path.join(run,'daemon-state.json'));
  need(!fs.existsSync(path.join(run,'STOP'))&&!['accepted','stopped'].includes(state.phase),'Stopped or accepted run cannot be changed');
  need(!state.pending&&!state.inflight,'Finish the pending event and reconcile delivery before updating the run');
  for(const name of ['watcher.lock','dispatch-write.lock']){
    const file=path.join(run,name);if(!fs.existsSync(file))continue;
    const owner=read(file);let alive=false;try{process.kill(owner.pid,0);alive=true;}catch(error){alive=error.code!=='ESRCH';}
    need(!alive,'Run writer is active: '+name);
  }
  const caller=binding.platform==='codex'?process.env.CODEX_THREAD_ID:process.env.CLAUDE_SESSION_ID;
  if(caller)need([binding.supervisorId,binding.toolSessionId].includes(caller),'Only the original supervisor may update this run');
}
function base(run,binding){const file=path.join(run,'contract.json');need(sha(file)===binding.contractSha256,'Locked contract changed');return read(file);}
function validateRow(row,binding,contract){
  need(row&&/^[A-Za-z0-9_-]+$/.test(row.id)&&row.contractSha256===binding.contractSha256,'Amendment needs unique ID and locked contract hash');
  const authority=row.authority;
  need(authority?.role==='user'&&text(authority.quote)&&text(authority.locator)&&Number.isFinite(Date.parse(authority.at)),'Amendment needs the human user quote, source locator and timestamp');
  const source=authority.source;
  need(source&&path.isAbsolute(source.path)&&binding.allowedRoots.some(root=>inside(source.path,root))&&fs.existsSync(source.path)&&sha(source.path)===source.sha256,'User source missing, outside allowed roots or changed');
  need(fs.readFileSync(source.path,'utf8').includes(authority.quote),'User quote is absent from the saved source');
  need(Array.isArray(row.changes)&&row.changes.length,'Amendment has no changes');
  const ids=new Set(contract.criteria.map(item=>item.id)),seen=new Set();
  for(const change of row.changes){
    need(change&&['exclude','replace','restore','authorization'].includes(change.action)&&text(change.id)&&!seen.has(change.id),'Invalid or duplicate amendment change');seen.add(change.id);
    if(change.action==='authorization'){need(text(change.scope)&&text(change.instruction),'Authorization needs scope and instruction');continue;}
    need(ids.has(change.id),'Amendment references an unknown criterion');
    if(change.action==='replace')for(const key of ['requirement','verify'])need(text(change[key]),'Replacement needs '+key);
  }
  return row;
}
function effective(run,binding){
  const contract=base(run,binding),file=path.join(run,'contract-amendments.jsonl');
  if(!fs.existsSync(file)){need(!binding.contractStateSha256,'Amendment journal is missing');return contract;}
  need(!binding.contractStateSha256||sha(file)===binding.contractStateSha256,'Amendment journal changed; reconcile before continuing');
  const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  need(rows.length,'Amendment journal is empty');
  const criteria=new Map(contract.criteria.map(item=>[item.id,{...item}])),excluded=new Map(),authorizationUpdates=new Map(),ids=new Set();
  let prior=binding.contractSha256;
  for(const row of rows){
    validateRow(row,binding,contract);need(!ids.has(row.id)&&row.previousSha256===prior,'Amendment journal order or ID is invalid');ids.add(row.id);prior=digest(row);
    for(const change of row.changes){
      const original=contract.criteria.find(item=>item.id===change.id);
      if(change.action==='authorization'){authorizationUpdates.set(change.id,{...change,authority:row.authority});continue;}
      if(change.action==='exclude'){excluded.set(change.id,{...(criteria.get(change.id)||excluded.get(change.id)||original),amendmentId:row.id,authority:row.authority});criteria.delete(change.id);}
      else if(change.action==='restore'){criteria.set(change.id,{...original});excluded.delete(change.id);}
      else {criteria.set(change.id,{...original,requirement:change.requirement,verify:change.verify,source:row.authority.locator,amendmentId:row.id,authority:row.authority});excluded.delete(change.id);}
    }
  }
  need(criteria.size,'An empty effective scope cannot establish acceptance');
  return {...contract,criteria:[...criteria.values()],excluded:[...excluded.values()],authorizationUpdates:[...authorizationUpdates.values()],contractStateSha256:sha(file)};
}
function append(run,binding,input){
  safePoint(run,binding);
  const contract=base(run,binding),file=path.join(run,'contract-amendments.jsonl');
  effective(run,binding);
  const rows=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const prior=rows.find(row=>row.id===input.id);
  if(prior){const {previousSha256,...saved}=prior;need(JSON.stringify(saved)===JSON.stringify(input),'Recorded amendment is immutable');return {recorded:true,alreadyRecorded:true};}
  validateRow(input,binding,contract);
  const row={...input,previousSha256:rows.length?digest(rows.at(-1)):binding.contractSha256};
  // Validate the proposed complete scope before committing its immutable journal entry.
  const allExcluded=new Set(effective(run,binding).excluded?.map(item=>item.id)||[]);
  for(const change of row.changes){if(change.action==='exclude')allExcluded.add(change.id);else if(['restore','replace'].includes(change.action))allExcluded.delete(change.id);}
  need(allExcluded.size<contract.criteria.length,'Cannot exclude every acceptance criterion');
  fs.appendFileSync(file,JSON.stringify(row)+'\n');
  binding.contractStateSha256=sha(file);
  const bindingFile=path.join(run,'binding.json');
  fs.writeFileSync(bindingFile+'.tmp',JSON.stringify(binding,null,2)+'\n');fs.renameSync(bindingFile+'.tmp',bindingFile);
  const result=effective(run,binding);
  return {recorded:true,contractStateSha256:result.contractStateSha256,active:result.criteria.map(item=>item.id),excluded:result.excluded.map(item=>item.id)};
}
function attachAcceptance(run,binding,progress){
  safePoint(run,binding);
  const {parse}=require('./dispatch-audit.cjs'),acceptance=require('./acceptance-audit.cjs');
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  const snapshot=parse(read(file),binding);
  acceptance.validate(progress,effective(run,binding));
  acceptance.record(run,progress,file);
  snapshot.acceptance=progress;
  fs.writeFileSync(file+'.tmp',JSON.stringify(snapshot,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  binding.dispatchAudit={...binding.dispatchAudit,enabled:true,snapshot:binding.dispatchAudit?.snapshot||'dispatch.json',acceptance:true,acceptanceAttachedAt:new Date().toISOString()};
  const bindingFile=path.join(run,'binding.json');
  fs.writeFileSync(bindingFile+'.tmp',JSON.stringify(binding,null,2)+'\n');fs.renameSync(bindingFile+'.tmp',bindingFile);
  return {attached:true,revision:progress.revision,items:progress.items.length};
}
function update(run,binding,work){
  safePoint(run,binding);
  const file=path.join(run,'contract-update.lock');
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx'});
  try{return work();}finally{fs.unlinkSync(file);}
}
module.exports={effective,safePoint,append:(run,binding,input)=>update(run,binding,()=>append(run,binding,input)),
  attachAcceptance:(run,binding,input)=>update(run,binding,()=>attachAcceptance(run,binding,input))};
