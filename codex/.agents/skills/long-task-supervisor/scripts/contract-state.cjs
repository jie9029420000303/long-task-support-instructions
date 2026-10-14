// Preserve the locked contract; replay source-backed user amendments separately.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim();
function inside(file,root){const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
const journal=run=>{const file=path.join(run,'contract-amendments.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];};
// No live process may write the run while its contract state is changed or copied.
function idle(run,names){
  for(const name of names){
    const file=path.join(run,name);if(!fs.existsSync(file))continue;
    const owner=read(file);let alive=false;try{process.kill(owner.pid,0);alive=true;}catch(error){alive=error.code!=='ESRCH';}
    need(!alive,'Run writer is active: '+name);
  }
}
// Run records that speak for Jay (amendments, the pending-decision ledger) are written only by the supervisor's own chat.
function supervisorOnly(binding){
  const caller=binding.platform==='codex'?process.env.CODEX_THREAD_ID:process.env.CLAUDE_SESSION_ID;
  if(caller)need([binding.supervisorId,binding.toolSessionId].includes(caller),'Only the original supervisor may update this run');
}
function safePoint(run,binding){
  const state=read(path.join(run,'daemon-state.json'));
  need(!fs.existsSync(path.join(run,'STOP'))&&!['accepted','stopped'].includes(state.phase),'Stopped or accepted run cannot be changed');
  need(!state.pending&&!state.inflight,'Finish the pending event and reconcile delivery before updating the run');
  idle(run,['watcher.lock','dispatch-write.lock']);
  supervisorOnly(binding);
}
// Jay's words count only from a saved snapshot inside the allowed roots whose hash still matches.
function userSource(source,quote,allowedRoots){
  need(source&&path.isAbsolute(source.path)&&allowedRoots.some(root=>inside(source.path,root))&&fs.existsSync(source.path)&&sha(source.path)===source.sha256,'User source missing, outside allowed roots or changed');
  need(fs.readFileSync(source.path,'utf8').includes(quote),'User quote is absent from the saved source');
}
function base(run,binding){const file=path.join(run,'contract.json');need(sha(file)===binding.contractSha256,'Locked contract changed');return read(file);}
// known: criterion IDs already in scope, including ones added by earlier amendments.
function validateRow(row,binding,contract,known=new Set(contract.criteria.map(item=>item.id))){
  need(row&&/^[A-Za-z0-9_-]+$/.test(row.id)&&row.contractSha256===binding.contractSha256,'Amendment needs unique ID and locked contract hash');
  const authority=row.authority;
  need(authority?.role==='user'&&text(authority.quote)&&text(authority.locator)&&Number.isFinite(Date.parse(authority.at)),'Amendment needs the human user quote, source locator and timestamp');
  userSource(authority.source,authority.quote,binding.allowedRoots);
  need(Array.isArray(row.changes)&&row.changes.length,'Amendment has no changes');
  const seen=new Set(),added=new Set();
  for(const change of row.changes){
    need(change&&['exclude','replace','restore','authorization','add'].includes(change.action)&&text(change.id)&&!seen.has(change.id),'Invalid or duplicate amendment change');seen.add(change.id);
    if(change.action==='authorization'){need(text(change.scope)&&text(change.instruction),'Authorization needs scope and instruction');continue;}
    // Jay may add a criterion (2026-10-11); it never rewrites the locked contract and must pass before acceptance.
    if(change.action==='add'){
      need(/^[A-Za-z0-9_-]+$/.test(change.id)&&!known.has(change.id),'Added criterion needs a new unique ID');
      for(const key of ['requirement','verify'])need(text(change[key]),'Added criterion needs '+key);
      added.add(change.id);continue;
    }
    need(known.has(change.id),'Amendment references an unknown criterion');
    if(change.action==='replace')for(const key of ['requirement','verify'])need(text(change[key]),'Replacement needs '+key);
  }
  return row;
}
function effective(run,binding){
  const contract=base(run,binding),file=path.join(run,'contract-amendments.jsonl');
  if(!fs.existsSync(file)){need(!binding.contractStateSha256,'Amendment journal is missing');return contract;}
  need(!binding.contractStateSha256||sha(file)===binding.contractStateSha256,'Amendment journal changed; reconcile before continuing');
  const rows=journal(run);
  need(rows.length,'Amendment journal is empty');
  const criteria=new Map(contract.criteria.map(item=>[item.id,{...item}])),excluded=new Map(),authorizationUpdates=new Map(),ids=new Set();
  const added=new Map(),known=new Set(contract.criteria.map(item=>item.id));
  let prior=binding.contractSha256;
  for(const row of rows){
    validateRow(row,binding,contract,known);need(!ids.has(row.id)&&row.previousSha256===prior,'Amendment journal order or ID is invalid');ids.add(row.id);prior=digest(row);
    for(const change of row.changes){
      const original=contract.criteria.find(item=>item.id===change.id)||added.get(change.id);
      if(change.action==='authorization'){authorizationUpdates.set(change.id,{...change,authority:row.authority});continue;}
      if(change.action==='add'){
        const item={id:change.id,requirement:change.requirement,verify:change.verify,source:row.authority.locator,amendmentId:row.id,authority:row.authority,added:true};
        added.set(change.id,item);known.add(change.id);criteria.set(change.id,{...item});continue;
      }
      if(change.action==='exclude'){excluded.set(change.id,{...(criteria.get(change.id)||excluded.get(change.id)||original),amendmentId:row.id,authority:row.authority});criteria.delete(change.id);}
      else if(change.action==='restore'){criteria.set(change.id,{...original});excluded.delete(change.id);}
      else {criteria.set(change.id,{...original,requirement:change.requirement,verify:change.verify,source:row.authority.locator,amendmentId:row.id,authority:row.authority});excluded.delete(change.id);}
    }
  }
  need(criteria.size,'An empty effective scope cannot establish acceptance');
  return {...contract,criteria:[...criteria.values()],excluded:[...excluded.values()],authorizationUpdates:[...authorizationUpdates.values()],contractStateSha256:sha(file)};
}
// A new run that continues the same task (another platform, supervisor or executor chat) takes the old locked contract,
// its whole amendment journal and its pending-decision ledger byte for byte: every user grant keeps its quote, locator,
// time and source hash, the effective contract hash stays the same, and Jay's open questions stay open. 2026-10-13 the
// GDB move to Claude rebuilt a contract from the effective view instead and left Jay's grants behind (among them
// 「代我回答所有執行對話」); the new supervisor then sent Jay five decision cards in 7.5 hours.
const CARRIED=['contract.json','contract-amendments.jsonl','source-relocations.json','pending-decisions.json'];
function inherit(previous,allowedRoots){
  need(typeof previous==='string'&&path.isAbsolute(previous)&&fs.existsSync(path.join(previous,'binding.json')),'inheritFrom must be the absolute path of an existing run');
  need(Array.isArray(allowedRoots),'Invalid allowed roots');
  // runtime-state.json names the Codex run-watch parent, which would relaunch the old run's watcher after the copy.
  idle(previous,['watcher.lock','dispatch-write.lock','contract-update.lock','runtime-state.json']);
  const old=read(path.join(previous,'binding.json')),contract=base(previous,old),rows=journal(previous);
  const relocations=path.join(previous,'source-relocations.json');
  const moved=new Map((fs.existsSync(relocations)?read(relocations).entries||[]:[]).map(entry=>[entry.originalPath,entry.relocatedPath]));
  const intact=(file,hash)=>text(file)&&fs.existsSync(file)&&sha(file)===hash,allowed=file=>allowedRoots.some(root=>inside(file,root));
  // Name every missing, changed or out-of-scope source at once, so one pass can fix them all.
  const problems=[];
  for(const source of contract.sources){
    const relocated=moved.get(source.path);
    if(!intact(source.path,source.sha256)&&!(relocated&&intact(relocated,source.sha256)&&allowed(relocated)))problems.push('locked source missing or changed: '+source.path);
  }
  for(const row of rows){
    const source=row.authority?.source||{};
    if(!intact(source.path,source.sha256))problems.push(row.id+' user source missing or changed: '+source.path);
    else if(!allowed(source.path))problems.push(row.id+' user source outside allowed roots: '+source.path);
  }
  need(!problems.length,'Cannot inherit '+previous+': '+problems.join('; '));
  const current=effective(previous,old);
  return {run:previous,binding:old,contract,files:CARRIED.filter(name=>fs.existsSync(path.join(previous,name))),contractStateSha256:current.contractStateSha256||null,
    summary:{from:previous,platform:old.platform,amendments:rows.map(row=>row.id),authorizationUpdates:(current.authorizationUpdates||[]).map(item=>item.id)}};
}
// init takes a new task's own contract, or inheritFrom for the same task continued from another run, never both. A
// contract rebuilt from effective-contract output is refused: its grants have no journal behind them and vanish from
// the effective view as soon as the new run records its first amendment.
function startContract(input){
  need(!input.inheritFrom!==!input.contract,'Give either a new contract or inheritFrom (the run this one continues)');
  if(input.inheritFrom){const inherited=inherit(input.inheritFrom,input.allowedRoots);return {contract:inherited.contract,inherited};}
  const rebuilt=typeof input.contract==='object'?['authorizationUpdates','excluded','contractStateSha256'].filter(key=>Object.hasOwn(input.contract,key)):[];
  need(!rebuilt.length,'Contract was rebuilt from effective-contract ('+rebuilt.join(', ')+'); continue the old run with inheritFrom so every user grant keeps its journal');
  return {contract:input.contract,inherited:null};
}
function append(run,binding,input){
  safePoint(run,binding);
  const contract=base(run,binding),file=path.join(run,'contract-amendments.jsonl');
  effective(run,binding);
  const rows=journal(run);
  const prior=rows.find(row=>row.id===input.id);
  if(prior){const {previousSha256,...saved}=prior;need(JSON.stringify(saved)===JSON.stringify(input),'Recorded amendment is immutable');return {recorded:true,alreadyRecorded:true};}
  const current=effective(run,binding);
  validateRow(input,binding,contract,new Set([...current.criteria,...(current.excluded||[])].map(item=>item.id)));
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
module.exports={effective,safePoint,supervisorOnly,userSource,journal,inherit,startContract,append:(run,binding,input)=>update(run,binding,()=>append(run,binding,input)),
  attachAcceptance:(run,binding,input)=>update(run,binding,()=>attachAcceptance(run,binding,input))};
