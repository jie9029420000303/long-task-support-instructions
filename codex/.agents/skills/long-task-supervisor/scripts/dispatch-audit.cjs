const fs=require('node:fs');
const contractState=require('./contract-state.cjs');
const path=require('node:path');
const crypto=require('node:crypto');
const acceptance=require('./acceptance-audit.cjs');

const kinds=['ready_capacity','returned_unintegrated','resource_conflict','recurring_rework','snapshot_missing','snapshot_invalid','acceptance_rework','acceptance_withdrawn','snapshot_mismatch','untracked_agent','main_work_review','unrecorded_activity_review','planning_review','dependency_ready_review'];
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
    need(p&&/^[a-f0-9]{64}$/.test(p.basis)&&nonEmpty(p.reason)&&contractState.notLater(contractState.exactTime(p.at)),'planningReview needs basis, reason and at (a time with date, time and zone, not later than now)');}
  need(snapshot.packages&&typeof snapshot.packages==='object','packages is required');
  const p=snapshot.packages;
  for(const name of ['ready','inFlight','returned','blocked','completed','recurringRework'])records(p[name],name);
  for(const item of [...p.ready,...p.inFlight,...p.blocked])resources(item.exclusiveResources,item.id);
  for(const item of p.ready){need(typeof item.independent==='boolean'&&typeof item.safe==='boolean',item.id+' needs independent and safe');need(Array.isArray(item.dependencies),item.id+' dependencies must be an array');evidence(item.evidence,item.id);}
  for(const item of p.inFlight){need(nonEmpty(item.handle),item.id+' needs a platform handle');evidence(item.evidence,item.id);
    if(item.baseline!==undefined){const b=item.baseline;need(b&&Number.isFinite(b.minutes)&&b.minutes>0,item.id+' baseline.minutes must be positive');need(contractState.notLater(contractState.exactTime(b.startedAt)),item.id+' baseline.startedAt must be a time with date, time and zone, not later than now');need(nonEmpty(b.basis),item.id+' baseline.basis is required');}}
  for(const item of p.returned){need(typeof item.integrated==='boolean',item.id+' needs integrated');evidence(item.resultEvidence,item.id);}
  for(const item of p.blocked){need(nonEmpty(item.kind),item.id+' needs kind');evidence(item.evidence,item.id);}
  for(const item of p.completed){need(Array.isArray(item.acceptanceIds),item.id+' acceptanceIds must be an array');evidence(item.evidence,item.id);}
  for(const item of p.recurringRework){need(Number.isInteger(item.count)&&item.count>=2,item.id+' recurring count must be at least 2');evidence(item.evidence,item.id);}
  // The budget is 1.5x the measured development time; more needs the amendment where Jay allowed it.
  if(snapshot.docBudget!==undefined){const b=snapshot.docBudget;need(b&&contractState.notLater(contractState.exactTime(b.startedAt)),'docBudget.startedAt must be a time with date, time and zone, not later than now');
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
  const free=Math.max(0,(snapshot.capacity.throttle?.limit??snapshot.capacity.verified)-agentSeatCount(p.inFlight));
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
// Compare only concrete, readable sources. A difference is a lead for the supervisor, not a violation or dispatch.
function crossCheck(run,binding,snapshot,state,agents,coverage={}){
  const out=[],p=snapshot?.packages;if(!p)return out;
  const lists=['ready','inFlight','blocked','returned','completed','recurringRework'];
  const records=lists.flatMap(list=>(p[list]||[]).map(item=>({list,item})));
  const byId=new Map(records.map(({list,item})=>[item.id,{list,item}]));
  const dirs=new Set(),roots=(binding.allowedRoots||[]).map(root=>{try{return fs.realpathSync(root);}catch{return null;}}).filter(Boolean);
  coverage.checkedWp=new Set();coverage.workPackages='unknown';let incomplete=false;
  const snapshotFile=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');let snapshotBefore=null;
  try{snapshotBefore=fs.readFileSync(snapshotFile,'utf8');if(JSON.stringify(JSON.parse(snapshotBefore))!==JSON.stringify(snapshot))incomplete=true;}catch{}
  const trusted=raw=>{try{const real=fs.realpathSync(raw);return roots.some(root=>real===root||real.startsWith(root+path.sep))?real:null;}catch{return null;}};
  if(typeof snapshot.workPackageDirectory==='string'&&path.isAbsolute(snapshot.workPackageDirectory)){
    const dir=trusted(snapshot.workPackageDirectory);if(dir&&path.basename(dir)==='wp')dirs.add(dir);else incomplete=true;
  }
  for(const {item} of records){
    if(!/^[A-Za-z0-9_-]+$/.test(item.id||''))continue;
    for(const raw of item.evidence||[]){
      if(typeof raw!=='string'||!path.isAbsolute(raw)||path.extname(raw)!=='.md'||path.basename(path.dirname(raw))!=='wp')continue;
      const real=trusted(raw);if(real)dirs.add(path.dirname(real));else incomplete=true;
    }
  }
  const seenIds=new Set();
  if(!fs.existsSync(path.join(run,'dispatch-write.lock')))for(const dir of dirs){
    let files;try{files=fs.readdirSync(dir);coverage.workPackages='available';}catch{incomplete=true;continue;}
    for(const name of files){
      if(!/^[A-Za-z0-9_-]+\.md$/.test(name))continue;
      const file=path.join(dir,name);let wp,text;
      try{const real=fs.realpathSync(file);if(path.dirname(real)!==dir){incomplete=true;continue;}text=fs.readFileSync(real,'utf8');const m=/^\[狀態\][ \t]*(\{[^\n]*\})/m.exec(text);if(!m){incomplete=true;continue;}wp=JSON.parse(m[1]);}catch{incomplete=true;continue;}
      if(!['ready','inFlight','blocked','returned','completed','recurringRework','archived'].includes(wp.list)){incomplete=true;continue;}
      if(wp.list==='inFlight'&&!(typeof wp.handle==='string'&&wp.handle.trim())){incomplete=true;continue;}
      const headerLine=/^\[工作包\][ \t]*(.*)$/m.exec(text)?.[1]||'';
      const id=/id\s*[=＝]\s*([^；;\s]+)/.exec(headerLine)?.[1]||name.slice(0,-3);
      if(seenIds.has(id)){incomplete=true;continue;}seenIds.add(id);
      coverage.checkedWp.add(file);
      const recorded=byId.get(id);
      if(!recorded&&!['ready','inFlight','blocked','returned'].includes(wp.list))continue;
      if(!recorded||recorded.list!==wp.list||(wp.list==='inFlight'&&recorded.item.handle!==wp.handle))
        out.push({kind:'work_package_state',id,source:file,wpList:wp.list,snapshotList:recorded?.list||null,
          ...(wp.list==='inFlight'?{wpHandle:wp.handle,snapshotHandle:recorded?.item.handle||null}:{})});
      const scope=/^\[可修改範圍\][ \t]*([^\n]*(?:\n(?!\[|##)[^\n]*)*)/m.exec(text)?.[1]?.trim();
      const header=/^\[工作包\]([^\n]*(?:\n(?!\[|##)[^\n]*)*)/m.exec(text)?.[1]||'';
      if(recorded?.list==='inFlight'&&recorded.item.handle==='main'&&wp.list==='inFlight'&&wp.handle==='main'&&
        ['working','integrating'].includes(snapshot.activity)&&snapshot.capacity?.verified>agentSeatCount(p.inFlight)&&
        /類型\s*[=:＝：]\s*B\s*技術/.test(header))
        out.push({kind:'main_work_needs_review',id,source:file,scopeRecorded:Boolean(scope&&scope!=='無')});
    }
  }
  if(fs.existsSync(path.join(run,'dispatch-write.lock')))incomplete=true;
  if(snapshotBefore!==null)try{if(fs.readFileSync(snapshotFile,'utf8')!==snapshotBefore)incomplete=true;}catch{incomplete=true;}
  if(incomplete){coverage.workPackages='unknown';coverage.checkedWp.clear();for(let i=out.length-1;i>=0;i--)if(['work_package_state','main_work_needs_review'].includes(out[i].kind))out.splice(i,1);}
  const known=new Set((p.inFlight||[]).map(item=>item.handle));
  // Compacted rollouts can leave an older segment with an unfinished turn; only the newest segment is current.
  const latest=new Map();
  for(const a of agents||[]){const key=a.id||a.path;if(key&&(!latest.has(key)||(a.lastAt||0)>(latest.get(key).lastAt||0)))latest.set(key,a);}
  for(const a of latest.values()){
    if(!a.active||!/^\/root\/[A-Za-z0-9_-]+$/.test(a.path||'')||!Number.isFinite(a.lastAt)||a.lastAt<(Date.parse(binding.createdAt)||0))continue;
    if(known.has(a.path)||known.has(a.id)||known.has('agent:'+a.id)||known.has('agent:'+a.path))continue;
    out.push({kind:'active_agent_unlisted',id:a.path,source:a.sourceFile,lastAt:new Date(a.lastAt).toISOString()});
  }
  // A current empty snapshot cannot account for later executor activity. Do not include tool input or output.
  if(['working','integrating'].includes(snapshot.activity)&&!(p.inFlight||[]).length&&Number.isFinite(Date.parse(snapshot.updatedAt))&&state.lastExecutorWorkAt>Date.parse(snapshot.updatedAt)){
    const file=require('./pace.cjs').sessionFile(binding.executorId);
    if(file)out.push({kind:'executor_activity_after_empty_snapshot',id:'executor',source:file,activityAt:new Date(state.lastExecutorWorkAt).toISOString(),snapshotAt:snapshot.updatedAt});
  }
  return out;
}
function inspect(run,binding,state){
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))return {enabled:false,issues:[],newIssues:[],resolved:[]};
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');let snapshot,issues,agents=[],validSnapshot=false;const coverage={checkedWp:new Set(),workPackages:'unknown'};
  try{snapshot=parse(JSON.parse(fs.readFileSync(file,'utf8')),binding);
    if(snapshot.acceptance)acceptance.validate(snapshot.acceptance,contractState.effective(run,binding));
    else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');
    issues=derive(snapshot,binding);
    agents=require('./pace.cjs').agentRuns(binding);
    for(const lead of crossCheck(run,binding,snapshot,state,agents,coverage)){
      const type=({active_agent_unlisted:'untracked_agent',main_work_needs_review:'main_work_review',executor_activity_after_empty_snapshot:'unrecorded_activity_review'})[lead.kind]||'snapshot_mismatch';
      const value=issue(type,[lead.id],lead);
      // Activity timestamps advance during the same turn, but do not make it a new problem.
      if(['untracked_agent','main_work_review','unrecorded_activity_review'].includes(type))value.key=digest({kind:type,id:lead.id,source:lead.source});
      issues.push(value);
    }
    for(const item of acceptance.issues(run,snapshot.acceptance)){const value=issue(item.kind,item.affected,item.detail);value.key=digest({kind:item.kind,affected:item.affected,cases:item.cases,episode:item.episode});issues.push(value);}validSnapshot=true;}catch(error){
    const kind=error.code==='ENOENT'?'snapshot_missing':'snapshot_invalid';
    let sha256=null;try{sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{}
    issues=[issue(kind,[],{message:kind==='snapshot_missing'?'派工快照或相關資料無法找到':'派工快照或相關資料無法讀取或驗證',source:file,...(sha256?{sha256}:{})})];
  }
  const prior=state.dispatchAudit||{},previous=new Set(prior.active||[]),found=new Set(issues.map(item=>item.key));
  const oldItems={...(prior.items||{})};for(const item of state.pending?.issues||[])if(item.key)oldItems[item.key]||=item;
  const unknown=[];
  for(const key of previous){
    if(found.has(key))continue;
    const item=oldItems[key]||{kind:'source_unknown',affected:[],detail:{},key},source=item.detail?.source;
    if(validSnapshot&&!source)continue;
    let unreadable=!validSnapshot;
    if(!unreadable&&['snapshot_mismatch','main_work_review'].includes(item.kind))unreadable=!coverage.checkedWp.has(source);
    else if(!unreadable&&item.kind==='untracked_agent'){
      try{const fd=fs.openSync(source,'r');fs.closeSync(fd);unreadable=!agents.some(a=>a.sourceFile===source);}catch{unreadable=true;}
    }else if(!unreadable&&item.kind==='unrecorded_activity_review'){
      try{const fd=fs.openSync(source,'r');fs.closeSync(fd);}catch{unreadable=true;}
    }
    if(unreadable){unknown.push(key);issues.push({...item,unknown:true});if(['snapshot_mismatch','main_work_review'].includes(item.kind))coverage.workPackages='unknown';}
  }
  const current=new Set(issues.map(item=>item.key));
  const announced=new Set((prior.announced||[]).filter(key=>current.has(key)));
  const occurrences={...(prior.occurrences||{})};let nextOccurrence=prior.nextOccurrence||0;
  for(const key of Object.keys(occurrences))if(!current.has(key))delete occurrences[key];
  for(const item of issues)if(!previous.has(item.key))occurrences[item.key]=++nextOccurrence;
  const newIssues=issues.filter(item=>!item.unknown&&!announced.has(item.key)).map(item=>({...item,occurrence:occurrences[item.key]}));
  const resolved=[...previous].filter(key=>!current.has(key));
  state.dispatchAudit={active:[...current],announced:[...announced],occurrences,nextOccurrence,items:Object.fromEntries(issues.map(item=>[item.key,item])),lastCheckedAt:new Date().toISOString()};
  return {enabled:true,file,snapshot,issues,newIssues,resolved,unknown,coverage:{workPackages:coverage.workPackages}};
}
function eventFor(result){
  if(!result.newIssues.length)return null;
  const items=result.newIssues.map(({kind,affected,detail,key,occurrence})=>({kind,affected,detail,key,occurrence}));
  return {id:'dispatch-'+digest(items).slice(0,24),kind:'dispatch_review',dispatchIssueKeys:items.map(item=>item.key),issues:items,snapshot:result.file,at:new Date().toISOString()};
}
function markAnnounced(state,event){const audit=state.dispatchAudit||{};const values=new Set(audit.announced||[]);for(const key of event.dispatchIssueKeys||[])values.add(key);audit.announced=[...values];state.dispatchAudit=audit;}
// Three kinds of lead often clear themselves between two snapshot writes (A WebRPA 11/07-11/12: 91 reviews, 45 of them
// only recorded; Jay 2026-11-12 approved a programmed re-check first). The watcher holds a new one for 3 minutes and
// wakes the supervisor only if the next inspections still find it; one that clears is dropped unannounced. Other
// kinds wake at once. LONG_TASK_DISPATCH_HOLD_MS=0 turns the hold off.
const HOLD_KINDS=['ready_capacity','snapshot_mismatch','untracked_agent'];
const DISPATCH_HOLD_MS=process.env.LONG_TASK_DISPATCH_HOLD_MS===undefined||!Number.isFinite(Number(process.env.LONG_TASK_DISPATCH_HOLD_MS))?180000:Number(process.env.LONG_TASK_DISPATCH_HOLD_MS);
function hold(state,newIssues,holdMs=DISPATCH_HOLD_MS,at=Date.now()){
  const seen=state.dispatchHold||={},keys=new Set(newIssues.map(item=>item.key));
  for(const key of Object.keys(seen))if(!keys.has(key))delete seen[key];
  return newIssues.filter(item=>{
    if(!(holdMs>0)||!HOLD_KINDS.includes(item.kind))return true;
    seen[item.key]??=at;
    return at-seen[item.key]>=holdMs;
  });
}
function releaseAnnounced(state,event){const keys=new Set(event.dispatchIssueKeys||[]),audit=state.dispatchAudit||{};audit.announced=(audit.announced||[]).filter(key=>!keys.has(key));state.dispatchAudit=audit;}
function stillCurrent(run,binding,state,event){const result=inspect(run,binding,state);const active=new Set(result.issues.map(item=>item.key)),unknown=new Set(result.unknown||[]);
  return {current:event.dispatchIssueKeys?.some(key=>unknown.has(key))?null:event.dispatchIssueKeys?.every(key=>active.has(key)),result};}
// Every remaining package is blocked and none is ready or in flight (Jay 2026-11-10: 「不要因為等待我就停下來動作」; WEB
// 11/09 22:52 idled 12 minutes with 14 packages blocked, most of them only later in the plan). The supervisor checks each
// reason: a missing earlier result (an outside party's included), Jay himself, a resource in use, or a real duration the
// contract names or an outside time limit with its source. Coming later in the plan is not blocked.
function allBlocked(snapshot){
  const p=snapshot?.packages;
  if(!p||(p.inFlight||[]).length||(p.ready||[]).length||!(p.blocked||[]).length)return null;
  return {packages:p.blocked.map(item=>({id:item.id,kind:item.kind,...(Array.isArray(item.dependencies)&&item.dependencies.length?{dependencies:item.dependencies}:{}),
    ...(Array.isArray(item.acceptanceIds)&&item.acceptanceIds.length?{acceptanceIds:item.acceptanceIds}:{}),evidence:(item.evidence||[]).slice(0,2)}))};
}
module.exports={parse,derive,inspect,eventFor,markAnnounced,releaseAnnounced,hold,stillCurrent,crossCheck,agentSeatCount,planningBasis,planReview,docBudgetStage,trackDocTime,allBlocked,DOC_BUDGET_RATIO};
