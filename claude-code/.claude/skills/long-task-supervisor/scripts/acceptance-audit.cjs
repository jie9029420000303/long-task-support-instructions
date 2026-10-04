// Diagnostic progress only: the locked contract and independent acceptance still decide release.
const fs=require('node:fs');
const path=require('node:path');
const statuses=['PASS','FAIL','BLOCKED','PENDING','INCONCLUSIVE'];
const text=value=>typeof value==='string'&&value.trim();
const need=(value,message)=>{if(!value)throw Error(message);};
function evidence(value,label){need(Array.isArray(value)&&value.length&&value.every(text),label+' needs evidence references');}
function validate(progress,contract){
  need(progress&&text(progress.revision),'acceptance.revision is required');
  need(Array.isArray(progress.items),'acceptance.items must be an array');
  const expected=new Set(contract.criteria.map(item=>item.id)),seen=new Set();
  for(const item of progress.items){
    need(expected.has(item.id)&&!seen.has(item.id),'acceptance items must use unique contract criterion IDs');seen.add(item.id);
    need(statuses.includes(item.status),item.id+' has invalid acceptance status');evidence(item.evidence,item.id);
    if(item.lastAttempt){
      const a=item.lastAttempt;need(text(a.id)&&text(a.caseId)&&text(a.revision)&&text(a.reason),item.id+' attempt needs id, stable caseId, revision and reason');
      need(['PASS','FAIL','BLOCKED','INCONCLUSIVE'].includes(a.outcome),item.id+' has invalid attempt outcome');
      evidence(a.evidence,item.id+' attempt');
      need(Number.isFinite(Date.parse(a.startedAt))&&Number.isFinite(Date.parse(a.finishedAt))&&Date.parse(a.finishedAt)>=Date.parse(a.startedAt),item.id+' attempt needs actual start/end timestamps');
    }
  }
  need(seen.size===expected.size,'acceptance.items must cover every locked criterion');
  if(progress.change){
    const c=progress.change;need(text(c.id)&&text(c.fromRevision)&&c.toRevision===progress.revision,'change needs id, source and current revision');
    for(const key of ['affectedCaseIds','requiredRegressionCaseIds'])need(Array.isArray(c[key])&&c[key].every(text),'change '+key+' must list stable case IDs');
    evidence(c.impactEvidence,'change impact');evidence(c.policyEvidence,'change policy');
  }
  return progress;
}
function history(run,required=false){
  const file=path.join(run,'acceptance-history.jsonl');
  if(!fs.existsSync(file)){need(!required,'Acceptance history is missing; reconcile the saved snapshot and restore the journal before continuing');return [];}
  const rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  need(!required||rows.length,'Acceptance history is empty; restore the journal before continuing');
  return rows;
}
function attemptRecord(item){
  const a=item.lastAttempt;
  return {kind:'attempt',criterionId:item.id,id:a.id,caseId:a.caseId,revision:a.revision,outcome:a.outcome,reason:a.reason,evidence:a.evidence,startedAt:a.startedAt,finishedAt:a.finishedAt};
}
function checkHistory(rows,progress){
  if(!progress)return;
  for(const item of progress.items){
    need(rows.some(row=>row.kind==='status'&&row.criterionId===item.id&&row.revision===progress.revision&&row.status===item.status),'Acceptance history does not cover saved status: '+item.id);
    if(item.lastAttempt)need(rows.some(row=>JSON.stringify(row)===JSON.stringify(attemptRecord(item))),'Acceptance history does not cover saved attempt: '+item.id+'/'+item.lastAttempt.id);
  }
  if(progress.change)need(rows.some(row=>JSON.stringify(row)===JSON.stringify({kind:'change',...progress.change})),'Acceptance history does not cover saved change: '+progress.change.id);
}
function checkCurrentPasses(rows,progress){
  const changes=rows.filter(row=>row.kind==='change');
  for(const item of progress.items){
    const a=item.lastAttempt;if(item.status!=='PASS'||!a||a.outcome!=='PASS'||a.revision===progress.revision)continue;
    let valid=new Set([changes[0]?.fromRevision||progress.revision]);
    for(const change of changes){if([...change.affectedCaseIds,...change.requiredRegressionCaseIds].includes(a.caseId))valid=new Set([change.toRevision]);else valid.add(change.toRevision);}
    need(valid.has(a.revision),'Invalidated attempt cannot establish current PASS: '+item.id+'/'+a.id);
  }
}
function record(run,progress,snapshotFile=path.join(run,'dispatch.json')){
  const previous=fs.existsSync(snapshotFile)?JSON.parse(fs.readFileSync(snapshotFile,'utf8')).acceptance:null;
  if(!progress){need(!previous,'Acceptance progress cannot be removed from the saved snapshot');return;}
  const rows=history(run,!!previous),attempts=new Map(),states=new Map(),add=[],changes=new Map(rows.filter(r=>r.kind==='change').map(r=>[r.id,r]));
  checkHistory(rows,previous);
  if(previous&&previous.revision!==progress.revision)need(progress.change?.fromRevision===previous.revision,'Candidate changed: provide the actual impact and required regression mapping');
  if(progress.change){const row={kind:'change',...progress.change},prior=changes.get(row.id);need(!prior||JSON.stringify(prior)===JSON.stringify(row),'Recorded change is immutable: '+row.id);if(!prior)add.push(row);}
  for(const row of rows){if(row.kind==='attempt')attempts.set(row.criterionId+'\0'+row.id,row);else if(row.kind==='status')states.set(row.criterionId,row);}
  for(const item of progress.items){
    if(item.lastAttempt){
      const row=attemptRecord(item),key=item.id+'\0'+row.id,prior=attempts.get(key);
      need(!prior||JSON.stringify(prior)===JSON.stringify(row),'Recorded attempt is immutable: '+item.id+'/'+row.id);
      if(!prior)add.push(row);
    }
    const state=states.get(item.id);
    if(state?.status!==item.status||state?.revision!==progress.revision)add.push({kind:'status',criterionId:item.id,status:item.status,revision:progress.revision,evidence:item.evidence});
  }
  checkCurrentPasses([...rows,...add],progress);
  // Persist each completed result before replacing the current snapshot; retry is idempotent.
  if(add.length)fs.appendFileSync(path.join(run,'acceptance-history.jsonl'),add.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
function summarize(run,progress,details=false){
  if(!progress)return null;
  const rows=history(run,true),byId=new Map(progress.items.map(item=>[item.id,{id:item.id,status:item.status,evidence:item.evidence,wasPass:false,passGeneration:0,cases:{}}])),knownRevisions=new Set(),validRevisions=new Map();
  checkHistory(rows,progress);
  checkCurrentPasses(rows,progress);
  for(const row of rows){
    if(row.kind==='change'){
      knownRevisions.add(row.fromRevision);knownRevisions.add(row.toRevision);
      for(const revisions of validRevisions.values())revisions.add(row.toRevision);
      const affected=new Set([...row.affectedCaseIds,...row.requiredRegressionCaseIds]);
      for(const caseId of affected)validRevisions.set(caseId,new Set([row.toRevision]));
      for(const item of byId.values())for(const trial of Object.values(item.cases))if(affected.has(trial.caseId))trial.consecutivePasses=0;
      continue;
    }
    const item=byId.get(row.criterionId);if(!item)continue;
    if(!knownRevisions.size)knownRevisions.add(row.revision);
    if(row.kind==='status'){if(row.status==='PASS'){item.wasPass=true;item.passGeneration++;}continue;}
    if(row.kind!=='attempt')continue;
    const trial=item.cases[row.caseId]||={caseId:row.caseId,attempts:0,passAttempts:0,consecutivePasses:0,staleAttempts:0,lastPassId:null,unresolvedAttempts:[],durations:[]};
    trial.attempts++;trial.durations.push((Date.parse(row.finishedAt)-Date.parse(row.startedAt))/1000);
    if(row.outcome==='PASS')trial.passAttempts++;
    if(!(validRevisions.get(row.caseId)||knownRevisions).has(row.revision)){trial.staleAttempts++;continue;}
    if(row.outcome==='PASS'){trial.consecutivePasses++;trial.lastPassId=row.id;trial.unresolvedAttempts=[];}
    else{trial.consecutivePasses=0;trial.unresolvedAttempts.push({id:row.id,revision:row.revision,outcome:row.outcome,reason:row.reason,evidence:row.evidence});}
  }
  const items=[...byId.values()].map(item=>{
    const cases=Object.values(item.cases).map(trial=>{
      const durations=trial.durations.sort((a,b)=>a-b),n=durations.length;
      const medianSeconds=n?(durations[Math.floor((n-1)/2)]+durations[Math.floor(n/2)])/2:null;
      return {...trial,durations:undefined,unresolvedAttempts:details?trial.unresolvedAttempts:undefined,unresolvedCount:trial.unresolvedAttempts.length,latestUnresolved:trial.unresolvedAttempts.at(-1)||null,medianSeconds};
    });
    return {...item,cases};
  });
  return {revision:progress.revision,items};
}
function issues(run,progress){
  const summary=summarize(run,progress,true);if(!summary)return [];
  const result=[];
  for(const item of summary.items){
    for(const trial of item.cases)if(item.status!=='PASS'&&trial.unresolvedAttempts.length>=2)result.push({kind:'acceptance_rework',affected:[item.id],cases:[trial.caseId],episode:trial.lastPassId,detail:{finding:'同一驗收案例反覆執行，仍未取得通過證據；核對原因及下一步',caseId:trial.caseId,evidence:trial.unresolvedAttempts.flatMap(a=>a.evidence)}});
    if(item.wasPass&&item.status!=='PASS')result.push({kind:'acceptance_withdrawn',affected:[item.id],episode:item.passGeneration,detail:{finding:'先前通過證據已撤回；核對變更影響與必要重測',evidence:item.evidence}});
  }
  return result;
}
module.exports={validate,record,summarize,issues};
