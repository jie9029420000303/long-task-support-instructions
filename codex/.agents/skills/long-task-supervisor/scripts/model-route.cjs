#!/usr/bin/env node
// Resolve only the roles needed now from the actual tool inventories. This does not
// change a running model, infer user authorization, or substitute another provider.
const fs=require('node:fs');
const roles={executor:{tier:'opus',effort:'high',catalog:'executor'},general:{tier:'sonnet',effort:'medium',catalog:'subagent'},ui:{tier:'sonnet',effort:'low',catalog:'subagent'}};
function identity(id){
  const match=typeof id==='string'&&id.match(/^(.*\/)?claude-([^/]+)$/i);
  if(!match)return null;
  return {provider:match[1]||'',name:match[2].toLowerCase()};
}
function resolve(input){
  if(typeof input.supervisorModel!=='string'||!input.supervisorModel.trim())throw Error('Provide the observed supervisor model ID');
  if(!Array.isArray(input.roles)||!input.roles.length||input.roles.some(role=>!roles[role]))throw Error('Request only the needed roles: executor, general, ui');
  const supervisor=identity(input.supervisorModel);
  if(!supervisor)return {family:'unchanged',reason:'監督不是 Claude；沿用既有 OpenAI 選模規則與已鎖定模型。',roles:{}};
  const result={family:'claude',supervisorModel:input.supervisorModel,provider:supervisor.provider,roles:{}};
  for(const role of input.roles){
    const policy=roles[role],catalog=input.catalogs?.[policy.catalog]||[],override=input.overrides?.[role];
    if(!Array.isArray(catalog)||catalog.some(item=>typeof item.id!=='string'||!Array.isArray(item.efforts)))throw Error('Catalog entries require observed id and supported efforts');
    const candidates=catalog.filter(item=>{
      if(override?.model)return item.id===override.model;
      const value=identity(item.id);
      return value&&value.provider===supervisor.provider&&value.name.startsWith(policy.tier+'-');
    }).sort((a,b)=>b.id.localeCompare(a.id,undefined,{numeric:true}));
    const model=(!override?.model&&role==='executor'&&candidates.find(item=>item.id===input.supervisorModel))||candidates[0];
    const effort=override?.effort||policy.effort;
    if(!model){
      result.roles[role]={status:'unavailable',reason:override?.model?`工具未提供指定模型 ${override.model}。`:`工具未提供與監督相同供應商路徑 ${supervisor.provider||'(無前綴)'} 的 Claude ${policy.tier}；不自動換帳號、GPT 或其他層級。`};continue;
    }
    if(!model.efforts.includes(effort)){
      result.roles[role]={status:'unavailable',model:model.id,reason:`工具未提供 ${model.id} 的 ${effort} 推理；保留該角色待處理，其他角色可繼續。`};continue;
    }
    result.roles[role]={status:'ready',model:model.id,effort,basis:override?'explicit-user-override':'claude-role-policy'};
  }
  return result;
}
module.exports={resolve};
if(require.main===module){
  try{console.log(JSON.stringify(resolve(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
