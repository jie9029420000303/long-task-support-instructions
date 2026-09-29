const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const kinds=['ready_capacity','returned_unintegrated','resource_conflict','recurring_rework','snapshot_missing','snapshot_invalid'];
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
  need(snapshot.packages&&typeof snapshot.packages==='object','packages is required');
  const p=snapshot.packages;
  for(const name of ['ready','inFlight','returned','blocked','completed','recurringRework'])records(p[name],name);
  for(const item of [...p.ready,...p.inFlight,...p.blocked])resources(item.exclusiveResources,item.id);
  for(const item of p.ready){need(typeof item.independent==='boolean'&&typeof item.safe==='boolean',item.id+' needs independent and safe');need(Array.isArray(item.dependencies),item.id+' dependencies must be an array');evidence(item.evidence,item.id);}
  for(const item of p.inFlight){need(nonEmpty(item.handle),item.id+' needs a platform handle');evidence(item.evidence,item.id);}
  for(const item of p.returned){need(typeof item.integrated==='boolean',item.id+' needs integrated');evidence(item.resultEvidence,item.id);}
  for(const item of p.blocked){need(nonEmpty(item.kind),item.id+' needs kind');evidence(item.evidence,item.id);}
  for(const item of p.completed){need(Array.isArray(item.acceptanceIds),item.id+' acceptanceIds must be an array');evidence(item.evidence,item.id);}
  for(const item of p.recurringRework){need(Number.isInteger(item.count)&&item.count>=2,item.id+' recurring count must be at least 2');evidence(item.evidence,item.id);}
  if(snapshot.updatedAt!==undefined)need(nonEmpty(snapshot.updatedAt),'updatedAt must be a string');
  return snapshot;
}
function issue(kind,items,detail){need(kinds.includes(kind),'unknown issue kind');const affected=[...new Set(items)].sort();const key=digest({kind,affected,detail});return {kind,affected,detail,key};}
function derive(snapshot){
  const p=snapshot.packages,issues=[];
  const completed=new Set(p.completed.map(item=>item.id));
  const occupied=new Set(p.inFlight.flatMap(item=>(item.exclusiveResources||[]).map(claim=>claim.key)));
  const eligible=p.ready.filter(item=>item.independent&&item.safe&&item.dependencies.every(id=>completed.has(id))&&
    (item.exclusiveResources||[]).every(claim=>!occupied.has(claim.key))).map(item=>item.id).sort();
  const free=Math.max(0,snapshot.capacity.verified-p.inFlight.length);
  const readyById=new Map(p.ready.map(item=>[item.id,item])),readyClaims=new Map();
  for(const id of eligible)for(const claim of readyById.get(id).exclusiveResources){const ids=readyClaims.get(claim.key)||[];ids.push(id);readyClaims.set(claim.key,ids);}
  const exclusiveConflictGroups=[...readyClaims].filter(([,ids])=>ids.length>1).map(([resource,packages])=>({resource,packages:packages.sort()})).sort((a,b)=>a.resource.localeCompare(b.resource));
  if(['working','waiting'].includes(snapshot.activity)&&free>0&&eligible.length)issues.push(issue('ready_capacity',eligible,{freeCapacity:free,exclusiveConflictGroups}));
  const returned=p.returned.filter(item=>!item.integrated).map(item=>item.id).sort();
  if(snapshot.activity==='waiting'&&returned.length)issues.push(issue('returned_unintegrated',returned,{}));
  const claims=new Map();
  for(const item of p.inFlight)for(const claim of item.exclusiveResources||[]){const values=claims.get(claim.key)||[];values.push({id:item.id,kind:claim.kind});claims.set(claim.key,values);}
  for(const [resource,values] of [...claims].sort(([a],[b])=>a.localeCompare(b))){if(values.length>1)issues.push(issue('resource_conflict',values.map(value=>value.id),{resource,kinds:[...new Set(values.map(value=>value.kind))].sort()}));}
  for(const item of p.blocked.filter(item=>item.kind==='resource_conflict'))issues.push(issue('resource_conflict',[item.id],{resources:(item.exclusiveResources||[]).map(value=>value.key).sort()}));
  for(const item of p.recurringRework)issues.push(issue('recurring_rework',[item.id],{count:item.count}));
  return issues;
}
function inspect(run,binding,state){
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))return {enabled:false,issues:[],newIssues:[],resolved:[]};
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');let snapshot,issues;
  try{snapshot=parse(JSON.parse(fs.readFileSync(file,'utf8')),binding);issues=derive(snapshot);}catch(error){
    const kind=error.code==='ENOENT'?'snapshot_missing':'snapshot_invalid';
    issues=[issue(kind,[],{message:error.message})];
  }
  const prior=state.dispatchAudit||{},previous=new Set(prior.active||[]),current=new Set(issues.map(item=>item.key));
  const announced=new Set((prior.announced||[]).filter(key=>current.has(key)));
  const occurrences={...(prior.occurrences||{})};let nextOccurrence=prior.nextOccurrence||0;
  for(const key of Object.keys(occurrences))if(!current.has(key))delete occurrences[key];
  for(const item of issues)if(!previous.has(item.key))occurrences[item.key]=++nextOccurrence;
  const newIssues=issues.filter(item=>!announced.has(item.key)).map(item=>({...item,occurrence:occurrences[item.key]}));
  const resolved=[...previous].filter(key=>!current.has(key));
  state.dispatchAudit={active:[...current],announced:[...announced],occurrences,nextOccurrence,lastCheckedAt:new Date().toISOString()};
  return {enabled:true,file,snapshot,issues,newIssues,resolved};
}
function eventFor(result){
  if(!result.newIssues.length)return null;
  const items=result.newIssues.map(({kind,affected,detail,key,occurrence})=>({kind,affected,detail,key,occurrence}));
  return {id:'dispatch-'+digest(items).slice(0,24),kind:'dispatch_review',dispatchIssueKeys:items.map(item=>item.key),issues:items,snapshot:result.file,at:new Date().toISOString()};
}
function markAnnounced(state,event){const audit=state.dispatchAudit||{};const values=new Set(audit.announced||[]);for(const key of event.dispatchIssueKeys||[])values.add(key);audit.announced=[...values];state.dispatchAudit=audit;}
function releaseAnnounced(state,event){const keys=new Set(event.dispatchIssueKeys||[]),audit=state.dispatchAudit||{};audit.announced=(audit.announced||[]).filter(key=>!keys.has(key));state.dispatchAudit=audit;}
function stillCurrent(run,binding,state,event){const result=inspect(run,binding,state);const active=new Set(result.issues.map(item=>item.key));return {current:event.dispatchIssueKeys?.every(key=>active.has(key)),result};}
module.exports={parse,derive,inspect,eventFor,markAnnounced,releaseAnnounced,stillCurrent};
