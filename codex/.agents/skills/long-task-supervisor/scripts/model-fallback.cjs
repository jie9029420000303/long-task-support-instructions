// Model orders (Jay 2026-10-11, revised 2026-11-21, 2026-11-25 and 2026-11-26 decisions 19-21): the supervisor and the
// executor share one order, Claude subscription Opus -> Claude API Opus (monthly; skipped once known used up) ->
// subscription Sol -> OpenAI API Sol -> subscription Terra -> OpenAI API Terra -> DeepSeek -> Muse. Subagents go
// subscription Sonnet -> Claude API Sonnet -> subscription Terra -> OpenAI API Terra -> DeepSeek -> Muse, whatever the
// mainline runs. A role moves down when it is refused itself or when the quota ladder (claude-quota.cjs) keeps it from
// the front stops, and comes back when the limit resets or the ladder rises. opencodex records every request in usage.jsonl with conversationId =
// sha256(Codex thread id)[:32], so a 429 maps to the exact thread (2026-10-11 05:04: this research chat on
// anthropic/claude-opus-5-5, "All Anthropic OAuth accounts are temporarily rate-limited").
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const pace=require('./pace.cjs');
const FALLBACK_MS=5*60*60*1000;
// A route that keeps failing for another reason (HTTP 400 payload rejected, 5xx) or never answers after a switch is
// left for 30 minutes; an open-source rate limit is short-lived and is retried after 15 minutes (2026-11-21 review).
const FAILURE_COUNT=3,FAILURE_SPAN_MS=60000,FAILURE_COOLDOWN_MS=30*60000,OPENROUTER_COOLDOWN_MS=15*60000;
const FAILURE_BASIS='連續失敗（非額度），暫停此順位 30 分鐘',OPENROUTER_BASIS='開源順位短暫限速，15 分鐘後再試',SILENT_BASIS='切換後沒有成功回應，暫停此順位 30 分鐘';
const UNSUPPORTED_BASIS='目前的帳號不支援這個模型，5 小時後再試';
const BILLING_BASIS='API 儲值用完，這台電腦所有工區 5 小時後再試';
const catalog=require('./model-catalog.cjs');
// The OpenAI subscription first, then the OpenAI API key (Jay 2026-11-25「兩邊都排，順位接在openai月訂閱戶後面」).
const GPT_ACCOUNTS=['','openai-apikey/'];
const solRoutes=(items=catalog.installed())=>GPT_ACCOUNTS.map(provider=>catalog.latest(items,'gpt',provider,'sol')?.id).filter(Boolean);
// The stops of each order, front first. A mainline's Claude stops keep the tier it was started on (Opus unless Jay
// chose another); its GPT stops are Sol then Terra. Open-source stops follow openrouter-route.cjs.
const MAINLINE_STOPS=['claude|anthropic/','claude|anthropic-apikey/','sol|','sol|openai-apikey/','terra|','terra|openai-apikey/'];
const SUBAGENT_STOPS=['claude|anthropic/','claude|anthropic-apikey/','terra|','terra|openai-apikey/'];
const stopsOf=role=>role==='subagent'?SUBAGENT_STOPS:MAINLINE_STOPS;
// Where a model stands on a role's order: its stop index, or null when it is not on it.
function stopIndex(model,role){
  const m=catalog.identity(model),stops=stopsOf(role);
  if(m){const at=stops.indexOf((m.family==='claude'?'claude':m.tier)+'|'+m.provider);return at<0?null:at;}
  const open=require('./openrouter-route.cjs').choices.findIndex(route=>route.model===model);
  return open<0?null:stops.length+open;
}
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
function subscriptionOpenAI(model){const m=catalog.identity(model);return m?.family==='gpt'&&m.provider==='';}
// OpenCodex marks an API key whose prepaid balance is used up as billing_exhausted (2026-11-27: openai-apikey answered
// HTTP 429 with it 49 times). Every model on that key is out for every role of every run on this Mac, and the key is
// tried again after five hours (Jay 2026-11-27 decision 36:「全區共用可以，但不要等我儲值…還是五小時重試」).
function billingAccount(model){return /^([a-z0-9-]+-apikey\/)/.exec(model||'')?.[1]||null;}
// A mainline on the ChatGPT subscription can hand work only to a ChatGPT subscription worker: the platform encrypts the
// task for the native backend and any other provider refuses it (2026-11-27 13:58～14:02 工區 E and 清票, and the 14:42
// test: unreadable_encrypted_agent_task). Its workers use the subscription Terra whatever the subagent ladder says; once
// that Terra cannot serve, the mainline itself moves on (Jay 2026-11-27 decision 37).
function subscriptionWorker(items=catalog.installed()){return catalog.latest(items,'gpt','','terra')?.id||null;}
function cannotDispatch(state,model,role,now=Date.now()){
  if(role!=='executor'||!subscriptionOpenAI(model))return false;
  const worker=subscriptionWorker();
  return Boolean(worker)&&refused(state,worker,now,'subagent');
}
// A route the quota reading holds back, for as long as the reading says so: the OpenAI subscription for every role once
// each account Jay has not paused is at its line or its last 2% (Jay 2026-11-25, 2026-11-26 decision 26), and every
// stop in front of the role's ladder floor. A success of another conversation never ends either.
function held(state,model,role,now=Date.now()){
  // Before the first reading nothing is held here; the watcher reads the quota before it routes.
  if(!state.claudeQuota)return false;
  if(subscriptionOpenAI(model)&&require('./claude-quota.cjs').openaiHeld(state))return true;
  const at=stopIndex(model,role);
  return at!==null&&at<floorIndex(state,role,now);
}
// The ladder floor of a role, but never past its last stop that can still serve: the bottom of the order stays usable.
function floorIndex(state,role,now=Date.now()){
  const floor=require('./claude-quota.cjs').floorOf(state.claudeQuota,role);
  if(!floor)return 0;
  const items=catalog.installed(),open=require('./openrouter-route.cjs').routes(null,items).map(route=>route.model);
  const serving=[...stopsOf(role).map((stop,at)=>{
    const [kind,provider]=stop.split('|'),family=kind==='claude'?'claude':'gpt',tier=kind==='claude'?(role==='subagent'?'sonnet':'opus'):kind;
    const id=catalog.latest(items,family,provider,tier)?.id;
    return id&&!refused(state,id,now,role)&&!(subscriptionOpenAI(id)&&require('./claude-quota.cjs').openaiHeld(state))?at:null;
  }),...open.map(model=>!refused(state,model,now,role)?stopIndex(model,role):null)].filter(at=>at!==null);
  return Math.min(floor,serving.length?Math.max(...serving):floor);
}
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
// What one run learns about an account holds for every run on this Mac: the Claude API key's monthly cap, and a model
// an account cannot run. A test run under the temp directory keeps it to itself.
function sharedFile(run,name){
  if(!process.env.LONG_TASK_HOME&&run&&require('./claude-quota.cjs').temporary(run))return path.join(run,name);
  return path.join(require('./notify.cjs').home(),name);
}
const apiMonthFile=run=>sharedFile(run,'anthropic-api-month.json');
// Two runs can share one supervisor chat (工區 D and 清票 share 01a1da3b). Only one watcher moves its model: the run that
// holds the supervisor's entry, refreshed on every pass and taken over once it is ten minutes old (Jay 2026-11-27
// decision 39). Entries of supervisors no watcher has touched for a day are dropped.
const SUPERVISOR_LEASE_MS=10*60000;
function supervisorOwner(run,supervisorId,now=Date.now()){
  const file=sharedFile(run,'supervisor-route-owner.json');
  let all={};try{all=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const owner=all[supervisorId];
  if(owner&&owner.run!==run&&now-owner.at<SUPERVISOR_LEASE_MS)return false;
  for(const [id,item] of Object.entries(all))if(now-item.at>=24*60*60*1000)delete all[id];
  all[supervisorId]={run,at:now};
  try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(all)+'\n');fs.renameSync(temp,file);}catch{}
  return true;
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
// A model the serving account cannot run (model_unavailable) is skipped by every run on both sides until its pause
// ends, or once the route has served a request since (Jay 2026-11-25 Q4 A: 工區 E moved its executor to Sol at 12:02
// although 工區 D and 清票 had both been refused there by the free account). An API key out of balance is kept here the
// same way under its provider path, with its own basis.
const unsupportedFile=run=>sharedFile(run,'model-unavailable.json');
function readUnsupported(run){try{return JSON.parse(fs.readFileSync(unsupportedFile(run),'utf8'));}catch{return {};}}
function recordUnsupported(run,route,since,until,basis=UNSUPPORTED_BASIS){
  const all=readUnsupported(run),file=unsupportedFile(run);
  if(all[route]?.since>=since)return;
  all[route]={since,until,...(basis===UNSUPPORTED_BASIS?{}:{basis})};
  try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(all)+'\n');fs.renameSync(temp,file);}catch{}
}
function syncUnsupported(state,run,now=Date.now()){
  let changed=false;
  for(const [route,item] of Object.entries(readUnsupported(run))){
    if(!(item.until>now)||state.routeOk?.[route]>item.since)continue;
    for(const side of ['supervisor','executor']){
      const key=side+'|'+route,known=state.rateLimits?.[key];
      if(known?.until>now)continue;
      const billing=item.basis===BILLING_BASIS;
      (state.rateLimits||={})[key]={since:item.since,model:route,files:[],until:item.until,basis:billing?BILLING_BASIS:UNSUPPORTED_BASIS,cooldown:billing?'billing':'unsupported'};
      changed=true;
    }
  }
  return changed;
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
// The order without its open-source stops. A subagent's order does not depend on the mainline (decision 20).
function chainFor(original,role){
  const items=catalog.installed(), originalModel=catalog.identity(original);
  const claudeTier=role==='subagent'?'sonnet':originalModel?.family==='claude'?originalModel.tier:'opus';
  return stopsOf(role).map(stop=>{
    const [kind,provider]=stop.split('|');
    return kind==='claude'?catalog.latest(items,'claude',provider,claudeTier)?.id:catalog.latest(items,'gpt',provider,kind)?.id;
  }).filter(Boolean);
}
// After the Terra routes every role tries DeepSeek then Muse (Jay 2026-11-26 decision 21); a run's preferred fourth
// model still goes first for the executor.
function openRoutes(role,preference=null){
  return require('./openrouter-route.cjs').routes(role==='executor'?preference:null);
}
// Refused or out of its month: the route cannot serve this role now, whatever the ladder says.
function refused(state,model,now,role){
  if(state.rateLimits?.[limitKey(role,model)]?.until>now)return true;
  if(String(model||'').startsWith('openrouter/')&&state.rateLimits?.[OPENROUTER_ACCOUNT]?.until>now)return true;
  const account=billingAccount(model);
  if(account&&state.rateLimits?.[limitKey(role,account)]?.until>now)return true;
  return keyOf(model)==='anthropic-apikey/'&&state.apiMonth?.until>now;
}
function limited(state,model,now=Date.now(),role='executor'){
  return refused(state,model,now,role)||held(state,model,role,now)||cannotDispatch(state,model,role,now);
}
function availableFourth(config){
  const routes=require('./openrouter-route.cjs').routes(config);
  return config?routes.find(r=>r.model===config.model && r.effort===config.effort)||null:routes[0]||null;
}
function next(original,current,role,state,now=Date.now(),fourth=null){
  const candidates=[...chainFor(original,role),...openRoutes(role,fourth).map(r=>r.model)];
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
const ROUTE_QUIET_MS=10*60000;
function recovered(state,now=Date.now()){
  const quiet=(key,bad)=>{const ok=state.routeOk?.[key];return ok>bad&&now-bad>=ROUTE_QUIET_MS?ok:null;};
  const back=key=>quiet(key,state.routeRefused?.[key]||0);
  // A supervisor paused for consecutive failures comes back the same way, once the route has been quiet of failures
  // as well as refusals (Jay 2026-11-23 Q67: after two outages that hit every route at once, both supervisors stayed
  // on open-source models for up to 37 minutes although Opus was answering again). The executor's failure pauses and
  // the silent-switch pause keep their 30 minutes.
  const backFromFailure=key=>quiet(key,Math.max(state.routeRefused?.[key]||0,state.routeFailed?.[key]||0));
  let changed=false;
  for(const [key,item] of Object.entries(state.rateLimits||{})){
    const failed=item.basis===FAILURE_BASIS;
    if(item.basis===SILENT_BASIS||item.basis===BILLING_BASIS||failed&&!key.startsWith('supervisor|'))continue;
    const at=failed?backFromFailure(plainKey(key)):back(plainKey(key));
    if(at>item.since&&item.until>now){item.until=now;item.basis=ROUTE_BASIS;changed=true;}
  }
  for(const record of Object.values(state.modelSwitch||{})){
    const at=back(keyOf(record.original));
    if(!record.restored&&at>record.since&&record.until>now){record.until=now;changed=true;}
  }
  return changed;
}
// OpenCodex marks a model the serving account cannot run as model_unavailable (HTTP 400). Retrying the same route
// cannot fix it, so it is a refusal like a quota limit (Jay 2026-11-25 Q1 A: 10:58～11:03 the free account refused
// gpt-6.2-sol three times and the chats waited for three failures over a minute before moving).
function unsupported(row){return row.upstreamCondition==='model_unavailable';}
function isLimit(row){return row.status===429||row.status===402||row.failureCause==='rate-limit'||unsupported(row)||['rate_limit_exceeded','insufficient_quota'].includes(row.errorCode);}
// OpenCodex answers 429 itself when the upstream connection drops and it will not replay the request. For the
// supervisor that is a broken connection counted with its other failures, not a quota refusal (Jay 2026-11-23 Q67:
// one such answer at 15:31 took 工區 E's supervisor off Opus on the 5-hour default with quota left). The executor
// keeps the move to its next route, which is how it retries.
function connectionReset(row){return row.status===429&&row.errorCode==='upstream_reset_replay_refused';}
function supervisorReset(row,role){return role==='supervisor'&&connectionReset(row);}
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
const hitOf=(owner,row)=>({...owner,model:row.requestedModel||row.model,at:Number(row.timestamp)||Date.now(),status:row.status,
  ...(connectionReset(row)?{connectionReset:true}:{}),...(unsupported(row)?{unsupported:true}:{}),...(row.upstreamCondition==='billing_exhausted'&&billingAccount(row.requestedModel||row.model)?{billing:true}:{}),
  error:String(row.upstreamError||row.errorCode||row.status).slice(0,200)});
function readRange(file,from,to){
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(to-from);
  try{fs.readSync(fd,buffer,0,buffer.length,from);}finally{fs.closeSync(fd);}
  return buffer;
}
// New refusals since the last read. The first read looks back over the file's tail: a thread refused before the
// watcher (re)started still waits on that refusal (2026-10-11 22:09: A's supervisor was refused, the watcher restarted
// at 22:49 and read from the end, so the live limit was never handled). Every read counts only a route whose latest
// request of that thread in what was read is still the refusal; a refusal followed by a success on the same route is
// history (WEB 2026-11-09 01:02: a watcher back after two hours read the 23:14 refusal from its saved offset and moved
// a working supervisor to the paid key). Each route of a thread is judged on its own: subagents' requests reach
// OpenCodex under their mainline's conversation (2026-11-25 工區 E 10:23: the mainline's Sol refusal was followed ten
// seconds later by a worker's Terra refusal and was never handled). Successful requests of any conversation also
// record when each route last worked (routeOk).
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
  const latest=new Map(),ok=state.routeOk||={},refused=state.routeRefused||={},failed=state.routeFailed||={},failures=state.routeFailures||={};
  for(const line of text.split('\n')){
    if(!line.includes('"conversationId"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row.model==='codex-auto-review')continue;
    const model=row.requestedModel||row.model,at=Number(row.timestamp)||0;
    if(model&&row.status>=200&&row.status<300&&!(ok[keyOf(model)]>=at))ok[keyOf(model)]=at;
    if(model&&isLimit(row)&&!(refused[keyOf(model)]>=at))refused[keyOf(model)]=at;
    // When each route last failed for any conversation: a supervisor's failure pause ends only after it has been quiet.
    if(model&&(isFailure(row)||connectionReset(row))&&!(failed[keyOf(model)]>=at))failed[keyOf(model)]=at;
    if(owners.has(row.conversationId)){
      latest.set(row.conversationId+'\u0000'+keyOf(model),row);
      const owner=owners.get(row.conversationId),switched=state.modelSwitch?.[owner.threadId];
      if(switched&&!switched.respondedAt&&model===switched.current&&at>=switched.since&&row.status>=200&&row.status<300&&row.usage?.outputTokens>0)switched.respondedAt=at;
      // A request of the model the chat was switched away from, failing after the switch: the chat did not take it.
      if(switched&&!switched.respondedAt&&at>=switched.since&&model!==switched.current&&model===(switched.from||switched.original)&&
        row.status>=400&&row.status!==499&&!(switched.oldRouteFailedAt>=at))switched.oldRouteFailedAt=at;
      // Consecutive non-quota failures of one mainline on one model; a success of that thread on that model clears them.
      if(owner.role!=='subagent'){
        if(row.status>=200&&row.status<300){if(failures[owner.threadId]?.model===model)delete failures[owner.threadId];}
        else if(isFailure(row)||supervisorReset(row,owner.role)){
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
  for(const row of latest.values()){
    const id=row.conversationId,model=row.requestedModel||row.model;
    if(checks[id]&&keyOf(checks[id].model)===keyOf(model))delete checks[id];
    if(first&&Date.now()-Number(row.timestamp)>=FALLBACK_MS)continue;
    const owner=owners.get(id);
    if(isLimit(row)&&!supervisorReset(row,owner.role))hits.push(hitOf(owner,row));
    else if(row.status===400&&keyOf(model)==='anthropic-apikey/'){
      checks[id]={model,at:Number(row.timestamp)};
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
    let end=fs.fstatSync(fd).size, suffix=Buffer.alloc(0), applied=null;
    while(end>0){
      const start=Math.max(0,end-1024*1024), chunk=Buffer.alloc(end-start);
      fs.readSync(fd,chunk,0,chunk.length,start);
      const data=Buffer.concat([chunk,suffix]), boundary=start?data.indexOf(10):-1;
      // Only a turn_context line can supply settings. Keep the leading fragment
      // across reads; oversized tool output is never needed as a full JSON value.
      if(start && boundary<0){suffix=data.subarray(0,Math.min(data.length,1024*1024));end=start;continue;}
      const lines=data.subarray(boundary+1).toString('utf8').split('\n');
      for(let i=lines.length-1;i>=0;i--){
        if(!lines[i].includes('"turn_context"')&&(applied||!lines[i].includes('"thread_settings_applied"')))continue;
        try{const row=JSON.parse(lines[i]),p=row.payload;
          if(row.type==='turn_context')return {turnId:p.turn_id,model:p.model||null,effort:p.effort||null,approvalPolicy:p.approval_policy||null,
            reviewer:p.approvals_reviewer||null,sandbox:p.sandbox_policy?.type||null,at:row.timestamp,...(applied?{applied}:{})};
          // What the chat is set to run from its next turn on. The turn in progress keeps the model it started with,
          // so this can differ from the turn's own model (2026-11-23 工區 E: set to Opus at 13:17, the turn stayed on DeepSeek until 13:37).
          if(!applied&&row.type==='event_msg'&&p?.type==='thread_settings_applied'&&p.thread_settings?.model)applied={model:p.thread_settings.model,at:row.timestamp};
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
// What each role may use now, front first, with the ladder floor of each role named by its stop.
function ladderOf(state,now=Date.now(),fourth=null){
  const quota=require('./claude-quota.cjs'),reading=state.claudeQuota;
  const roles={};
  for(const role of ['subagent','supervisor','executor']){
    const order=[...chainFor(null,role),...openRoutes(role,fourth).map(r=>r.model)],floor=floorIndex(state,role,now);
    roles[role]={order,floor,first:order.find(model=>!limited(state,model,now,role))||null};
  }
  return {step:quota.step(state),available:reading?.available??null,thresholds:quota.LADDER,fiveHourStep:reading?.fiveHourStep===true,roles};
}
function publish(run,state,now=Date.now(),fourth=null){
  const live=Object.entries(state.rateLimits||{}).filter(([,item])=>item.until>now);
  const entry=item=>({until:new Date(item.until).toISOString(),basis:item.basis,model:item.model});
  // model-route reads limits by route for the executor's workers; the supervisor's own limits are listed apart.
  const limits=Object.fromEntries(live.filter(([key])=>!key.startsWith('supervisor|')).map(([key,item])=>[plainKey(key),entry(item)]));
  const supervisorLimits=Object.fromEntries(live.filter(([key])=>key.startsWith('supervisor|')).map(([key,item])=>[plainKey(key),entry(item)]));
  const quota=state.claudeQuota,describe=require('./claude-quota.cjs').describeOpenAI,ladder=ladderOf(state,now,fourth);
  const body={chain:Object.fromEntries(Object.entries(ladder.roles).map(([role,item])=>[role,item.order])),
    limits,supervisorLimits,...(state.apiMonth?{apiMonth:{until:new Date(state.apiMonth.until).toISOString(),basis:state.apiMonth.basis}}:{}),
    ...(quota?{ladder:{step:ladder.step,available:ladder.available,thresholds:ladder.thresholds,fiveHourStep:ladder.fiveHourStep,
      floors:Object.fromEntries(Object.entries(ladder.roles).map(([role,item])=>[role,item.floor])),
      first:Object.fromEntries(Object.entries(ladder.roles).map(([role,item])=>[role,item.first])),
      summary:require('./claude-quota.cjs').describe(quota),readAt:new Date(quota.at).toISOString()}}:{}),
    ...(quota?.openai?{openaiQuota:{subscriptionHeld:quota.openai.held,floor:quota.openai.floor,summary:describe(quota),readAt:new Date(quota.at).toISOString()}}:{}),
    ...(subscriptionWorker()?{subscriptionMainlineWorker:subscriptionWorker()}:{}),
    ...(openRoutes('executor',fourth).length?{}:{openSourceWarning:'開源備援目前沒有可用模型（OpenCodex 設定或價格上限未通過）'}),
    ...(fourth?{fourthExecutorModel:fourth}:{}),
    rule:'監督與執行主線用同一條順位，子代理用自己的順位（chain）。各角色在自己被拒或降級階梯（ladder）讓它離開前面幾站時往下換：階數每多一階子代理退一站，監督晚兩階、執行主線再晚兩階才開始退；ladder.first 是各角色目前能用的第一站。OpenAI 訂閱到停用線或只剩 2% 以下時所有角色跳過訂閱 GPT。執行主線在 OpenAI 訂閱（Sol、Terra）上時，子代理一律派 subscriptionMainlineWorker（Terra 訂閱），不看子代理降級階梯；它不能用時背景程式先把主線換到下一站。',
    updatedAt:new Date(now).toISOString()};
  const file=path.join(run,'model-fallback.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(body,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return body;
}
// The notice names what actually happened (2026-11-23: ten notices said 額度限速 while no provider had refused for
// quota). A waiting entry carries no refusal of its own: its route simply came free. silentMs is the watcher's window.
function switchReason(hit,target,silentMs){
  if(!hit)return '前面的順位 '+target+' 已可再用：';
  if(hit.connectionReset)return 'OpenCodex 連線中斷（OpenCodex 自己回 429，不是額度被拒）：';
  if(hit.unsupported)return '目前的帳號不支援 '+hit.model+'（OpenCodex 回 model_unavailable）：';
  if(hit.billing)return 'API 儲值用完（OpenCodex 回 billing_exhausted），這台電腦所有工區 5 小時內都跳過這組 API：';
  if(hit.silent)return '切換後 '+Math.round(silentMs/60000)+' 分鐘（不含電腦睡眠）沒有成功回應：';
  if(hit.failure)return '目前模型連續出錯（'+String(hit.error||'').slice(0,80)+'）：';
  if(hit.status===402)return 'OpenRouter 餘額不足：';
  if(hit.status===429&&String(hit.model||'').startsWith('openrouter/'))return '開源順位短暫限速：';
  if(hit.quotaReset||hit.status===429)return '額度限速：';
  return '順位 '+target+' 已可使用：';
}
function restoreReason(limit){
  const basis=limit?.basis;
  if(basis===FAILURE_BASIS||basis===SILENT_BASIS||limit?.cooldown==='failure')return '原模型的失敗暫停已結束。';
  if(basis===OPENROUTER_BASIS)return '原模型的短暫限速已結束。';
  if(basis===UNSUPPORTED_BASIS||limit?.cooldown==='unsupported')return '原模型已可再用。';
  if(basis===BILLING_BASIS||limit?.cooldown==='billing')return 'API 儲值暫停已滿 5 小時，重新試用。';
  return '額度已恢復。';
}
module.exports={FALLBACK_MS,FAILURE_COOLDOWN_MS,OPENROUTER_COOLDOWN_MS,FAILURE_BASIS,OPENROUTER_BASIS,SILENT_BASIS,UNSUPPORTED_BASIS,BILLING_BASIS,OPENROUTER_ACCOUNT,
  billingAccount,subscriptionWorker,cannotDispatch,supervisorOwner,
  modelPolicy,finalReviewer,solRoutes,MAINLINE_STOPS,SUBAGENT_STOPS,stopIndex,floorIndex,ladderOf,hashId,keyOf,sideOf,limitKey,plainKey,subscriptionClaude,subscriptionOpenAI,held,refused,migrateLimits,syncApiMonth,recordApiMonth,
  recordUnsupported,syncUnsupported,
  chainFor,openRoutes,limited,next,availableFourth,retryAt,errorReset,resetFor,refine,recovered,isFailure,scan,settingsOf,fullAccess,publish,switchReason,restoreReason};
