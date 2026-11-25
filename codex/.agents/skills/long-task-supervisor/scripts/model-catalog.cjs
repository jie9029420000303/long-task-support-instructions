// Select from the observed tool inventory. A model's version orders releases within its own tier.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const tiers={gpt:['terra','sol','astra'],claude:['sonnet','opus','fable']};
const efforts=['low','medium','high','xhigh','max','ultra'];
function identity(id) {
  const claude=/^(?:(anthropic(?:-apikey)?)\/)?claude-(haiku|sonnet|opus|fable)(?:-([\d-]+))?$/i.exec(id||'');
  if(claude)return {family:'claude',provider:claude[1]?claude[1]+'/':'',tier:claude[2].toLowerCase(),version:claude[3]||''};
  // A bare GPT ID runs on the OpenAI subscription; openai-apikey/ is the paid API key (Jay 2026-11-25).
  const gpt=/^(?:(openai-apikey)\/)?gpt-([\d.]+)-(terra|sol|astra|luna)$/i.exec(id||'');
  return gpt?{family:'gpt',provider:gpt[1]?gpt[1]+'/':'',tier:gpt[3].toLowerCase(),version:gpt[2]}:null;
}
function available(items) {
  return items.filter(x=>x && (!x.visibility || x.visibility==='list') && !x.hidden).map(x=>({
    id:x.id||x.slug, efforts:x.efforts||x.supported_reasoning_levels?.map(e=>e.effort)||[]
  }));
}
function latest(items,family,provider,tier) {
  return available(items).filter(x=>{const m=identity(x.id);return m && m.family===family && m.provider===provider && m.tier===tier;})
    .sort((a,b)=>identity(b.id).version.localeCompare(identity(a.id).version,'en',{numeric:true}))[0];
}
function installed() {
  const dir=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const files=process.env.OPENCODEX_MODEL_CATALOG?[process.env.OPENCODEX_MODEL_CATALOG]:['opencodex-catalog.json','models_cache.json'].map(name=>path.join(dir,name));
  for(const file of files){
    try{return JSON.parse(fs.readFileSync(file,'utf8')).models||[];}
    catch(error){if(error.code!=='ENOENT')return [];}
  }
  return [];
}
module.exports={tiers,efforts,identity,available,latest,installed};
