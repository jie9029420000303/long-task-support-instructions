// A delivered instruction can explicitly cover a later clock tick while the same work is still running.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function coverage(snapshot,event,ids,expiry) {
  const covered=[];
  for(const id of ids||[]){
    const item=snapshot?.packages?.inFlight?.find(row=>row.id===id);
    const phase=event.pace?.packages?.find(row=>row.id===id);
    if(!item || !phase?.startedAt || !phase.handle || !phase.executorBaselineMinutes)continue;
    // Capture the actual carrier and baseline checked in the event. A later stage may reuse the package ID.
    if(item.handle!==phase.handle || (item.baseline?.startedAt && Date.parse(item.baseline.startedAt)!==Date.parse(phase.startedAt)))continue;
    covered.push({id,startedAt:phase.startedAt,handle:phase.handle,minutes:phase.executorBaselineMinutes,packageHash:digest(item),expiry});
  }
  return covered;
}
function covered(state,snapshot,item,now){
  const match=state.coveredOverdue?.find(row=>row.id===item.id);
  const active=snapshot?.packages?.inFlight?.find(row=>row.id===item.id);
  return match && active && now<match.expiry && match.startedAt===item.startedAt && match.handle===item.handle &&
    match.minutes===item.executorBaselineMinutes && match.packageHash===digest(active) && !item.finished && item.alive!==false;
}
function validateUnblock(run,binding,event,decision) {
  if(!event.reasons?.some(r=>r==='idle_with_work'||r==='all_blocked') || event.kind!=='progress_review')return;
  let snapshot;
  try {snapshot=JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')));}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!snapshot.packages || snapshot.packages.inFlight?.length || snapshot.packages.ready?.length)return;
  if(decision.wait?.kind==='external_result')return;
  if(decision.wait?.kind==='user_approval'){
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    const keys=new Set(require('./pending-decisions.cjs').view(run,state).open.map(item=>item.key));
    const dependencies=decision.wait.dependsOn||[];
    const ids=event.idleWithWork?.openCriteria || (snapshot.acceptance?.items||[]).filter(item=>!['PASS','EXCLUDED'].includes(item.status)).map(item=>item.id);
    if(dependencies.length && dependencies.every(item=>keys.has(item.pendingKey)) && ids.every(id=>dependencies.some(item=>item.id===id)))return;
    throw Error('等待本人決定需要已登記的待決事項，以及每條受阻驗收對應的待決 key');
  }
  const r=decision.unblockResearch;
  if(decision.disposition==='reply' && r && [r.assessment,r.nextAction].every(v=>typeof v==='string' && v.trim()) &&
    typeof r.source==='string' && path.isAbsolute(r.source) && fs.statSync(r.source,{throwIfNoEntry:false})?.isFile() &&
    decision.reply.includes(r.nextAction))return;
  throw Error('工作仍未完成。登記可核對的等待來源，或派研究子代理、核對解卡結果並用 unblockResearch 把下一步交付執行主線。');
}
function collectionNotes(run) {
  const file=path.join(run,'collection-notes.json');
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
}
function noteCollection(run,eventId,note){
  const notes=collectionNotes(run);
  if(notes.some(row=>row.eventId===eventId))return;
  const file=path.join(run,'collection-notes.json'),tmp=file+'.tmp-'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify([...notes,{eventId,note}])+'\n');fs.renameSync(tmp,file);

}
module.exports={coverage,covered,validateUnblock,collectionNotes,noteCollection};
