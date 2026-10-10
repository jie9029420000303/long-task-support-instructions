// Persist the event once; model wakeups carry a locator, not the protocol and history.
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
function prompt(run,event,node=process.execPath){
  const saved=persist(run,event),quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
  return `長任務事件 ${event.id}（${event.kind}${event.reasons?.length?' / '+event.reasons.join(','):''}）。`+
    `先執行 ${[node,path.join(__dirname,'supervise.cjs'),'context',run,event.id].map(quote).join(' ')}。`+
    `事件 SHA-256：${saved.sha256}。依 context 的既有規則處理此事件；brief 已包含於 context，不重讀歷史或整份契約。`;
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
module.exports={eventFile,persist,prompt,summary,authorization};
