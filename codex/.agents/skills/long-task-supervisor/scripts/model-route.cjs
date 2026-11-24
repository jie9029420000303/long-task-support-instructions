#!/usr/bin/env node
// This resolver never switches a chat. Only explicit requests and observed tool inventories
// determine the role, model and supported reasoning level.
const fs=require('node:fs');
const {keyOf}=require('./model-fallback.cjs');
const {efforts,identity,available,latest}=require('./model-catalog.cjs');
const roles={executor:'high',general:'medium',ui:'low'};
// A Sonnet general worker (A check, B technical, C research) starts at High (Jay 2026-11-23「子代理sonnet 改為high」:
// AA rates Sonnet High 41.5 overall and 25.7% on coding, Medium 30.8 and 11.0%). GPT workers keep Medium and
// interface work keeps Low. The failure step starts from this level, so a Sonnet package goes High, then max.
const sonnetGeneral='high';
const baseline=(role,model)=>role==='general'&&identity(model)?.tier==='sonnet'?sonnetGeneral:roles[role];
// After an unsuccessful delivery (Jay 2026-11-23 21:50, 23:03): the first raises the same model two reasoning steps,
// at most max, in a new subagent (followup_task cannot change the effort); the second goes to research at xhigh and
// the research returns to the second attempt's subagent with the count reset. A reset never lowers the effort. There
// is no model change and no mainline takeover: the cycle repeats until the criterion passes. rework.cjs keeps the count.
const CEILING='max',RESEARCH='xhigh';
function resolve(input) {
  const main=identity(input.supervisorModel);
  if(!input.supervisorModel)throw Error('Provide the observed supervisor model ID');
  if(!Array.isArray(input.roles)||!input.roles.length||input.roles.some(r=>!Object.hasOwn(roles,r)))throw Error('Request known roles');
  if(!main&&!require('./openrouter-route.cjs').choices.some(r=>r.model===input.executorModel||r.model===input.supervisorModel))return {family:'unchanged',roles:{},reason:'Use the observed inventory for this model family.'};
  const result={family:main?.family||'openrouter',provider:main?.provider||'openrouter/',supervisorModel:input.supervisorModel,roles:{}};
  let limits={},claudeOk=true;
  if(input.fallback){
    // The watcher publishes the executor's limits and whether the Claude reserve lets the executor side use the
    // subscription; before its first reading nothing is held here and the watcher moves the mainline later.
    try{const published=JSON.parse(fs.readFileSync(input.fallback,'utf8'));limits=published.limits||{};claudeOk=published.claudeQuota?.executorMayUseClaude!==false;}
    catch(error){if(error.code!=='ENOENT')throw error;} // A new run has no limit ledger yet.
  }
  const limited=id=>Date.parse(limits[keyOf(id)]?.until)>Date.now()||String(id).startsWith('openrouter/')&&Date.parse(limits['openrouter/']?.until)>Date.now();
  for(const role of input.roles){
    const worker=role!=='executor', owner=worker?identity(input.executorModel||input.supervisorModel):main;
    const catalog=available(input.catalogs?.[worker?'subagent':'executor']||[]);
    const override=input.overrides?.[role]||{}, errors=worker?(input.errors||0):0;
    if(!Number.isInteger(errors)||errors<0||errors>1)throw Error('errors is the unsuccessful deliveries since the last reset of this criterion: 0 or 1 (the second goes to research)');
    const research=worker&&input.research===true;
    if(research&&errors)throw Error('A research worker starts its own count: omit errors');
    if(input.previousEffort!==undefined&&!efforts.includes(input.previousEffort))throw Error('previousEffort must be one of '+efforts.join(', '));
    const unavailable=reason=>{result.roles[role]={status:'unavailable',reason};};
    const executorModel=input.executorModel||input.supervisorModel;
    if(worker && require('./openrouter-route.cjs').choices.some(r=>r.model===executorModel)){
      const requested=override.model||executorModel;
      const permitted=require('./openrouter-route.cjs').routes(null,catalog).some(r=>r.model===requested);
      if(requested!==executorModel || !permitted || limited(requested) || (override.effort && override.effort!=='max')){
        unavailable('The approved upstream must be available in the actual worker inventory');continue;
      }
      // OpenCodex pins the open-source routes at max: a raise or a research worker stays there.
      result.roles[role]={status:'ready',model:requested,effort:'max',basis:'execution-mainline',...(errors||research?{effortAtCeiling:true}:{}),...(errors?{newAgent:true}:{})};
      continue;
    }
    if(!owner){unavailable('Unknown execution mainline model family');continue;}
    const tier=owner.family==='claude'?'sonnet':'terra';
    // Every Claude role on the executor side uses the subscription path; the API key is kept for the supervisor
    // (Jay 2026-11-21), even when the supervisor itself runs on it.
    const provider=owner.family==='claude'?'anthropic/':owner.provider;
    if(worker&&owner.family==='claude'&&!claudeOk&&!override.model){
      unavailable('Claude 訂閱保留給監督：先不派新的 Claude 子代理，背景程式會把執行主線改用 Sol，之後子代理用 Terra');continue;
    }
    let basis=Object.keys(override).length?'explicit-user-override':'role-policy', restoreAfter;
    // The executor starts on subscription Sonnet under a Claude supervisor, or on Sol while the reserve holds.
    const start=()=>{
      if(main.family!=='claude')return catalog.find(x=>x.id===input.supervisorModel);
      if(claudeOk)return latest(catalog,'claude','anthropic/','sonnet');
      basis='claude-reserve';return latest(catalog,'gpt','','sol');
    };
    let selected=override.model?catalog.find(x=>x.id===override.model):
      worker?latest(catalog,owner.family,provider,tier):start();
    if(selected && identity(selected.id)?.family!==owner.family && worker){unavailable('The worker must be compatible with the execution mainline');continue;}
    if(selected && limited(selected.id) && !override.model){
      restoreAfter=limits[keyOf(selected.id)].until;
      const m=identity(selected.id);
      // Workers never use the Claude API key (Jay 2026-11-21): it is kept for the supervisor.
      const substitute=m.family==='claude'?[latest(catalog,m.family,'anthropic/',m.tier)].find(x=>x&&!limited(x.id)):null;
      const sol=worker?null:latest(catalog,'gpt','','sol');
      selected=substitute||(sol&&!limited(sol.id)?sol:null);basis='rate-limit-fallback';
    }
    if(!selected){unavailable('The requested enabled role/model is unavailable in this tool inventory');continue;}
    const supported=efforts.filter(e=>selected.efforts.includes(e));
    const base=baseline(role,selected.id);
    const rank=e=>efforts.indexOf(e);
    // The level the package last ran at; a reset keeps it.
    const prior=worker&&input.previousEffort&&rank(input.previousEffort)>rank(base)?input.previousEffort:base;
    const usable=supported.filter(e=>rank(e)<=rank(CEILING));
    let effort=override.effort||(research?RESEARCH:prior), ceiling={};
    if(errors && !override.effort){
      const want=Math.min(rank(prior)+2,rank(CEILING));
      effort=usable.filter(e=>rank(e)<=want).at(-1)||prior;
      ceiling={newAgent:true,...(rank(effort)<=rank(prior)?{effortAtCeiling:true}:{})};
    }
    if(!supported.includes(effort)){unavailable('The selected model does not support '+effort);continue;}
    result.roles[role]={status:'ready',model:selected.id,effort,basis,...ceiling,...(research?{research:true}:{}),...(restoreAfter?{restoreAfter}:{})};
  }
  return result;
}
function observedInput(input,threadId){
  if(!threadId || !input.roles?.some(role=>role==='general'||role==='ui'))return input;
  const observed=require('./model-fallback.cjs').settingsOf(threadId)?.model;
  return observed?{...input,executorModel:observed}:input;
}
module.exports={resolve,observedInput,sonnetGeneral};
if(require.main===module){try{console.log(JSON.stringify(resolve(observedInput(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.env.CODEX_THREAD_ID)),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}}
