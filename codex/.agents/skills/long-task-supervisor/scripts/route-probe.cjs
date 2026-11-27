// Before the watcher switches a chat to a model it sends one small request for that model through OpenCodex and only
// switches when the request completes (Jay 2026-11-27 decision 44:「背景程序偵測到有條件改變，要做模型替換，能不能先
// 自己打API測試，會通的再一次替換」). 2026-11-27 13:54～14:16 both supervisors were switched to the OpenAI API Sol,
// whose balance was used up, and fell to DeepSeek only after their own turns were refused there; the 15:46 test told
// the same answer in 2.6 seconds (HTTP 200 stream, response.failed, credit_balance_exhausted). One answer per model is
// kept for a minute in a file every run on this Mac reads, so three runs switching at once send one request.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const PROBE_TTL_MS=60000,PROBE_TIMEOUT_MS=45000;
const home=()=>process.env.OPENCODEX_HOME||path.join(os.homedir(),'.opencodex');
function endpoint(){
  if(process.env.LONG_TASK_PROBE_URL)return process.env.LONG_TASK_PROBE_URL;
  let port=10100;try{port=JSON.parse(fs.readFileSync(path.join(home(),'config.json'),'utf8')).port||port;}catch{}
  return 'http://127.0.0.1:'+port+'/v1/responses';
}
function cacheFile(run){return require('./model-fallback.cjs').sharedFile(run,'route-probe.json');}
function readCache(run){try{return JSON.parse(fs.readFileSync(cacheFile(run),'utf8'));}catch{return {};}}
function writeCache(run,model,result,now){
  const all=readCache(run),file=cacheFile(run);
  for(const [key,item] of Object.entries(all))if(now-item.at>=PROBE_TTL_MS)delete all[key];
  all[model]=result;
  try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(all)+'\n');fs.renameSync(temp,file);}catch{}
}
// The provider's own error, from a JSON body or from the stream's error event.
function errorOf(text){
  for(const line of String(text||'').split('\n')){
    const json=line.startsWith('data:')?line.slice(5).trim():line.trim();
    if(!json.startsWith('{'))continue;
    let row;try{row=JSON.parse(json);}catch{continue;}
    const error=row.error||row.response?.error||(typeof row.detail==='string'?{message:row.detail}:null);
    if(error)return {code:error.code||error.type||null,message:String(error.message||'').slice(0,200)};
  }
  return null;
}
async function request(model){
  const body={model,instructions:'Reply with OK only.',input:[{role:'user',content:[{type:'input_text',text:'Reply with OK only.'}]}],stream:true,store:false};
  try{
    const response=await fetch(endpoint(),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(PROBE_TIMEOUT_MS)});
    const text=await response.text();
    const ok=response.status===200&&text.includes('"type":"response.completed"');
    return {ok,status:response.status,...(ok?{}:errorOf(text)||{code:null,message:text.slice(0,200)})};
  }catch(error){return {ok:false,status:null,code:error.name==='TimeoutError'?'timeout':'unreachable',message:String(error.message||error).slice(0,200)};}
}
// A run under the system temp directory is a test: it never asks the real OpenCodex unless a probe URL is named.
async function probe(model,run,now=Date.now()){
  if(!process.env.LONG_TASK_PROBE_URL&&run&&require('./claude-quota.cjs').temporary(run))return {model,ok:true,at:now,skipped:true};
  const known=readCache(run)[model];
  if(known&&now-known.at<PROBE_TTL_MS)return known;
  const result={model,...await request(model),at:now};
  writeCache(run,model,result,now);
  return result;
}
// A model whose probe failed within the last minute, for any run on this Mac.
function failedRecently(model,run,now=Date.now()){
  const known=readCache(run)[model];
  return Boolean(known&&!known.ok&&now-known.at<PROBE_TTL_MS);
}
module.exports={PROBE_TTL_MS,PROBE_TIMEOUT_MS,endpoint,errorOf,probe,failedRecently};
