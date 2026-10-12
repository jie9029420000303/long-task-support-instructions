// Persist the event once; a wake carries a locator, and one context call returns what the supervisor needs to decide.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function eventFile(run,id){
  if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid review event ID');
  return path.join(run,'review-event-'+id+'.json');
}
function persist(run,event){
  const file=eventFile(run,event.id),body=JSON.stringify(event)+'\n';
  if(fs.existsSync(file)){
    if(fs.readFileSync(file,'utf8')!==body)throw Error('Saved review event changed');
  }else fs.writeFileSync(file,body,{flag:'wx'});
  return {path:file,sha256:digest(body)};
}
function summary(event){
  if(!event)return null;
  const {text,pace,...rest}=event;
  return {...rest,...(typeof text==='string'?{textChars:text.length}:{} )};
}
function authorization(contract,binding){
  return {original:contract.authorization,supervisorId:binding.supervisorId,executorId:binding.executorId,
    sources:contract.sources,updates:contract.authorizationUpdates||[],
    contractSha256:binding.contractSha256,contractStateSha256:contract.contractStateSha256||null};
}
module.exports={eventFile,persist,summary,authorization};
