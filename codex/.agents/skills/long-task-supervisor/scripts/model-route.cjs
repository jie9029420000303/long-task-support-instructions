#!/usr/bin/env node
// This resolver never switches a chat. Only explicit requests and observed tool inventories
// determine the role, model and supported reasoning level.
const fs=require('node:fs');
const {keyOf,subscriptionOpenAI,stopIndex,MAINLINE_STOPS,SUBAGENT_STOPS}=require('./model-fallback.cjs');
const {efforts,identity,available,latest}=require('./model-catalog.cjs');
const openrouter=()=>require('./openrouter-route.cjs');
// The executor plans, dispatches and judges the work: it runs at xhigh (Jay 2026-11-26 decision 1). Workers start at
// Medium on every closed model now that the mainline is stronger (decision 9, replacing 2026-11-23's Sonnet High);
// interface work keeps Low. Open-source routes are pinned at max by OpenCodex.
const roles={executor:'xhigh',general:'medium',ui:'low'};
const baseline=role=>roles[role];
// Unsuccessful deliveries of one criterion, counted without reset (Jay 2026-11-26 decision 33; rework.cjs keeps the
// count): the 1st, 3rd and 5th go back to the subagent that delivered, at the same model and effort (followup_task keeps
// its context and its trail of the error). The 2nd and 4th go to research first; then the 2nd opens a new subagent two
// efforts higher (an open-source model cannot go higher, so it moves to the next open-source stop: DeepSeek to Muse), and
// the 4th opens one on the executor's own model and effort. The 6th goes to research and then to Jay (no model here).
const CEILING='max',RESEARCH='xhigh',RAISE_AT=2,MAINLINE_AT=4,JAY_AT=6;
const isOpen=id=>openrouter().choices.some(route=>route.model===id);
// The models of a role's order that this inventory offers, front first.
function orderOf(role,catalog,fourth){
  const stops=role==='executor'?MAINLINE_STOPS:SUBAGENT_STOPS;
  const closed=stops.map(stop=>{
    const [kind,provider]=stop.split('|');
    return kind==='claude'?latest(catalog,'claude',provider,role==='executor'?'opus':'sonnet'):latest(catalog,'gpt',provider,kind);
  }).filter(Boolean);
  const open=openrouter().routes(role==='executor'?fourth:null,catalog).map(route=>catalog.find(item=>item.id===route.model)).filter(Boolean);
  return [...closed,...open];
}
function resolve(input) {
  const main=identity(input.supervisorModel);
  if(!input.supervisorModel)throw Error('Provide the observed supervisor model ID');
  if(!Array.isArray(input.roles)||!input.roles.length||input.roles.some(r=>!Object.hasOwn(roles,r)))throw Error('Request known roles');
  if(input.errors!==undefined)throw Error('errors 已改為 failures：這條驗收條文目前累計的不合格次數（rework.cjs status 的 failures），0 到 5');
  if(!main&&!openrouter().choices.some(r=>r.model===input.executorModel||r.model===input.supervisorModel))return {family:'unchanged',roles:{},reason:'Use the observed inventory for this model family.'};
  const result={family:main?.family||'openrouter',provider:main?.provider||'openrouter/',supervisorModel:input.supervisorModel,roles:{}};
  let limits={},openaiHeld=false,floors={};
  if(input.fallback){
    // The watcher publishes the executor side's limits, the ladder floor of each role and whether the OpenAI
    // subscription is out; before its first reading nothing is held here and the watcher moves the mainline later.
    try{const published=JSON.parse(fs.readFileSync(input.fallback,'utf8'));limits=published.limits||{};floors=published.ladder?.floors||{};
      openaiHeld=published.openaiQuota?.subscriptionHeld===true;}
    catch(error){if(error.code!=='ENOENT')throw error;} // A new run has no limit ledger yet.
  }
  const refused=id=>Date.parse(limits[keyOf(id)]?.until)>Date.now()||isOpen(id)&&Date.parse(limits['openrouter/']?.until)>Date.now();
  const serving=id=>!refused(id)&&!(openaiHeld&&subscriptionOpenAI(id));
  const failures=input.failures??0;
  if(!Number.isInteger(failures)||failures<0)throw Error('failures 是這條驗收條文累計的不合格次數（不歸零），0 以上的整數');
  if(input.previousEffort!==undefined&&!efforts.includes(input.previousEffort))throw Error('previousEffort must be one of '+efforts.join(', '));
  for(const role of input.roles){
    const worker=role!=='executor', side=worker?'subagent':'executor';
    const catalog=available(input.catalogs?.[worker?'subagent':'executor']||[]);
    const override=input.overrides?.[role]||{}, research=worker&&input.research===true, step=worker?failures:0;
    const unavailable=reason=>{result.roles[role]={status:'unavailable',reason};};
    if(research&&step%2===1){unavailable('研究在第 2、4、6 次不合格後才派：failures 要是偶數');continue;}
    if(step>=JAY_AT&&!research){unavailable('這條已累計 '+step+' 次不合格：研究登記後由監督在待決帳問 Jay，裁決前不再派這條');continue;}
    const executorModel=input.executorModel||input.supervisorModel;
    // 1st, 3rd and 5th: the same subagent again, same model and effort, with the correction (followup_task).
    if(step%2===1&&!override.model){
      if(!input.previousModel||!input.previousEffort){unavailable('交回原子代理重做要附 previousModel 與 previousEffort（它剛才的模型與推理）');continue;}
      result.roles[role]={status:'ready',model:input.previousModel,effort:input.previousEffort,basis:'same-subagent',reuse:true};
      continue;
    }
    const order=orderOf(side,catalog,input.fourthExecutorModel);
    // The ladder floor, never past the last stop that can still serve.
    const usable=order.filter(item=>serving(item.id));
    const floorAt=Math.min(floors[side]||0,Math.max(0,...usable.map(item=>stopIndex(item.id,side)??0)));
    const allowed=usable.filter(item=>(stopIndex(item.id,side)??0)>=floorAt);
    let basis=Object.keys(override).length?'explicit-user-override':'role-policy', selected, restoreAfter;
    if(override.model)selected=catalog.find(x=>x.id===override.model);
    else if(worker&&step===MAINLINE_AT&&!research){
      // 4th: the executor's own model and effort.
      selected=catalog.find(x=>x.id===executorModel)||(isOpen(executorModel)?{id:executorModel,efforts:['max']}:null);basis='executor-equivalent';
    }else if(worker&&step===RAISE_AT&&!research&&input.previousModel&&isOpen(input.previousModel)){
      // An open-source model cannot raise its effort: the next open-source stop stands for the raise (DeepSeek to Muse).
      const at=order.findIndex(item=>item.id===input.previousModel);
      selected=order.slice(at+1).find(item=>isOpen(item.id)&&serving(item.id))||order.find(item=>item.id===input.previousModel);basis='open-source-next';
    }else if(worker&&step===RAISE_AT&&!research&&input.previousModel&&allowed.some(item=>item.id===input.previousModel)){
      selected=allowed.find(item=>item.id===input.previousModel);
    }else selected=allowed[0];
    if(!selected){unavailable('The requested enabled role/model is unavailable in this tool inventory');continue;}
    if(!override.model&&order[0]&&selected.id!==order[0].id&&refused(order[0].id))restoreAfter=limits[keyOf(order[0].id)]?.until;
    if(!override.model&&order[0]&&selected.id!==order[0].id&&basis==='role-policy')basis=floorAt>0?'quota-ladder':'rate-limit-fallback';
    const open=isOpen(selected.id);
    const supported=open?['max']:efforts.filter(e=>selected.efforts.includes(e));
    const rank=e=>efforts.indexOf(e);
    let effort,extra={};
    if(override.effort)effort=override.effort;
    else if(open)effort='max';
    else if(worker&&step===MAINLINE_AT&&!research)effort=input.executorEffort||roles.executor;
    else if(research)effort=RESEARCH;
    else if(worker&&step===RAISE_AT){
      const prior=input.previousEffort&&rank(input.previousEffort)>rank(baseline(role))?input.previousEffort:baseline(role);
      const want=Math.min(rank(prior)+2,rank(CEILING));
      effort=supported.filter(e=>rank(e)<=want).at(-1)||prior;
      if(rank(effort)<=rank(prior))extra.effortAtCeiling=true;
    }else effort=baseline(role);
    if(open&&step===RAISE_AT&&selected.id===input.previousModel)extra.effortAtCeiling=true;
    if(!supported.includes(effort)){unavailable('The selected model does not support '+effort);continue;}
    result.roles[role]={status:'ready',model:selected.id,effort,basis,...(worker?{newAgent:true}:{}),...extra,...(research?{research:true}:{}),...(restoreAfter?{restoreAfter}:{})};
  }
  return result;
}
// A worker's executorModel and executorEffort come from the calling chat's own rollout, not a stale input.
function observedInput(input,threadId){
  if(!threadId || !input.roles?.some(role=>role==='general'||role==='ui'))return input;
  const observed=require('./model-fallback.cjs').settingsOf(threadId);
  return observed?.model?{...input,executorModel:observed.model,...(observed.effort?{executorEffort:observed.effort}:{})}:input;
}
module.exports={resolve,observedInput};
if(require.main===module){try{console.log(JSON.stringify(resolve(observedInput(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.env.CODEX_THREAD_ID)),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}}
