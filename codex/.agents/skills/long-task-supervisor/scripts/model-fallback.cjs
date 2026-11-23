// Rate-limit model fallback (Jay 2026-10-11, revised 2026-11-21): the supervisor goes Claude subscription Opus ->
// Claude API Opus (monthly; skipped once known used up) -> latest Sol -> Muse -> DeepSeek and moves only when it is
// refused itself. The executor goes subscription Sonnet -> Sol (Terra workers) -> Muse -> DeepSeek and never uses the
// API key. Workers stay with their current parent. Switch back when the limit resets. opencodex records every request in usage.jsonl with conversationId =
// sha256(Codex thread id)[:32], so a 429 maps to the exact thread (2026-10-11 05:04: this research chat on
// anthropic/claude-opus-5-5, "All Anthropic OAuth accounts are temporarily rate-limited").
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const pace=require('./pace.cjs');
const FALLBACK_MS=5*60*60*1000;
// A route that keeps failing for another reason (HTTP 400 payload rejected, 5xx) or never answers after a switch is
// left for 30 minutes; an open-source rate limit is short-lived and is retried after 15 minutes (2026-11-21 review).
const FAILURE_COUNT=3,FAILURE_SPAN_MS=60000,FAILURE_COOLDOWN_MS=30*60000,OPENROUTER_COOLDOWN_MS=15*60000;
const FAILURE_BASIS='連續失敗（非額度），暫停此順位 30 分鐘',OPENROUTER_BASIS='開源順位短暫限速，15 分鐘後再試',SILENT_BASIS='切換後沒有成功回應，暫停此順位 30 分鐘';
const catalog=require('./model-catalog.cjs');
const lastResort=()=>catalog.latest(catalog.installed(),'gpt','','sol')?.id;
const home=()=>process.env.OPENCODEX_HOME||path.join(os.homedir(),'.opencodex');
const usageFile=()=>process.env.OPENCODEX_USAGE_FILE||path.join(home(),'usage.jsonl');
const quotaFile=()=>process.env.OPENCODEX_QUOTA_FILE||path.join(home(),'provider-account-quota-cache.json');
const hashId=id=>crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,32);
// The limit belongs to a provider path: anthropic/ and anthropic-apikey/ are separate accounts; other models stand alone.
function keyOf(model){const match=/^(anthropic(?:-apikey)?\/)/.exec(model||'');return match?match[1]:String(model||'');}
// Refusals are kept per side (Jay 2026-11-21): the supervisor leaves a route only when it is refused itself, and an
// executor refusal never moves the supervisor. Subagents belong to the executor's side.
const sideOf=role=>role==='supervisor'?'supervisor':'executor';
function limitKey(role,model){return sideOf(role)+'|'+keyOf(model);}
function plainKey(key){const at=key.indexOf('|');return at<0?key:key.slice(at+1);}
// OpenRouter credit (HTTP 402) ends every open-source route for both sides.
const OPENROUTER_ACCOUNT='openrouter/';
function subscriptionClaude(model){const m=catalog.identity(model);return m?.family==='claude'&&m.provider==='anthropic/';}
// Limits saved before 2026-11-21 had one record per route for every role; keep each for both sides until it ends.
function migrateLimits(state){
  let changed=false;
  for(const [key,item] of Object.entries(state.rateLimits||{})){
    if(key.includes('|')||key===OPENROUTER_ACCOUNT)continue;
    for(const side of ['supervisor','executor'])state.rateLimits[side+'|'+key]||={...item};
    delete state.rateLimits[key];changed=true;
  }
  return changed;
}
// The Claude API key has a monthly cap shared by every run on this Mac: once one run learns it is used up, every run
// skips it until the named reset. A test run under the temp directory keeps it to itself.
function apiMonthFile(run){
  if(!process.env.LONG_TASK_HOME&&run&&require('./claude-quota.cjs').temporary(run))return path.join(run,'anthropic-api-month.json');
  return path.join(require('./notify.cjs').home(),'anthropic-api-month.json');
}
function syncApiMonth(state,run,now=Date.now()){
  let shared=null;try{shared=JSON.parse(fs.readFileSync(apiMonthFile(run),'utf8'));}catch{}
  const best=[state.apiMonth,shared].filter(item=>item&&item.until>now).sort((a,b)=>b.until-a.until)[0]||null;
  const changed=(state.apiMonth?.until||null)!==(best?.until||null);
  if(best)state.apiMonth=best;else delete state.apiMonth;
  return changed;
}
function recordApiMonth(state,run,until,basis,now=Date.now()){
  if(!(until>now)||state.apiMonth?.until>=until)return;
  state.apiMonth={until,basis,at:now};
  const file=apiMonthFile(run);
  try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state.apiMonth)+'\n');fs.renameSync(temp,file);}catch{}
}
// Legacy bindings used false both for manual selection and for an explicit lock.
// Preserve their restriction until the owner authorizes migrating that run.
function modelPolicy(binding){
  const policy=binding.modelPolicy ?? (binding.modelFallback===false?'locked':'automatic');
  if(!['locked','automatic'].includes(policy))throw Error('Unknown modelPolicy: '+policy);
  return policy;
}
function finalReviewer(model){
  return ['sol','astra','opus','fable'].includes(catalog.identity(model)?.tier);
}
function chainFor(original,role,executorModel=original){
  const items=catalog.installed(), originalModel=catalog.identity(original), owner=catalog.identity(executorModel);
  if(role==='subagent'){
    if(!owner)return require('./openrouter-route.cjs').routes().filter(r=>r.model===executorModel).map(r=>r.model);
    const sameFamily=originalModel?.family===owner.family;
    const tier=sameFamily?originalModel.tier:(owner.family==='claude'?'sonnet':'terra');
    // Workers never use the Claude API key: it is the supervisor's reserve.
    return [catalog.latest(items,owner.family,owner.family==='gpt'?'':'anthropic/',tier)?.id].filter(Boolean);
  }
  const tier=originalModel?.family==='claude'?originalModel.tier:(role==='supervisor'?'opus':'sonnet');
  const accounts=role==='supervisor'?['anthropic/','anthropic-apikey/']:['anthropic/'];
  const claude=accounts.map(provider=>catalog.latest(items,'claude',provider,tier)?.id).filter(Boolean);
  const sol=catalog.latest(items,'gpt','','sol')?.id;
  return sol?[...claude,sol]:claude;
}
// After Sol the supervisor always tries Muse then DeepSeek (Jay 2026-11-22); the executor follows the run's preferred order.
function openRoutes(role,preference=null){
  return require('./openrouter-route.cjs').routes(role==='supervisor'?null:preference);
}
function limited(state,model,now=Date.now(),role='executor'){
  if(state.rateLimits?.[limitKey(role,model)]?.until>now)return true;
  if(String(model||'').startsWith('openrouter/')&&state.rateLimits?.[OPENROUTER_ACCOUNT]?.until>now)return true;
  return keyOf(model)==='anthropic-apikey/'&&state.apiMonth?.until>now;
}
function availableFourth(config){
  const routes=require('./openrouter-route.cjs').routes(config);
  return config?routes.find(r=>r.model===config.model && r.effort===config.effort)||null:routes[0]||null;
}
function next(original,current,role,state,now=Date.now(),executorModel=original,fourth=null){
  const candidates=chainFor(original,role,executorModel);
  if(role!=='subagent')candidates.push(...openRoutes(role,fourth).map(r=>r.model));
  return candidates.find(model=>model!==current&&!limited(state,model,now,role))||null;
}
// The refused turn's own error names the reset: "You've hit your usage limit. Try again at 11:40 PM.", or for a later day
// "Try again at Nov 10th, 2026 9:32 AM." (local time). WEB 2026-11-08 23:14: the error said 11:40 PM, the watcher assumed
// five hours, and after the reset a supervisor that worked again was moved to the paid API key until 04:14.
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const FALLBACK_BASIS='查不到額度重置時間，用 5 小時',ERROR_BASIS='錯誤訊息寫明的恢復時間',ROUTE_BASIS='同一路線之後已有成功請求';
function retryAt(text,since){
  const utc=/\bregain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})(?::(\d{2}))? UTC\b/i.exec(text);
  if(utc)return Date.parse(utc[1]+'T'+utc[2]+':'+(utc[3]||'00')+'Z')||null;
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
    const reset=resetFor(plainKey(key),item.since,item.files);
    if(!reset.fromError)continue;
    Object.assign(item,reset);changed=true;
    for(const record of Object.values(state.modelSwitch||{}))if(!record.restored&&limitKey(record.role,record.original)===key&&record.until>reset.until)record.until=reset.until;
  }
  return changed;
}
// A route that keeps serving requests after its last refusal works again, so the limit ends then rather than at a
// guessed time. 2026-11-08: gpt-6.1-sol was refused at 21:47 and had served about 1,000 requests by 01:32 while three
// records still waited for 02:47. It needs 10 quiet minutes after the route's latest refusal (any conversation) and a
// success since: when accounts are kept per conversation, another chat's success alone could otherwise restore a
// still-refused thread, get it refused again and switch it back and forth.
// The executor's Claude subscription is the exception (Jay 2026-11-21): it returns only on the quota reading and the
// named reset, never on another conversation's success, because the supervisor shares those accounts.
const ROUTE_QUIET_MS=10*60000;
function recovered(state,now=Date.now()){
  const back=key=>{const ok=state.routeOk?.[key],refused=state.routeRefused?.[key]||0;return ok>refused&&now-refused>=ROUTE_QUIET_MS?ok:null;};
  const quotaOnly=key=>key==='executor|anthropic/';
  let changed=false;
  for(const [key,item] of Object.entries(state.rateLimits||{})){
    if(quotaOnly(key)||item.basis===FAILURE_BASIS||item.basis===SILENT_BASIS)continue;
    const at=back(plainKey(key));
    if(at>item.since&&item.until>now){item.until=now;item.basis=ROUTE_BASIS;changed=true;}
  }
  for(const record of Object.values(state.modelSwitch||{})){
    const key=limitKey(record.role,record.original);
    if(quotaOnly(key))continue;
    const at=back(keyOf(record.original));
    if(!record.restored&&at>record.since&&record.until>now){record.until=now;changed=true;}
  }
  return changed;
}
function isLimit(row){return row.status===429||row.status===402||row.failureCause==='rate-limit'||['rate_limit_exceeded','insufficient_quota'].includes(row.errorCode);}
// Any other refusal that a retry of the same route will not fix. A cancelled request (499) is not a failure; an API-key
// HTTP 400 goes through the monthly-cap check instead.
function isFailure(row){
  if(isLimit(row)||!(row.status>=400)||row.status===499)return false;
  return !(row.status===400&&keyOf(row.requestedModel||row.model)==='anthropic-apikey/');
}
// Anthropic's API spending cap is logged by OpenCodex as an ordinary HTTP 400.
// Only the provider message from the refused turn distinguishes it from malformed input.
function quotaMessage(raw){
  let message=raw;
  while(typeof message==='string'){
    if(/^(?:You have reached your specified API usage limits?\b|Your credit balance is too low to access the Anthropic API\b)/i.test(message))return message;
    const json=message.replace(/^Provider error 400:\s*/i,'').trim();
    if(!json.startsWith('{'))break;
    try{message=JSON.parse(json)?.error?.message;}catch{break;}
  }
  return null;
}
function checkQuotaTurn(check,owner){
  const file=owner.file||pace.sessionFile(owner.threadId);
  if(!file)return;
  let stat;try{stat=fs.statSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(check.file===file&&check.size===stat.size)return;
  check.file=file;check.size=stat.size;
  const tail=readRange(file,Math.max(0,stat.size-8*1024*1024),stat.size).toString('utf8');
  let context=null;
  for(const line of tail.split('\n')){
    if(!line.includes('"turn_context"')&&!line.includes('"task_complete"')&&!line.includes('"task_started"')&&!line.includes('"turn_aborted"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    const p=row.payload||{}, at=Date.parse(row.timestamp);
    if(row.type==='turn_context'){context={model:p.model,id:p.turn_id,at};continue;}
    if(row.type!=='event_msg')continue;
    if(p.type==='task_started'){context=null;continue;}
    if(p.type!=='task_complete'&&p.type!=='turn_aborted')continue;
    if(context?.model===check.model&&context.at<=check.at&&at>=check.at&&(!p.turn_id||!context.id||p.turn_id===context.id)){
      return {message:quotaMessage(p.error?.message)};
    }
    context=null;
  }
}
const hitOf=(owner,row)=>({...owner,model:row.requestedModel||row.model,at:Number(row.timestamp)||Date.now(),status:row.status,error:String(row.upstreamError||row.errorCode||row.status).slice(0,200)});
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
  let text='';
  if(first){text=readRange(file,Math.max(0,size-32*1024*1024),size).toString('utf8');state.usageOffset=size;}
  else if(size>state.usageOffset){
    const buffer=readRange(file,state.usageOffset,state.usageOffset+Math.min(size-state.usageOffset,64*1024*1024));
    const complete=buffer.lastIndexOf(10);if(complete<0)return [];
    state.usageOffset+=complete+1;text=buffer.subarray(0,complete).toString('utf8');
  }
  const latest=new Map(),ok=state.routeOk||={},refused=state.routeRefused||={},failures=state.routeFailures||={};
  for(const line of text.split('\n')){
    if(!line.includes('"conversationId"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row.model==='codex-auto-review')continue;
    const model=row.requestedModel||row.model,at=Number(row.timestamp)||0;
    if(model&&row.status>=200&&row.status<300&&!(ok[keyOf(model)]>=at))ok[keyOf(model)]=at;
    if(model&&isLimit(row)&&!(refused[keyOf(model)]>=at))refused[keyOf(model)]=at;
    if(owners.has(row.conversationId)){
      latest.set(row.conversationId,row);
      const owner=owners.get(row.conversationId),switched=state.modelSwitch?.[owner.threadId];
      if(switched&&!switched.respondedAt&&model===switched.current&&at>=switched.since&&row.status>=200&&row.status<300&&row.usage?.outputTokens>0)switched.respondedAt=at;
      // Consecutive non-quota failures of one mainline on one model; any success of that thread clears them.
      if(owner.role!=='subagent'){
        if(row.status>=200&&row.status<300)delete failures[owner.threadId];
        else if(isFailure(row)){
          const known=failures[owner.threadId];
          failures[owner.threadId]=known&&known.model===model?{...known,count:known.count+1,lastAt:at,status:row.status}:{model,count:1,firstAt:at,lastAt:at,status:row.status};
        }
      }
    }
  }
  const checks=state.pendingQuotaChecks||={},hits=[];
  for(const [threadId,item] of Object.entries(failures)){
    const owner=threads.find(entry=>entry.threadId===threadId);
    if(!owner||Date.now()-item.lastAt>=FAILURE_COOLDOWN_MS){delete failures[threadId];continue;}
    if(item.count<FAILURE_COUNT||item.lastAt-item.firstAt<FAILURE_SPAN_MS)continue;
    hits.push({...owner,model:item.model,at:item.lastAt,status:item.status,failure:true,error:'連續 '+item.count+' 次非額度錯誤（HTTP '+item.status+'）'});
    delete failures[threadId];
  }
  if(!Object.keys(failures).length)delete state.routeFailures;
  for(const [id,row] of latest){
    delete checks[id];
    if(first&&Date.now()-Number(row.timestamp)>=FALLBACK_MS)continue;
    const owner=owners.get(id);
    if(isLimit(row))hits.push(hitOf(owner,row));
    else if(row.status===400&&keyOf(row.requestedModel||row.model)==='anthropic-apikey/'){
      checks[id]={model:row.requestedModel||row.model,at:Number(row.timestamp)};
    }
  }
  // The terminal error may arrive after the usage row. Check it even on a poll with no new requests.
  for(const [id,check] of Object.entries(checks)){
    const owner=owners.get(id);
    if(!owner||!Number.isFinite(check.at)||Date.now()-check.at>=FALLBACK_MS){delete checks[id];continue;}
    const result=checkQuotaTurn(check,owner);
    if(!result)continue;
    delete checks[id];
    if(!result.message)continue;
    const key=keyOf(check.model),until=retryAt(result.message,check.at);
    refused[key]=Math.max(refused[key]||0,check.at);
    hits.push({...owner,model:check.model,at:check.at,error:result.message.slice(0,200),
      quotaReset:until?{until,basis:ERROR_BASIS,fromError:true}:{until:check.at+FALLBACK_MS,basis:FALLBACK_BASIS}});
  }
  if(Object.keys(checks).length)state.pendingQuotaChecks=checks;
  else delete state.pendingQuotaChecks;
  return hits;
}
// The latest model and reasoning a thread runs with, from its own rollout.
function settingsOf(threadId){
  const file=pace.sessionFile(threadId);if(!file)return null;
  // A long tool result can put the last context more than one block from EOF.
  const fd=fs.openSync(file,'r');
  try{
    let end=fs.fstatSync(fd).size, suffix=Buffer.alloc(0);
    while(end>0){
      const start=Math.max(0,end-1024*1024), chunk=Buffer.alloc(end-start);
      fs.readSync(fd,chunk,0,chunk.length,start);
      const data=Buffer.concat([chunk,suffix]), boundary=start?data.indexOf(10):-1;
      // Only a turn_context line can supply settings. Keep the leading fragment
      // across reads; oversized tool output is never needed as a full JSON value.
      if(start && boundary<0){suffix=data.subarray(0,Math.min(data.length,1024*1024));end=start;continue;}
      const lines=data.subarray(boundary+1).toString('utf8').split('\n');
      for(let i=lines.length-1;i>=0;i--){
        if(!lines[i].includes('"turn_context"'))continue;
        try{const row=JSON.parse(lines[i]),p=row.payload;
          if(row.type==='turn_context')return {turnId:p.turn_id,model:p.model||null,effort:p.effort||null,approvalPolicy:p.approval_policy||null,
            reviewer:p.approvals_reviewer||null,sandbox:p.sandbox_policy?.type||null,at:row.timestamp};
        }catch{}
      }
      suffix=data.subarray(0,Math.max(0,boundary));end=start;
    }
    return null;
  }finally{fs.closeSync(fd);}
}
// Full access is approval never plus the full-access sandbox; null while nothing is read yet. Jay 2026-11-09 keeps the
// platform on full access, so the supervisor asks him once at the start when the executor runs under anything else.
function fullAccess(settings){
  if(!settings?.approvalPolicy)return null;
  return settings.approvalPolicy==='never'&&(!settings.sandbox||settings.sandbox==='danger-full-access');
}
function publish(run,state,now=Date.now(),fourth=null){
  const live=Object.entries(state.rateLimits||{}).filter(([,item])=>item.until>now);
  const entry=item=>({until:new Date(item.until).toISOString(),basis:item.basis,model:item.model});
  // model-route reads limits by route for the executor's workers; the supervisor's own limits are listed apart.
  const limits=Object.fromEntries(live.filter(([key])=>!key.startsWith('supervisor|')).map(([key,item])=>[plainKey(key),entry(item)]));
  const supervisorLimits=Object.fromEntries(live.filter(([key])=>key.startsWith('supervisor|')).map(([key,item])=>[plainKey(key),entry(item)]));
  const sol=lastResort(),open=role=>openRoutes(role,fourth).map(r=>r.model);
  const quota=state.claudeQuota;
  const body={chain:{supervisor:['anthropic/','anthropic-apikey/',...(sol?[sol]:[]),...open('supervisor')],executor:['anthropic/',...(sol?[sol]:[]),...open('executor')]},
    limits,supervisorLimits,...(state.apiMonth?{apiMonth:{until:new Date(state.apiMonth.until).toISOString(),basis:state.apiMonth.basis}}:{}),
    ...(quota?{claudeQuota:{executorMayUseClaude:quota.allowed===true,weeklyRemaining:quota.weeklyRemaining,reserve:quota.reserve,hold:quota.hold||null,
      summary:require('./claude-quota.cjs').describe(quota),readAt:new Date(quota.at).toISOString()}}:{}),
    ...(open('executor').length?{}:{openSourceWarning:'開源備援目前沒有可用模型（OpenCodex 設定或價格上限未通過）'}),
    ...(fourth?{fourthExecutorModel:fourth}:{}),
    rule:'監督只在自己被拒時依 chain.supervisor 往下換；執行端依 chain.executor，Claude 週剩餘加權低於保留值或 5 小時額度將滿時改用 Sol。子代理只在執行主線同一家選可用模型，不用 Claude API。',
    updatedAt:new Date(now).toISOString()};
  const file=path.join(run,'model-fallback.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(body,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return body;
}
module.exports={FALLBACK_MS,FAILURE_COOLDOWN_MS,OPENROUTER_COOLDOWN_MS,FAILURE_BASIS,OPENROUTER_BASIS,SILENT_BASIS,OPENROUTER_ACCOUNT,
  modelPolicy,finalReviewer,lastResort,hashId,keyOf,sideOf,limitKey,plainKey,subscriptionClaude,migrateLimits,syncApiMonth,recordApiMonth,
  chainFor,openRoutes,limited,next,availableFourth,retryAt,errorReset,resetFor,refine,recovered,isFailure,scan,settingsOf,fullAccess,publish};
