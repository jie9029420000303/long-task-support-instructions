#!/usr/bin/env node
const fs=require('node:fs');
const contractState=require('./contract-state.cjs');
const path=require('node:path');
const {parse}=require('./dispatch-audit.cjs');
const acceptance=require('./acceptance-audit.cjs');
const [command,runArg,inputArg]=process.argv.slice(2);
let lock;
try{
  if(!['write','summary'].includes(command)||!path.isAbsolute(runArg||'')||(command==='write'&&!path.isAbsolute(inputArg||'')))throw Error('Usage: dispatch.cjs write ABSOLUTE_RUN ABSOLUTE_INPUT_JSON');
  const run=path.resolve(runArg),binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))throw Error('Dispatch auditing is not attached to this run');
  if(command==='summary'){const snapshot=parse(JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8')),binding);if(snapshot.acceptance)acceptance.validate(snapshot.acceptance,contractState.effective(run,binding));else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');console.log(JSON.stringify(acceptance.summarize(run,snapshot.acceptance)));}
  else{
  const value=parse(JSON.parse(fs.readFileSync(inputArg,'utf8')),binding);
  if(value.acceptance)acceptance.validate(value.acceptance,contractState.effective(run,binding));
  else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');
  const output=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),temporary=output+'.tmp-'+process.pid;
  const lockFile=path.join(run,'dispatch-write.lock');
  try{fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx'});lock=lockFile;}catch(error){if(error.code==='EEXIST')throw Error('Dispatch writer is active or recovery is required: inspect '+lockFile+' and retry the same attempt IDs after the owner exits');throw error;}
  acceptance.record(run,value.acceptance,output);
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temporary,output);
  // A short line per write, so a finished run shows when work waited while packages were ready or criteria open.
  const ids=list=>(list||[]).map(item=>item.id);
  fs.appendFileSync(path.join(run,'dispatch-history.jsonl'),JSON.stringify({at:new Date().toISOString(),planningRevision:value.planningRevision,activity:value.activity,
    ready:ids(value.packages.ready),inFlight:(value.packages.inFlight||[]).map(item=>({id:item.id,handle:item.handle})),blocked:ids(value.packages.blocked),
    openCriteria:(value.acceptance?.items||[]).filter(item=>!['PASS','EXCLUDED'].includes(item.status)).map(item=>item.id)})+'\n');
  console.log(JSON.stringify({written:true,path:output,planningRevision:value.planningRevision}));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(lock)fs.unlinkSync(lock);}
