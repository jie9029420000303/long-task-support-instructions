const fs=require('node:fs');
const contractState=require('./contract-state.cjs');
const path=require('node:path');
const crypto=require('node:crypto');
const acceptance=require('./acceptance-audit.cjs');
const activityCorrelation=require('./activity-correlation.cjs');

const kinds=['ready_capacity','returned_unintegrated','resource_conflict','recurring_rework','snapshot_missing','snapshot_invalid','acceptance_rework','acceptance_withdrawn',
  'main_write_review','agent_untracked','agent_finished_inflight','wp_mismatch','wp_source_unknown','planning_review','dependency_ready_review'];
// Document time budget (Jay 2026-10-15: document work takes at most 1.5x the development time).
const DOC_BUDGET_RATIO=1.5;
const nonEmpty=value=>typeof value==='string'&&value.trim();
function digest(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function need(value,message){if(!value)throw Error(message);}
function records(value,name){need(Array.isArray(value),name+' must be an array');const ids=new Set();for(const item of value){need(item&&nonEmpty(item.id),name+' records need id');need(!ids.has(item.id),name+' ids must be unique');ids.add(item.id);}return value;}
function resources(value,name){need(Array.isArray(value),name+' resources must be an array');for(const claim of value)need(claim&&nonEmpty(claim.key)&&['worktree','browser','account','database','test_environment','other'].includes(claim.kind),name+' has invalid resource claim');return value;}
function evidence(value,name){need(Array.isArray(value)&&value.length>0&&value.every(nonEmpty),name+' needs at least one evidence reference');return value;}
function parse(snapshot,binding){
  need(snapshot&&snapshot.schemaVersion===1,'schemaVersion must be 1');
  need(snapshot.executorId===binding.executorId,'snapshot executorId does not match binding');
  need(nonEmpty(snapshot.planningRevision),'planningRevision is required');
  need(['planning','dispatching','working','integrating','waiting'].includes(snapshot.activity),'invalid activity');
  need(snapshot.capacity&&Number.isInteger(snapshot.capacity.verified)&&snapshot.capacity.verified>=0,'capacity.verified must be a non-negative integer');
  evidence(snapshot.capacity.evidence,'capacity');
  if(snapshot.capacity.throttle!==undefined){const t=snapshot.capacity.throttle;
    need(t&&Number.isInteger(t.limit)&&t.limit>=0&&t.limit<=snapshot.capacity.verified,'capacity.throttle.limit must be within verified capacity');
    need(nonEmpty(t.reason)&&nonEmpty(t.reviewWhen),'capacity.throttle needs reason and reviewWhen');evidence(t.evidence,'capacity.throttle');}
  if(snapshot.planningReview!==undefined){const p=snapshot.planningReview;
    need(p&&/^[a-f0-9]{64}$/.test(p.basis)&&nonEmpty(p.reason)&&Number.isFinite(Date.parse(p.at)),'planningReview needs basis, reason and at');}
  need(snapshot.packages&&typeof snapshot.packages==='object','packages is required');
  const p=snapshot.packages;
  for(const name of ['ready','inFlight','returned','blocked','completed','recurringRework'])records(p[name],name);
  for(const item of [...p.ready,...p.inFlight,...p.blocked])resources(item.exclusiveResources,item.id);
  for(const item of p.ready){need(typeof item.independent==='boolean'&&typeof item.safe==='boolean',item.id+' needs independent and safe');need(Array.isArray(item.dependencies),item.id+' dependencies must be an array');evidence(item.evidence,item.id);}
  for(const item of p.inFlight){need(nonEmpty(item.handle),item.id+' needs a platform handle');evidence(item.evidence,item.id);
    if(item.baseline!==undefined){const b=item.baseline;need(b&&Number.isFinite(b.minutes)&&b.minutes>0,item.id+' baseline.minutes must be positive');need(Number.isFinite(Date.parse(b.startedAt)),item.id+' baseline.startedAt must be a time');need(nonEmpty(b.basis),item.id+' baseline.basis is required');}}
  for(const item of p.returned){need(typeof item.integrated==='boolean',item.id+' needs integrated');evidence(item.resultEvidence,item.id);}
  for(const item of p.blocked){need(nonEmpty(item.kind),item.id+' needs kind');evidence(item.evidence,item.id);}
  for(const item of p.completed){need(Array.isArray(item.acceptanceIds),item.id+' acceptanceIds must be an array');evidence(item.evidence,item.id);}
  for(const item of p.recurringRework){need(Number.isInteger(item.count)&&item.count>=2,item.id+' recurring count must be at least 2');evidence(item.evidence,item.id);}
  // The budget is 1.5x the measured development time; more needs the amendment where Jay allowed it.
  if(snapshot.docBudget!==undefined){const b=snapshot.docBudget;need(b&&Number.isFinite(Date.parse(b.startedAt)),'docBudget.startedAt must be a time');
    need(Number.isFinite(b.devMinutes)&&b.devMinutes>0&&Number.isFinite(b.minutes)&&b.minutes>0,'docBudget.devMinutes and docBudget.minutes must be positive');
    need(nonEmpty(b.basis),'docBudget.basis is required');
    need(b.minutes<=b.devMinutes*DOC_BUDGET_RATIO+0.5||nonEmpty(b.approval),'docBudget.minutes above 1.5x devMinutes needs approval naming where Jay allowed it');
    // The executor's per-item estimate before writing (Jay 2026-10-29): .md, slides, Archify diagrams with their image checks, video.
    if(b.estimate!==undefined)need(Array.isArray(b.estimate)&&b.estimate.every(item=>nonEmpty(item?.item)&&Number.isFinite(item.minutes)&&item.minutes>0),'docBudget.estimate must list {item, minutes} with positive minutes');}
  if(snapshot.updatedAt!==undefined)need(nonEmpty(snapshot.updatedAt),'updatedAt must be a string');
  return snapshot;
}
// The stage a document time budget has reached after awakeMs of awake time: 'half' from 50%, 'spent' from 100%.
// Document time counts only while document work runs (Jay 2026-10-29). V32 counted the wall clock from the budget's
// start, waits and stalls included, and reported 728 minutes. Time between two checks counts when a package marked
// "doc":true (or with an id starting DOC) is in flight and the executor or a subagent worked in the last 5 minutes; a
// gap over 5 minutes (sleep, a stopped watch) never counts. Added minutes keep the time already used.
const DOC_ACTIVE_MS=5*60000;
const docWork=snapshot=>(snapshot?.packages?.inFlight||[]).some(item=>item?.doc===true||/^DOC/i.test(String(item?.id||'')));
function trackDocTime(state,snapshot,lastWorkAt,nowMs=Date.now()){
  const budget=snapshot?.docBudget;
  if(!budget||!Number.isFinite(Date.parse(budget.startedAt)))return null;
  const used=state.docTime?.key===budget.startedAt?state.docTime:(state.docTime={key:budget.startedAt,ms:0,at:nowMs});
  const step=nowMs-used.at;
  if(step>0&&step<=DOC_ACTIVE_MS&&docWork(snapshot)&&nowMs-(lastWorkAt||0)<DOC_ACTIVE_MS)used.ms+=step;
  used.at=nowMs;
  return used.ms;
}
function docBudgetStage(budget,awakeMs){
  const minutes=Number(budget?.minutes);
  if(!budget||!Number.isFinite(Date.parse(budget.startedAt))||!(minutes>0)||!Number.isFinite(awakeMs))return null;
  const ratio=awakeMs/(minutes*60000);
  return ratio>=1?'spent':ratio>=0.5?'half':null;
}
function issue(kind,items,detail){need(kinds.includes(kind),'unknown issue kind');const affected=[...new Set(items)].sort();const key=digest({kind,affected,detail});return {kind,affected,detail,key};}
// Main-line work and resource processes consume resources, but not a subagent seat.
// Unknown handles remain counted until the platform handle can be verified.
function freeCapacity(snapshot){
  const seats=Number(snapshot?.capacity?.throttle?.limit??snapshot?.capacity?.verified)||0;
  const occupied=(snapshot?.packages?.inFlight||[]).filter(item=>item?.handle!=='main'&&!/^resource:.+/.test(item?.handle||'')).length;
  return Math.max(0,seats-occupied);
}
function agentSeatCount(inFlight){return (inFlight||[]).filter(item=>item.handle!=='main'&&!String(item.handle||'').startsWith('resource:')).length;}
function planningBasis(binding){return digest({contractSha256:binding.contractSha256,contractStateSha256:binding.contractStateSha256||null});}
function planReview(snapshot,binding){
  const p=snapshot.packages,completed=new Set(p.completed.map(item=>item.id));
  const occupied=new Set(p.inFlight.flatMap(item=>(item.exclusiveResources||[]).map(claim=>claim.key)));
  const eligible=p.ready.filter(item=>item.independent&&item.safe&&item.dependencies.every(id=>completed.has(id))&&
    (item.exclusiveResources||[]).every(claim=>!occupied.has(claim.key))).map(item=>item.id);
  // A resolved prerequisite is a lead to verify, never permission to clear a separate human/data/resource block.
  const dependenciesReady=p.blocked.filter(item=>/^(dependency|依賴)(?:$|[：:\s])/i.test(item.kind||'')&&
    Array.isArray(item.dependencies)&&item.dependencies.length&&item.dependencies.every(id=>completed.has(id)))
    .map(item=>({id:item.id,dependencies:item.dependencies}));
  const covered=new Set(['ready','inFlight','blocked','returned'].flatMap(list=>(p[list]||[]).flatMap(item=>item.acceptanceIds||[])));
  const uncovered=(snapshot.acceptance?.items||[]).filter(item=>!['PASS','EXCLUDED'].includes(item.status)&&!covered.has(item.id)).map(item=>item.id);
  const basis=planningBasis(binding),verified=snapshot.capacity.verified,limit=snapshot.capacity.throttle?.limit??verified;
  return {basis,reviewRequired:Boolean(binding.contractStateSha256||snapshot.planningReview)&&snapshot.planningReview?.basis!==basis,
    source:{contractSha256:binding.contractSha256,contractStateSha256:binding.contractStateSha256||null},eligible,dependenciesReady,uncovered,
    capacity:{verified,dispatchLimit:limit,activeAgents:agentSeatCount(p.inFlight),free:Math.max(0,limit-agentSeatCount(p.inFlight)),
      ...(snapshot.capacity.throttle?{throttle:snapshot.capacity.throttle}:{})}};
}
function derive(snapshot,binding){
  const p=snapshot.packages,issues=[];
  const completed=new Set(p.completed.map(item=>item.id));
  const occupied=new Set(p.inFlight.flatMap(item=>(item.exclusiveResources||[]).map(claim=>claim.key)));
  const eligible=p.ready.filter(item=>item.independent&&item.safe&&item.dependencies.every(id=>completed.has(id))&&
    (item.exclusiveResources||[]).every(claim=>!occupied.has(claim.key))).map(item=>item.id).sort();
  const free=freeCapacity(snapshot);
  const readyById=new Map(p.ready.map(item=>[item.id,item])),readyClaims=new Map();
  for(const id of eligible)for(const claim of readyById.get(id).exclusiveResources){const ids=readyClaims.get(claim.key)||[];ids.push(id);readyClaims.set(claim.key,ids);}
  const exclusiveConflictGroups=[...readyClaims].filter(([,ids])=>ids.length>1).map(([resource,packages])=>({resource,packages:packages.sort()})).sort((a,b)=>a.resource.localeCompare(b.resource));
  if(['working','waiting','integrating'].includes(snapshot.activity)&&free>0&&eligible.length)issues.push(issue('ready_capacity',eligible,{freeCapacity:free,exclusiveConflictGroups}));
  const returned=p.returned.filter(item=>!item.integrated).map(item=>item.id).sort();
  if(['working','waiting'].includes(snapshot.activity)&&returned.length)issues.push(issue('returned_unintegrated',returned,{}));
  if(binding?.contractSha256){const review=planReview(snapshot,binding);
    if(review.reviewRequired)issues.push(issue('planning_review',[],{expectedBasis:review.basis,recordedBasis:snapshot.planningReview?.basis||null,
      source:review.source,eligible:review.eligible,uncovered:review.uncovered}));
    for(const item of review.dependenciesReady)issues.push(issue('dependency_ready_review',[item.id],{dependencies:item.dependencies}));}
  const claims=new Map();
  for(const item of p.inFlight)for(const claim of item.exclusiveResources||[]){const values=claims.get(claim.key)||[];values.push({id:item.id,kind:claim.kind});claims.set(claim.key,values);}
  for(const [resource,values] of [...claims].sort(([a],[b])=>a.localeCompare(b))){if(values.length>1)issues.push(issue('resource_conflict',values.map(value=>value.id),{resource,kinds:[...new Set(values.map(value=>value.kind))].sort()}));}
  for(const item of p.blocked.filter(item=>item.kind==='resource_conflict'))issues.push(issue('resource_conflict',[item.id],{resources:(item.exclusiveResources||[]).map(value=>value.key).sort()}));
  for(const item of p.recurringRework)issues.push(issue('recurring_rework',[item.id],{count:item.count}));
  return issues;
}
// An absent source or a writer in progress is unknown, never an empty work-package list.
function workPackageCheck(run,binding,snapshot,snapshotFile){
  const lock=path.join(run,'dispatch-write.lock');
  try{
    if(fs.existsSync(lock))return {available:false,reason:'WRITER_ACTIVE'};
    const roots=(binding.allowedRoots||[]).map(root=>fs.realpathSync(root));
    const inside=file=>roots.some(root=>file===root||file.startsWith(root+path.sep));
    const lists=['ready','inFlight','blocked','returned','completed','recurringRework'];
    const records=lists.flatMap(list=>(snapshot.packages[list]||[]).map(item=>({list,item})));
    let dir;
    if(snapshot.workPackageDirectory){
      dir=fs.realpathSync(snapshot.workPackageDirectory);
      if(!inside(dir)||path.basename(dir)!=='wp')return {available:false,reason:'UNTRUSTED_SOURCE'};
    }else{
      const candidates=new Set();
      for(const {item} of records)for(const value of item.evidence||[]){
        if(typeof value!=='string'||!path.isAbsolute(value)||path.basename(path.dirname(value))!=='wp'||!value.endsWith('.md'))continue;
        try{const file=fs.realpathSync(value),parent=path.dirname(file);if(inside(file)&&path.basename(parent)==='wp')candidates.add(parent);}catch{}
      }
      if(candidates.size!==1)return {available:false,reason:candidates.size?'AMBIGUOUS_SOURCE':'SOURCE_UNKNOWN'};
      dir=[...candidates][0];
    }
    const before=fs.readFileSync(snapshotFile,'utf8');
    if(JSON.stringify(JSON.parse(before))!==JSON.stringify(snapshot))return {available:false,reason:'WRITER_ACTIVE'};
    const byId=new Map(records.map(value=>[value.item.id,value])),found=new Set(),leads=[];
    for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.md')).sort()){
      const file=path.join(dir,name),real=fs.realpathSync(file);
      if(path.dirname(real)!==dir||!inside(real))return {available:false,reason:'UNTRUSTED_SOURCE'};
      const text=fs.readFileSync(real,'utf8'),match=/^\[狀態\][ \t]*(\{[^\n]*\})/m.exec(text);
      if(!match)return {available:false,reason:'INVALID_SOURCE'};
      let wp;try{wp=JSON.parse(match[1]);}catch{return {available:false,reason:'INVALID_SOURCE'};}
      const header=(text.match(/^\[工作包\][ \t]*(.*)$/m)||[])[1]||'';
      const id=(header.match(/id\s*[=＝]\s*([^；;\s]+)/)||[])[1]||path.basename(name,'.md');
      if(found.has(id))return {available:false,reason:'INVALID_SOURCE'};found.add(id);
      const recorded=byId.get(id),live=['ready','inFlight','blocked','returned'].includes(wp.list);
      if((live&&!recorded)||(recorded&&recorded.list!==wp.list)||
        (recorded?.list==='inFlight'&&wp.list==='inFlight'&&wp.handle&&wp.handle!==recorded.item.handle))
        leads.push({id,wpList:wp.list,snapshotList:recorded?.list||null,wpHandle:wp.handle||null,snapshotHandle:recorded?.item.handle||null,source:real});
    }
    if(fs.existsSync(lock)||fs.readFileSync(snapshotFile,'utf8')!==before)return {available:false,reason:'WRITER_ACTIVE'};
    return {available:true,leads};
  }catch(error){return {available:false,reason:['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:'READ_ERROR'};}
}
function inspect(run,binding,state){
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))return {enabled:false,issues:[],newIssues:[],resolved:[]};
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');let snapshot,issues,agentSource={available:false,error:'SNAPSHOT_UNAVAILABLE'},wpSource={available:false,reason:'SNAPSHOT_UNAVAILABLE'},snapshotAvailable=false,agentIssues=[],wpIssues=[];
  try{snapshot=parse(JSON.parse(fs.readFileSync(file,'utf8')),binding);
    if(snapshot.acceptance)acceptance.validate(snapshot.acceptance,contractState.effective(run,binding));
    else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');
    snapshotAvailable=true;
    issues=derive(snapshot,binding);
    wpSource=workPackageCheck(run,binding,snapshot,file);
    if(wpSource.available)for(const lead of wpSource.leads){const value=issue('wp_mismatch',[lead.id],lead);issues.push(value);wpIssues.push(value);}
    else{
      issues.push(...(state.dispatchAudit?.wpIssues||[]));
      if(wpSource.reason!=='WRITER_ACTIVE')issues.push(issue('wp_source_unknown',[],{reason:wpSource.reason}));
    }
    agentSource=activityCorrelation.localRuns(binding);
    for(const clue of activityCorrelation.correlate(snapshot,state,binding,agentSource.runs)){
      const value=issue(clue.kind,clue.affected,clue.detail);
      // A sustained issue produces one review, not a wake for each new edit or log timestamp.
      value.key=digest({kind:clue.kind,affected:clue.affected});issues.push(value);
      if(['agent_untracked','agent_finished_inflight'].includes(clue.kind))agentIssues.push(value);
    }
    // A previously observed transcript disappearing is unknown, not proof its agent has finished.
    if(agentSource.available){
      const known=new Set((agentSource.runs||[]).filter(item=>!item.workflow||item.label)
        .map(item=>item.workflow?'workflow:'+item.workflow+':'+item.label:'agent:'+item.id));
      const flight=new Set((snapshot.packages.inFlight||[]).map(item=>item.handle));
      for(const priorIssue of state.dispatchAudit?.agentIssues||[]){
        const handle=priorIssue.detail?.handle;
        if(!known.has(handle)&&(priorIssue.kind==='agent_untracked'?!flight.has(handle):flight.has(handle))){
          issues.push(priorIssue);agentIssues.push(priorIssue);
        }
      }
    }
    if(!agentSource.available)issues.push(...(state.dispatchAudit?.agentIssues||[]));
    for(const item of acceptance.issues(run,snapshot.acceptance)){const value=issue(item.kind,item.affected,item.detail);value.key=digest({kind:item.kind,affected:item.affected,cases:item.cases,episode:item.episode});issues.push(value);}}catch(error){
    const kind=error.code==='ENOENT'?'snapshot_missing':'snapshot_invalid';
    let sha256=null;try{sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{}
    issues=[issue(kind,[],{message:kind==='snapshot_missing'?'派工快照或相關資料無法找到':'派工快照或相關資料無法讀取或驗證',source:file,...(sha256?{sha256}:{})})];
  }
  const prior=state.dispatchAudit||{},previous=new Set(prior.active||[]),current=new Set(issues.map(item=>item.key));
  // A missing or unreadable snapshot cannot prove that any previous issue resolved.
  if(!snapshotAvailable)for(const key of previous)current.add(key);
  const announced=new Set((prior.announced||[]).filter(key=>current.has(key)));
  const occurrences={...(prior.occurrences||{})};let nextOccurrence=prior.nextOccurrence||0;
  for(const key of Object.keys(occurrences))if(!current.has(key))delete occurrences[key];
  for(const item of issues)if(!previous.has(item.key))occurrences[item.key]=++nextOccurrence;
  const newIssues=issues.filter(item=>!announced.has(item.key)).map(item=>({...item,occurrence:occurrences[item.key]}));
  const resolved=[...previous].filter(key=>!current.has(key));
  state.dispatchAudit={active:[...current],announced:[...announced],occurrences,nextOccurrence,lastCheckedAt:new Date().toISOString(),
    agentIssues:agentSource.available?agentIssues:(prior.agentIssues||[]),wpIssues:wpSource.available?wpIssues:(prior.wpIssues||[])};
  const agentHandles=(agentSource.runs||[]).filter(item=>!item.workflow||item.label).map(item=>item.workflow?'workflow:'+item.workflow+':'+item.label:'agent:'+item.id);
  return {enabled:true,file,snapshot,issues,newIssues,resolved,snapshotAvailable,agentHandles,wpSource:{available:wpSource.available,...(!wpSource.available?{reason:wpSource.reason}:{})},agentSource:{available:agentSource.available,...(!agentSource.available?{error:agentSource.error}:{})}};
}
function eventFor(result){
  if(!result.newIssues.length)return null;
  const items=result.newIssues.map(({kind,affected,detail,key,occurrence})=>({kind,affected,detail,key,occurrence}));
  return {id:'dispatch-'+digest(items).slice(0,24),kind:'dispatch_review',dispatchIssueKeys:items.map(item=>item.key),issues:items,snapshot:result.file,at:new Date().toISOString()};
}
function markAnnounced(state,event){const audit=state.dispatchAudit||{};const values=new Set(audit.announced||[]);for(const key of event.dispatchIssueKeys||[])values.add(key);audit.announced=[...values];state.dispatchAudit=audit;}
function releaseAnnounced(state,event){const keys=new Set(event.dispatchIssueKeys||[]),audit=state.dispatchAudit||{};audit.announced=(audit.announced||[]).filter(key=>!keys.has(key));state.dispatchAudit=audit;}
function stillCurrent(run,binding,state,event){const result=inspect(run,binding,state);const active=new Set(result.issues.map(item=>item.key));
  const needsAgentSource=(event.issues||[]).some(item=>['agent_untracked','agent_finished_inflight'].includes(item.kind));
  const needsWpSource=(event.issues||[]).some(item=>item.kind==='wp_mismatch');
  if(!result.snapshotAvailable||needsAgentSource&&!result.agentSource.available||needsWpSource&&!result.wpSource.available)return {current:null,result};
  const flight=new Set((result.snapshot?.packages?.inFlight||[]).map(item=>item.handle));
  const known=new Set(result.agentHandles||[]);
  const unknown=(event.issues||[]).some(item=>{
    if(!['agent_untracked','agent_finished_inflight'].includes(item.kind))return false;
    const handle=item.detail?.handle;
    return !known.has(handle)&&(item.kind==='agent_untracked'?!flight.has(handle):flight.has(handle));
  });
  if(unknown)return {current:null,result};
  return {current:event.dispatchIssueKeys?.every(key=>active.has(key)),result};}
module.exports={planningBasis,planReview,parse,derive,inspect,eventFor,markAnnounced,releaseAnnounced,stillCurrent,workPackageCheck,docBudgetStage,trackDocTime,freeCapacity,DOC_BUDGET_RATIO};
