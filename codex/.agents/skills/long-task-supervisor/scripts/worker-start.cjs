// Dispatch records an observed start. Only the executor assigns work; a watcher can repair
// a continuation of a known package when its worker is already running a later turn.
const fs=require('node:fs'), path=require('node:path');
const pace=require('./pace.cjs');
const {notLater,exactTime}=require('./contract-state.cjs');
const ref=handle=>typeof handle==='string'?handle.replace(/^agent:/,''):'';

function declared(raw){
  if(!raw)return null;
  let row;try{row=JSON.parse(raw);}catch{return null;}
  if(!row||typeof row!=='object')return null;
  const {baselineMinutes,...values}=row;
  const minutes=values.minutes??baselineMinutes;
  if(!Number.isFinite(minutes)||minutes<=0||typeof values.basis!=='string'||!values.basis.trim()||
      !notLater(exactTime(values.startedAt)))return null;
  return {...values,minutes};
}

function fill(value,previous,binding,run){
  const old=new Map((previous?.packages?.inFlight||[]).map(row=>[row.id,row]));
  let workers,measured,settings;
  for(const item of value.packages.inFlight){
    if(item.baseline)continue;
    const prior=old.get(item.id);
    if(prior?.handle===item.handle && prior.baseline && (!item.activeTurnId || item.activeTurnId===prior.activeTurnId) &&
        (!item.startedAt || Date.parse(item.startedAt)===Date.parse(prior.baseline.startedAt))){
      item.baseline=prior.baseline;continue;
    }
    const handle=ref(item.handle);
    if(handle!=='main' && !handle.startsWith('/root/') && !/^[a-f0-9-]{36}$/i.test(handle))continue;
    workers??=pace.agentRuns(binding);
    const matches=workers.filter(a=>a.id===handle||a.path===handle);
    const worker=matches.length===1?matches[0]:null;
    if(handle==='main' && settings===undefined){
      try{settings=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'),'utf8')).executorSettings||null;}catch{settings=null;}
    }
    const model=worker?.model||item.model||(handle==='main'?settings?.model:null);
    if(!model)continue;
    const started=item.startedAt || (worker?.turnStartedAt?new Date(worker.turnStartedAt).toISOString():null) ||
      (!prior?new Date().toISOString():null);
    if(!started)continue;
    measured??=pace.speed(workers);
    item.baseline={...pace.baseline({model,estimatedOutputTokens:item.estimatedOutputTokens,toolMinutes:item.toolMinutes},measured),startedAt:started};
  }
}

function continuation(snapshot,agent){
  if(!agent?.active || !agent.turnId || !agent.turnStartedAt || !agent.model)return null;
  const owners=snapshot.workerOwners||{},owner=owners[agent.id]||owners[agent.path];
  if(!owner || (owners[agent.id] && owners[agent.path] && owners[agent.id]!==owners[agent.path]))return null;
  const lists=snapshot.packages;
  const prior=[...(lists.completed||[]),...(lists.returned||[]).filter(x=>x.integrated)].find(x=>x.id===owner);
  if(!prior || prior.submission || prior.testKind==='formal' || prior.activeTurnId===agent.turnId)return null;
  return prior;
}
module.exports={declared,fill,continuation};
