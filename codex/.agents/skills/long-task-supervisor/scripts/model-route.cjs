#!/usr/bin/env node
// This resolver never switches a chat. Only explicit requests and observed tool inventories
// determine the role, model and supported reasoning level.
const fs=require('node:fs');
const {keyOf}=require('./model-fallback.cjs');
const {tiers,efforts,identity,available,latest}=require('./model-catalog.cjs');
const roles={executor:'high',general:'medium',ui:'low'};
function resolve(input) {
  const main=identity(input.supervisorModel);
  if(!input.supervisorModel)throw Error('Provide the observed supervisor model ID');
  if(!Array.isArray(input.roles)||!input.roles.length||input.roles.some(r=>!Object.hasOwn(roles,r)))throw Error('Request known roles');
  if(!main&&!require('./openrouter-route.cjs').choices.some(r=>r.model===input.executorModel||r.model===input.supervisorModel))return {family:'unchanged',roles:{},reason:'Use the observed inventory for this model family.'};
  const result={family:main?.family||'openrouter',provider:main?.provider||'openrouter/',supervisorModel:input.supervisorModel,roles:{}};
  let limits={};
  if(input.fallback){
    try{limits=JSON.parse(fs.readFileSync(input.fallback,'utf8')).limits||{};}
    catch(error){if(error.code!=='ENOENT')throw error;} // A new run has no limit ledger yet.
  }
  const limited=id=>Date.parse(limits[keyOf(id)]?.until)>Date.now();
  for(const role of input.roles){
    const worker=role!=='executor', owner=worker?identity(input.executorModel||input.supervisorModel):main;
    const catalog=available(input.catalogs?.[worker?'subagent':'executor']||[]);
    const override=input.overrides?.[role]||{}, errors=worker?(input.errors||0):0;
    if(!Number.isInteger(errors)||errors<0)throw Error('errors must be a nonnegative integer for this work package');
    const unavailable=reason=>{result.roles[role]={status:'unavailable',reason};};
    if(errors>=4){result.roles[role]={status:'takeover',reason:'Fourth unsuccessful delivery; execution mainline takes over'};continue;}
    const executorModel=input.executorModel||input.supervisorModel;
    if(worker && require('./openrouter-route.cjs').choices.some(r=>r.model===executorModel)){
      const requested=override.model||executorModel;
      const permitted=require('./openrouter-route.cjs').routes(null,catalog).some(r=>r.model===requested);
      if(requested!==executorModel || !permitted || limited(requested) || (override.effort && override.effort!=='max')){
        unavailable('The approved upstream must be available in the actual worker inventory');continue;
      }
      result.roles[role]={status:'ready',model:requested,effort:'max',basis:'execution-mainline',...(errors===3?{modelAtCeiling:true,effortAtCeiling:true}:{})};
      continue;
    }
    if(!owner){unavailable('Unknown execution mainline model family');continue;}
    let tier=owner.family==='claude'?'sonnet':'terra';
    const previous=input.previousModel && identity(input.previousModel);
    if(errors===3){
      if(!previous || previous.family!==owner.family || !efforts.includes(input.previousEffort)){unavailable('Provide the last actual worker model and effort for escalation');continue;}
      const ladder=tiers[owner.family], level=ladder.indexOf(previous.tier);
      tier=ladder[Math.min(level+1,ladder.length-1)];
    }
    let selected=override.model?catalog.find(x=>x.id===override.model):
      worker?latest(catalog,owner.family,owner.provider,tier):catalog.find(x=>x.id===input.supervisorModel);
    let basis=Object.keys(override).length?'explicit-user-override':'role-policy', restoreAfter;
    if(selected && identity(selected.id)?.family!==owner.family && worker){unavailable('The worker must be compatible with the execution mainline');continue;}
    if(selected && limited(selected.id) && !override.model){
      restoreAfter=limits[keyOf(selected.id)].until;
      const m=identity(selected.id);
      const substitute=m.family==='claude'?['anthropic/','anthropic-apikey/'].map(provider=>latest(catalog,m.family,provider,m.tier)).find(x=>x&&!limited(x.id)):null;
      const sol=worker?null:latest(catalog,'gpt','','sol');
      selected=substitute||(sol&&!limited(sol.id)?sol:null);basis='rate-limit-fallback';
    }
    if(!selected){unavailable('The requested enabled role/model is unavailable in this tool inventory');continue;}
    const supported=efforts.filter(e=>selected.efforts.includes(e));
    let effort=override.effort||roles[role];
    if(errors && !override.effort){
      const prior=errors===3?input.previousEffort:roles[role];
      const higher=supported.filter(e=>efforts.indexOf(e)>efforts.indexOf(prior));
      effort=higher[Math.min(higher.length,errors===3?1:errors)-1]||supported.at(-1);
      if(efforts.indexOf(effort)<efforts.indexOf(prior)){unavailable('Escalation would reduce the previous effort');continue;}
    }
    if(!supported.includes(effort)){unavailable('The selected model does not support '+effort);continue;}
    let ceiling={};
    if(errors===3){
      if(identity(selected.id)?.tier!==tier){unavailable('The explicit model cannot satisfy this research escalation');continue;}
      const effortStep=efforts.indexOf(effort)-efforts.indexOf(input.previousEffort);
      const effortAtCeiling=effortStep===0 && effort===supported.at(-1);
      if(effortStep<0 || (effortStep===0&&!effortAtCeiling)){unavailable('This research retry requires higher reasoning');continue;}
      ceiling={modelAtCeiling:previous.tier===tier,effortAtCeiling};
    }
    result.roles[role]={status:'ready',model:selected.id,effort,basis,...ceiling,...(restoreAfter?{restoreAfter}:{})};
  }
  return result;
}
module.exports={resolve};
if(require.main===module){try{console.log(JSON.stringify(resolve(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}}
