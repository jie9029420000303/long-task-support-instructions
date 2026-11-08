// Rate-limit model fallback (Jay 2026-10-11): when the supervisor, the executor or one of its subagents is refused
// for quota, switch to the next model in Jay's order anthropic/ -> anthropic-apikey/ -> gpt-6.1-sol, and switch
// back when the limit resets. opencodex records every request in usage.jsonl with conversationId =
// sha256(Codex thread id)[:32], so a 429 maps to the exact thread (2026-10-11 05:04: this research chat on
// anthropic/claude-opus-5-5, "All Anthropic OAuth accounts are temporarily rate-limited").
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const pace=require('./pace.cjs');
const FALLBACK_MS=5*60*60*1000;
// The last stop moved from gpt-5.6-sol to the current GPT model (Jay 2026-10-29: 「限速後換模型換成你的推薦的那個 SOL」).
const LAST_RESORT='gpt-6.1-sol';
const home=()=>process.env.OPENCODEX_HOME||path.join(os.homedir(),'.opencodex');
const usageFile=()=>process.env.OPENCODEX_USAGE_FILE||path.join(home(),'usage.jsonl');
const quotaFile=()=>process.env.OPENCODEX_QUOTA_FILE||path.join(home(),'provider-account-quota-cache.json');
const hashId=id=>crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,32);
// The limit belongs to a provider path: anthropic/ and anthropic-apikey/ are separate accounts; other models stand alone.
function keyOf(model){const match=/^(anthropic(?:-apikey)?\/)/.exec(model||'');return match?match[1]:String(model||'');}
function chainFor(original,role){
  const name=/(claude-[^/]+)$/.exec(original||'')?.[1]||(role==='subagent'?'claude-sonnet-5-5':'claude-opus-5-5');
  return ['anthropic/'+name,'anthropic-apikey/'+name,LAST_RESORT];
}
function limited(state,model,now=Date.now()){const item=state.rateLimits?.[keyOf(model)];return Boolean(item&&item.until>now);}
function next(original,current,role,state,now=Date.now()){
  return chainFor(original,role).find(model=>model!==current&&!limited(state,model,now))||null;
}
// The refused turn's own error names the reset: "You've hit your usage limit. Try again at 11:40 PM.", or for a later day
// "Try again at Nov 10th, 2026 9:32 AM." (local time). WEB 2026-11-08 23:14: the error said 11:40 PM, the watcher assumed
// five hours, and after the reset a supervisor that worked again was moved to the paid API key until 04:14.
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const FALLBACK_BASIS='查不到額度重置時間，用 5 小時',ERROR_BASIS='錯誤訊息寫明的恢復時間',ROUTE_BASIS='同一路線之後已有成功請求';
function retryAt(text,since){
  const match=/try again at (?:([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})(?: ?([ap])\.?m\b)?/i.exec(String(text||''));
  if(!match)return null;
  let hour=Number(match[4]);const minute=Number(match[5]),half=match[6]?.toLowerCase();
  if(minute>59||(half?hour<1||hour>12:hour>23))return null;
  if(half)hour=hour%12+(half==='p'?12:0);
  if(match[1]){
    const month=MONTHS.indexOf(match[1].slice(0,3).toLowerCase());
    return month<0?null:new Date(Number(match[3]),month,Number(match[2]),hour,minute).getTime();
  }
  const day=new Date(since);let at=new Date(day.getFullYear(),day.getMonth(),day.getDate(),hour,minute).getTime();
  // A clock time earlier than the refusal belongs to the next day.
  if(at<since-60000)at+=24*60*60*1000;
  return at;
}
// The newest usage-limit error the thread's rollout recorded at or after the refusal. Only the platform's own turn
// error counts (task_complete or error events), never a tool output that happens to quote an older message.
function errorReset(file,since){
  let size;try{size=fs.statSync(file).size;}catch{return null;}
  const length=Math.min(size,8*1024*1024),buffer=Buffer.alloc(length);let fd;
  try{fd=fs.openSync(file,'r');fs.readSync(fd,buffer,0,length,size-length);}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
  let found=null;
  for(const line of buffer.toString('utf8').split('\n')){
    if(!line.includes('"event_msg"')||!/try again at/i.test(line))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    const payload=row.payload||{},at=Date.parse(row.timestamp);
    if(row.type!=='event_msg'||!(at>=since-120000))continue;
    const message=payload.type==='task_complete'?payload.error?.message:payload.type==='error'?payload.message:null;
    if(typeof message!=='string'||!/usage limit/i.test(message))continue;
    const until=retryAt(message,at);if(until)found={until,at};
  }
  return found;
}
// H1: the reset the refused turn's error names; else the recorded reset when opencodex has one; else five hours.
function resetFor(key,since,files=[]){
  const named=files.map(file=>errorReset(file,since)).filter(item=>item&&item.until>since).sort((a,b)=>a.until-b.until)[0];
  if(named)return {until:named.until,basis:ERROR_BASIS,fromError:true};
  if(key==='anthropic/'){
    try{
      const rows=Object.entries(JSON.parse(fs.readFileSync(quotaFile(),'utf8')).rows||{}).filter(([id])=>id.startsWith('anthropic\u0000')).map(([,row])=>row);
      const resets=rows.map(row=>Math.max(row.fiveHourPercent>=100?Number(row.fiveHourResetAt)||0:0,row.weeklyPercent>=100?Number(row.weeklyResetAt)||0:0));
      // Every account must be exhausted for "all accounts limited"; the first one to reset ends the limit.
      if(rows.length&&resets.every(at=>at>since))return {until:Math.min(...resets),basis:'opencodex 額度紀錄的最早重置時間'};
    }catch{}
  }
  return {until:since+FALLBACK_MS,basis:FALLBACK_BASIS};
}
// The error usually reaches the rollout a few seconds after opencodex logs the refusal: look again every 15 seconds for
// 15 minutes, and once per watcher start for older limits, then move every switch waiting on that limit to the named time.
const checkedThisStart=new Set();
function refine(state,now=Date.now()){
  let changed=false;
  for(const [key,item] of Object.entries(state.rateLimits||{})){
    if(item.fromError||item.until<=now||!item.files?.length)continue;
    const fresh=now-item.since<15*60000;
    if(fresh?item.checkedAt&&now-item.checkedAt<15000:checkedThisStart.has(key))continue;
    checkedThisStart.add(key);item.checkedAt=now;
    const reset=resetFor(key,item.since,item.files);
    if(!reset.fromError)continue;
    Object.assign(item,reset);changed=true;
    for(const record of Object.values(state.modelSwitch||{}))if(!record.restored&&keyOf(record.original)===key&&record.until>reset.until)record.until=reset.until;
  }
  return changed;
}
// A route that keeps serving requests after its last refusal works again, so the limit ends then rather than at a
// guessed time. 2026-11-08: gpt-6.1-sol was refused at 21:47 and had served about 1,000 requests by 01:32 while three
// records still waited for 02:47. It needs 10 quiet minutes after the route's latest refusal (any conversation) and a
// success since: when accounts are kept per conversation, another chat's success alone could otherwise restore a
// still-refused thread, get it refused again and switch it back and forth.
const ROUTE_QUIET_MS=10*60000;
function recovered(state,now=Date.now()){
  const back=key=>{const ok=state.routeOk?.[key],refused=state.routeRefused?.[key]||0;return ok>refused&&now-refused>=ROUTE_QUIET_MS?ok:null;};
  let changed=false;
  for(const [key,item] of Object.entries(state.rateLimits||{})){
    const at=back(key);
    if(at>item.since&&item.until>now){item.until=now;item.basis=ROUTE_BASIS;changed=true;}
  }
  for(const record of Object.values(state.modelSwitch||{})){
    const at=back(keyOf(record.original));
    if(!record.restored&&at>record.since&&record.until>now){record.until=now;changed=true;}
  }
  return changed;
}
function isLimit(row){return row.status===429||row.status===402||row.failureCause==='rate-limit'||['rate_limit_exceeded','insufficient_quota'].includes(row.errorCode);}
const hitOf=(owner,row)=>({...owner,model:row.requestedModel||row.model,at:Number(row.timestamp)||Date.now(),error:String(row.upstreamError||row.errorCode||row.status).slice(0,200)});
function readRange(file,from,to){
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(to-from);
  try{fs.readSync(fd,buffer,0,buffer.length,from);}finally{fs.closeSync(fd);}
  return buffer;
}
// New refusals since the last read. The first read looks back over the file's tail: a thread refused before the
// watcher (re)started still waits on that refusal (2026-10-11 22:09: A's supervisor was refused, the watcher restarted
// at 22:49 and read from the end, so the live limit was never handled). Every read counts only a thread whose latest
// request in what was read is still the refusal; a refusal followed by a success is history (WEB 2026-11-09 01:02: a
// watcher back after two hours read the 23:14 refusal from its saved offset and moved a working supervisor to the
// paid key). Successful requests of any conversation also record when each route last worked (routeOk).
function scan(state,threads){
  const file=usageFile();let size;
  try{size=fs.statSync(file).size;}catch{return [];}
  const owners=new Map(threads.map(item=>[hashId(item.threadId),item]));
  const first=state.usageOffset===undefined||size<state.usageOffset;
  let text;
  if(first){text=readRange(file,Math.max(0,size-32*1024*1024),size).toString('utf8');state.usageOffset=size;}
  else{
    if(size===state.usageOffset)return [];
    const buffer=readRange(file,state.usageOffset,state.usageOffset+Math.min(size-state.usageOffset,64*1024*1024));
    const complete=buffer.lastIndexOf(10);if(complete<0)return [];
    state.usageOffset+=complete+1;text=buffer.subarray(0,complete).toString('utf8');
  }
  const latest=new Map(),ok=state.routeOk||={},refused=state.routeRefused||={};
  for(const line of text.split('\n')){
    if(!line.includes('"conversationId"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row.model==='codex-auto-review')continue;
    const model=row.requestedModel||row.model,at=Number(row.timestamp)||0;
    if(model&&row.status>=200&&row.status<300&&!(ok[keyOf(model)]>=at))ok[keyOf(model)]=at;
    if(model&&isLimit(row)&&!(refused[keyOf(model)]>=at))refused[keyOf(model)]=at;
    if(owners.has(row.conversationId))latest.set(row.conversationId,row);
  }
  return [...latest].filter(([,row])=>isLimit(row)&&(!first||Date.now()-Number(row.timestamp)<FALLBACK_MS)).map(([id,row])=>hitOf(owners.get(id),row));
}
// The latest model and reasoning a thread runs with, from its own rollout.
function settingsOf(threadId){
  const file=pace.sessionFile(threadId);if(!file)return null;
  const size=fs.statSync(file).size,length=Math.min(size,4*1024*1024),buffer=Buffer.alloc(length),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,buffer,0,length,size-length);}finally{fs.closeSync(fd);}
  let found=null;
  for(const line of buffer.toString('utf8').split('\n')){
    if(!line.includes('"turn_context"'))continue;
    try{const row=JSON.parse(line);if(row.type==='turn_context')found={model:row.payload?.model||null,effort:row.payload?.effort||null,
      approvalPolicy:row.payload?.approval_policy||null,reviewer:row.payload?.approvals_reviewer||null,at:row.timestamp};}catch{}
  }
  return found;
}
function publish(run,state,now=Date.now()){
  const limits=Object.fromEntries(Object.entries(state.rateLimits||{}).filter(([,item])=>item.until>now)
    .map(([key,item])=>[key,{until:new Date(item.until).toISOString(),basis:item.basis,model:item.model}]));
  const body={chain:['anthropic/','anthropic-apikey/',LAST_RESORT],limits,
    rule:'派子代理前：模型的系列在 limits 且 until 未到，就依 chain 改用下一個同層級模型（Opus 換 Opus、Sonnet 換 Sonnet），全被限速才用 '+LAST_RESORT+'；until 過後回到原模型。',
    updatedAt:new Date(now).toISOString()};
  const file=path.join(run,'model-fallback.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(body,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return body;
}
module.exports={FALLBACK_MS,LAST_RESORT,hashId,keyOf,chainFor,limited,next,retryAt,errorReset,resetFor,refine,recovered,scan,settingsOf,publish};
