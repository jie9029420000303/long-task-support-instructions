// The skill selects the model. OpenCodex owns the price-ranked supplier list for each model.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const catalog=require('./model-catalog.cjs');
const choices=[
  {raw:'deepseek/deepseek-v4.1-flash-1017',provider:'ambient/fp4'},
  {raw:'meta/muse-ember',provider:'google-vertex/global'}
].map(x=>({...x,model:'openrouter/'+x.raw.replace('/','-')}));
function hasEligibleSupplier(rule,legacyPin){
  const only=rule?.only;
  if(!Array.isArray(only)||!only.length)return false;
  // Older installations pin one approved supplier without a ranked list.
  if(rule.order===undefined)return rule.allowFallbacks===false && only.length===1 && only[0]===legacyPin;
  // The daily price refresh writes the same ordered list to order and only. When nothing
  // qualifies it writes an unmatched selector so OpenRouter cannot route the request.
  return Array.isArray(rule.order) && rule.order.length===only.length &&
    rule.allowFallbacks===(only.length>1) && new Set(only).size===only.length &&
    only.every((id,i)=>typeof id==='string' && id.length>0 && id.trim()===id &&
      id!=='opencodex-price-cap.invalid/no-eligible-endpoint' && id===rule.order[i]);
}
function routes(preference,items=catalog.installed()){
  let config;
  try{config=JSON.parse(fs.readFileSync(path.join(process.env.OPENCODEX_HOME||path.join(os.homedir(),'.opencodex'),'config.json')));}
  catch{return [];}
  const provider=config.providers?.openrouter;
  if(!provider || provider.disabled===true)return [];
  const visible=catalog.available(items);
  const ordered=preference?[...choices].sort((a,b)=>Number(b.model===preference.model)-Number(a.model===preference.model)):choices;
  return ordered.filter(({raw,model,provider:pin})=>{
    const rule=provider?.modelOpenRouterRouting?.[raw];
    return !config.disabledModels?.includes(model) && (!provider.enforceSelectedModels || provider.selectedModels?.includes(raw)) && hasEligibleSupplier(rule,pin) && provider.modelPinnedReasoningEfforts?.[raw]==='max' &&
      visible.some(entry=>entry.id===model && entry.efforts.includes('max'));
  }).map(({model})=>({model,effort:'max'}));
}
module.exports={routes,choices};
