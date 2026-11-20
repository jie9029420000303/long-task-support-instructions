// These are the two operator-approved upstreams; model names alone do not pin a supplier.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const catalog=require('./model-catalog.cjs');
const choices=[
  {raw:'deepseek/deepseek-v4.1-flash-1017',provider:'ambient/fp4'},
  {raw:'meta/muse-ember',provider:'google-vertex/global'}
].map(x=>({...x,model:'openrouter/'+x.raw.replace('/','-')}));
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
    return !config.disabledModels?.includes(model) && (!provider.enforceSelectedModels || provider.selectedModels?.includes(raw)) && rule?.allowFallbacks===false && rule.only?.length===1 && rule.only[0]===pin && provider.modelPinnedReasoningEfforts?.[raw]==='max' &&
      visible.some(entry=>entry.id===model && entry.efforts.includes('max'));
  }).map(({model})=>({model,effort:'max'}));
}
module.exports={routes,choices};
