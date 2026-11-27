// Subscription quota and the step-down ladder (Jay 2026-11-26, decisions 24, 25, 27-29). The quota is read from
// OpenCodex ("不是叫你去控制opencodex，只是透過他查詢額度判斷長任務中的模型切換時機"). One reading gives the Agent's
// available share of the subscriptions that can run the high tier: every Claude account and every OpenAI account whose
// plan can run Sol (prolite), weighted by plan. Each account's own threshold (OpenCodex 自訂門檻) is its stop line:
// what lies above it is kept for Jay, so the available share is Σ weight×max(0, line − weekly used) ÷ Σ weight×line
// (no line counts as 100). Each threshold under 50% is one more step for all roles together, the thresholds closer
// together the nearer the share is to empty (50, 35, 24, 16, 10, 6, 3, 1, Jay 2026-11-27 「從50%開始 越降越快 ... 越靠近
// 沒有 收得越緊 不然就盡量寬鬆 用高階一點的模型」; it was every 7 points before): the subagents move one
// stop down their order per step, the supervisor two steps later and the executor two steps after that, so the most
// important roles keep the front of their order longest. While every Claude account that can still serve this week
// has used 80% of its five-hour window, the ladder is one step lower until that window resets.
// The stop line pauses an account only when it is shared with other people (its OpenCodex label holds 「共用」): then
// nobody, Jay included, uses it past the line. Jay's own accounts are never paused for it; they only count 0 available.
// An OpenAI subscription account at its own line, or without one down to its last 2%, is skipped by every role
// (Jay 2026-11-25「能否在剩下2%時長任務就跳過openai帳號，但不用切暫停」, 2026-11-26 decision 26).
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const LADDER=[50,35,24,16,10,6,3,1], FIVE_HOUR_HIGH=80, FIVE_HOUR_NEAR_MS=30*60000, READ_EVERY_MS=30*60000, RESET_GRACE_MS=60000, OPENAI_FLOOR=2;
// How many steps later than the subagents each role starts stepping down (decision 24).
const LADDER_DELAY={subagent:0,supervisor:2,executor:4};
// Max 20x counts four shares, Max 5x and OpenAI prolite one (Q48 A, decision 17); another plan (OpenAI free cannot run
// Sol) has no agreed weight and is left out.
function weightOf(plan){
  if(plan==='prolite')return 1;
  const match=/^max_(\d+)x$/.exec(plan||'');return match?Number(match[1])/5:null;
}
function fresh(value,reset,now){return Number.isFinite(value)&&value>=0&&value<=100&&Number.isFinite(reset)&&reset>now;}
// OpenCodex reports OpenAI resets in seconds and Anthropic resets in milliseconds.
const millis=at=>Number.isFinite(at)&&at<1e12?at*1000:at;
function stopLine(account){
  const line=account?.autoSwitchThresholdOverride;
  return Number.isFinite(line)&&line>0&&line<=100?line:null;
}
const shared=account=>/共用/.test(String(account?.label||''));
// The main slot and a pool slot of one ChatGPT account are one account, whose line is the one set. They share an
// upstream key; a reading where a slot comes without that key (2026-11-27: prolite's main slot, one read in three,
// counted twice) matches them by the masked email and plan instead.
function sameOpenAIAccount(a,b){
  if(a.upstreamAccountKey&&b.upstreamAccountKey)return a.upstreamAccountKey===b.upstreamAccountKey;
  return Boolean(a.email)&&a.email===b.email&&a.plan===b.plan;
}
function openaiAccounts(data){
  const accounts=[];
  for(const account of (Array.isArray(data?.accounts)?data.accounts:[])){
    if(!account||account.provider!=='openai')continue;
    const known=accounts.find(item=>item.slots.some(slot=>sameOpenAIAccount(slot,account)));
    if(!known){accounts.push({...account,line:stopLine(account),slots:[account]});continue;}
    known.slots.push(account);known.line??=stopLine(account);known.paused=known.paused&&account.paused;
  }
  return accounts;
}
// OpenAI subscription floor. An account is out for the long task once its weekly use reaches its own line, or, without
// a line, once any current window (five hours, week, month) has at most 2% left; it serves again at the latest reset
// among those windows. An account whose use cannot be read keeps the subscription in use: only a reading holds it
// back, and a refusal still moves a route as before. The subscription is skipped when every account Jay has not
// paused is out.
function evaluateOpenAI(data,now=Date.now()){
  if(!data||data.error)return {held:false,floor:OPENAI_FLOOR,accounts:[],resetAt:null,...(data?.error?{error:data.error}:{})};
  const accounts=[];
  for(const account of openaiAccounts(data)){
    if(account.paused)continue;
    const q=account.quota||{};
    const windows=['fiveHour','weekly','monthly'].map(name=>({name,used:q[name+'Percent'],resetAt:millis(q[name+'ResetAt'])})).filter(w=>fresh(w.used,w.resetAt,now));
    const weekly=windows.find(w=>w.name==='weekly');
    const low=account.line!==null?(weekly&&weekly.used>=account.line?[weekly]:[]):windows.filter(w=>100-w.used<=OPENAI_FLOOR);
    accounts.push({label:account.label||account.id||'unknown',plan:account.plan||null,line:account.line,
      remaining:windows.length?100-Math.max(...windows.map(w=>w.used)):null,resetAt:low.length?Math.max(...low.map(w=>w.resetAt)):null});
  }
  const held=accounts.length>0&&accounts.every(a=>a.resetAt!==null);
  return {held,floor:OPENAI_FLOOR,accounts,resetAt:held?Math.min(...accounts.map(a=>a.resetAt)):null};
}
// The ladder step for an available share: one step for every threshold it is below. A reading that gives no share
// (nothing readable) assumes nothing is left, the bottom step.
function stepOf(available){
  if(available===null)return LADDER.length;
  return LADDER.filter(threshold=>available<threshold).length;
}
// Where a role stands on its own order: how many stops from its first it must keep away from.
function floorOf(quota,role){
  const step=quota&&!quota.unconfigured&&Number.isInteger(quota.step)?quota.step:0;
  return Math.max(0,step-(LADDER_DELAY[role==='subagent'?'subagent':role]??0));
}
// The available share over the Claude accounts and the OpenAI accounts that can run Sol. An account whose weekly quota
// is used up, cannot be read, or is paused at its stop line still counts, with nothing available (Jay 2026-11-21, Q52 A),
// so the share does not jump when one changes. Accounts Jay paused himself are left out.
function evaluate(data,now=Date.now(),previous=null,stopped=new Set(),openai=null){
  const rows=[];let weight=0,available=0;
  const count=(account,provider)=>{
    const w=weightOf(account.plan),q=account.quota||{},line=provider==='openai'?account.line:stopLine(account);
    const weekly=fresh(q.weeklyPercent,millis(q.weeklyResetAt),now)?q.weeklyPercent:null;
    const row={label:account.label||account.id||'unknown',provider,plan:account.plan||null,weight:w,line:line??100,shared:shared(account),weeklyUsed:weekly,
      weeklyResetAt:millis(q.weeklyResetAt)||null,fiveHourUsed:fresh(q.fiveHourPercent,q.fiveHourResetAt,now)?q.fiveHourPercent:null,fiveHourResetAt:q.fiveHourResetAt||null};
    rows.push(row);
    if(w===null){row.counted=false;row.note='方案沒有約定權重';return;}
    row.counted=true;weight+=w*row.line;
    if(account.paused){row.stopped=true;row.note='到停用線已暫停，可用量以 0 計';return;}
    // An unreadable weekly use is never taken to mean the account still has quota.
    if(weekly===null){row.note='讀不到有效週用量，可用量以 0 計';return;}
    row.available=Math.max(0,row.line-weekly);available+=w*row.available;
  };
  const claude=(Array.isArray(data?.accounts)?data.accounts:[]).filter(a=>a&&a.provider==='anthropic');
  for(const account of claude.filter(a=>!a.paused||stopped.has(a.id)))count(account,'anthropic');
  for(const account of openaiAccounts(openai).filter(a=>!a.paused||a.slots.some(slot=>stopped.has(slot.id))))count(account,'openai');
  const share=weight>0?Math.round(available/weight*1000)/10:null;
  // The five-hour window matters only for Claude accounts that can still serve this week.
  const serving=rows.filter(r=>r.provider==='anthropic'&&!r.stopped&&r.weight!==null&&r.weeklyUsed!==null&&r.weeklyUsed<r.line);
  const high=serving.length>0&&serving.every(r=>r.fiveHourUsed!==null&&r.fiveHourUsed>=FIVE_HOUR_HIGH);
  const fiveHourResetAt=high?Math.min(...serving.map(r=>r.fiveHourResetAt)):null;
  // Close to the five-hour reset nothing moves for it; once moved it stays until that reset.
  const fiveHour=high&&(previous?.fiveHourStep===true||fiveHourResetAt-now>=FIVE_HOUR_NEAR_MS);
  const step=Math.min(LADDER.length,stepOf(share)+(fiveHour?1:0));
  const resets=[...claude,...(openai?.accounts||[])].flatMap(a=>[millis(a.quota?.weeklyResetAt),a.quota?.fiveHourResetAt]).filter(at=>Number.isFinite(at)&&at>now);
  return {at:now,available:share,step,ladder:LADDER,fiveHourHigh:high,fiveHourStep:fiveHour,fiveHourResetAt,
    accounts:rows,excludedPaused:claude.filter(a=>a.paused&&!stopped.has(a.id)).length,nextResetAt:resets.length?Math.min(...resets):null};
}
// Stop line (Q68 A, decision 27). Only an account whose own threshold is set in OpenCodex has one; the pool-wide
// threshold stays a routing preference. Only a shared account (label 「共用」) is paused at its line. The ledger names the
// accounts this program paused, so only those are ever resumed: an account Jay paused stays paused. If Jay resumes a
// stopped account himself, it is left in use until its weekly reset.
// Every reading judges a stopped account again by what OpenCodex holds now (Jay 2026-11-26「讓背景程式每次讀額度時
// 用最新門檻重新判斷已暫停的帳號，門檻調高到已用量以上就自動恢復」): once its weekly use is under the current line, it has
// no line any more, or it is no longer marked shared, it is resumed and the record dropped.
// An account whose weekly use cannot be read is neither paused nor resumed. Both runs share one ledger.
function stopsFile(run){
  if(process.env.LONG_TASK_ACCOUNT_STOPS_FILE)return process.env.LONG_TASK_ACCOUNT_STOPS_FILE;
  if(!process.env.LONG_TASK_HOME&&run&&temporary(run))return path.join(run,'claude-account-stops.json');
  return path.join(require('./notify.cjs').home(),'claude-account-stops.json');
}
function loadStops(file){
  try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value&&typeof value.accounts==='object'&&value.accounts)return value;}catch{}
  return {accounts:{}};
}
function saveStops(file,value){
  try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);}catch{}
}
// Pure: what to do with each account of one provider given this reading and the ledger.
function planStops(data,ledger,now=Date.now()){
  const actions=[];
  for(const account of (Array.isArray(data?.accounts)?data.accounts:[])){
    if(!account||!['anthropic','openai'].includes(account.provider)||!account.id)continue;
    const entry=ledger.accounts[account.id], q=account.quota||{}, label=account.label||account.id, provider=account.provider;
    const line=shared(account)?stopLine(account):null, resetAt=millis(q.weeklyResetAt);
    const weekly=fresh(q.weeklyPercent,resetAt,now)?q.weeklyPercent:null;
    if(entry?.state==='paused'){
      if(now>=entry.resetAt){actions.push({type:account.paused?'resume':'forget',id:account.id,provider,label});continue;}
      // Jay resumed it himself (a minute after the pause, so a reading taken at the pause is not mistaken for that).
      if(!account.paused&&now-entry.pausedAt>=60000)actions.push({type:'released',id:account.id,provider,label,until:entry.resetAt});
      else if(account.paused&&(line===null&&!shared(account)||weekly!==null&&(line===null||weekly<line)))actions.push({type:'resume',id:account.id,provider,label,line,weekly});
      continue;
    }
    if(entry?.state==='released'){if(now<entry.until)continue;actions.push({type:'forget',id:account.id,provider,label});}
    if(account.paused||line===null||weekly===null||weekly<line)continue;
    actions.push({type:'pause',id:account.id,provider,label,line,weekly,resetAt});
  }
  return actions;
}
// A test names the quota file; it changes OpenCodex only through a stand-in command it also names.
function ocx(args){
  if(process.env.LONG_TASK_CLAUDE_QUOTA_FILE&&!process.env.OPENCODEX_OCX_BIN)return Promise.resolve({error:'測試沒有指定 OpenCodex 指令'});
  const bin=process.env.OPENCODEX_OCX_BIN||'ocx';
  return new Promise(resolve=>execFile(bin,args,{encoding:'utf8',timeout:30000},error=>
    resolve(error?{error:String(error.message||error).split('\n')[0].slice(0,200)}:{ok:true})));
}
async function applyStops(data,ledger,now=Date.now()){
  const done=[];
  for(const action of planStops(data,ledger,now)){
    const account=data.accounts.find(a=>a.id===action.id);
    if(action.type==='pause'||action.type==='resume'){
      const result=await ocx(['account',action.type,action.provider,action.id]);
      if(result.error){done.push({...action,error:result.error});continue;}
      if(action.type==='pause'){
        ledger.accounts[action.id]={state:'paused',provider:action.provider,label:action.label,line:action.line,weeklyUsed:action.weekly,pausedAt:now,resetAt:action.resetAt};
        account.paused=true;
      }else{delete ledger.accounts[action.id];account.paused=false;}
    }else if(action.type==='released')ledger.accounts[action.id]={state:'released',label:action.label,until:action.until,at:now};
    else delete ledger.accounts[action.id];
    done.push(action);
  }
  return done;
}
function stoppedIds(ledger){return new Set(Object.entries(ledger.accounts).filter(([,entry])=>entry.state==='paused').map(([id])=>id));}
function nextReadAt(result,readAt){
  const regular=readAt+READ_EVERY_MS;
  return result?.nextResetAt&&result.nextResetAt+RESET_GRACE_MS<regular?result.nextResetAt+RESET_GRACE_MS:regular;
}
// A test or an isolated run names a JSON file holding every provider's accounts; otherwise ask the OpenCodex command
// line once per provider. Every read refreshes the subscription quota before it is counted (Jay 2026-11-25「只要是月訂閱類
// 的帳號，不分平台，一率都是先點選重新整理額度後再計算」); the API keys have no quota to read.
async function read(){
  const file=process.env.LONG_TASK_CLAUDE_QUOTA_FILE;
  if(file){
    let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){data={error:String(error.message||error)};}
    return {anthropic:data,openai:data};
  }
  const [anthropic,openai]=await Promise.all(['anthropic','openai'].map(list));
  return {anthropic,openai};
}
function list(provider){
  const bin=process.env.OPENCODEX_OCX_BIN||'ocx';
  return new Promise(resolve=>execFile(bin,['account','list',provider,'--quota','--refresh','--json'],
    {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024},(error,stdout)=>{
      if(error)return resolve({error:String(error.message||error).split('\n')[0].slice(0,200)});
      try{resolve(JSON.parse(stdout));}catch(caught){resolve({error:'unreadable ocx output: '+String(caught.message).slice(0,120)});}
    }));
}
// A run under the system temp directory is a test: without a named file it never asks the real OpenCodex and the
// reserve does not apply (the same rule notify.cjs uses for phone pushes).
function temporary(run){
  const real=file=>{try{return fs.realpathSync(file);}catch{return require('node:path').resolve(file);}};
  const tmp=real(process.env.LONG_TASK_TEMP_ROOT||require('node:os').tmpdir()),at=real(run);
  return at===tmp||at.startsWith(tmp+require('node:path').sep);
}
// Reads every 30 minutes and once just after any account reset (Q51 C). force reads at once: the watcher reads again
// right before it switches a chat, so a reset nobody announced (a reset offer, or one the provider made itself) counts
// in that switch (Jay 2026-11-27 decision 45). Returns true when the decision changed.
async function refresh(state,now=Date.now(),run=null,{force=false}={}){
  const known=state.claudeQuota;
  if(!force&&known&&now<known.nextReadAt)return false;
  if(!process.env.LONG_TASK_CLAUDE_QUOTA_FILE&&run&&temporary(run)){
    state.claudeQuota={at:now,step:0,available:null,unconfigured:true,ladder:LADDER,accounts:[],
      openai:evaluateOpenAI(null,now),nextReadAt:now+READ_EVERY_MS};
    return !known||!known.unconfigured;
  }
  // The ledger is read before OpenCodex, so a pause the other run just made shows in this reading.
  const file=stopsFile(run), ledger=loadStops(file);
  const reading=await read(), data=reading.anthropic;
  const actions=[];
  for(const provider of [data,reading.openai])if(provider&&!provider.error)actions.push(...await applyStops(provider,ledger,now));
  if(actions.some(action=>!action.error))saveStops(file,ledger);
  // Without the Claude reading there is no share to judge: nothing is assumed left (the bottom step).
  const result=data?.error?{...evaluate(null,now,known),available:null,step:LADDER.length,error:data.error}:evaluate(data,now,known,stoppedIds(ledger),reading.openai?.error?null:reading.openai);
  result.stops=Object.values(ledger.accounts).filter(entry=>entry.state==='paused').map(({label,line,resetAt})=>({label,line,resetAt}));
  if(actions.length)result.stopActions=actions;
  result.openai=evaluateOpenAI(reading.openai,now);
  // The OpenAI reset is read at once too, so the subscription comes back a minute after it.
  const resets=[result.nextResetAt,result.openai.resetAt].filter(at=>Number.isFinite(at)&&at>now);
  result.nextResetAt=resets.length?Math.min(...resets):null;
  result.nextReadAt=nextReadAt(result,now);
  const changed=!known||known.step!==result.step||known.openai?.held!==result.openai.held||actions.length>0;
  state.claudeQuota=result;
  return changed;
}
function step(state){return state.claudeQuota&&!state.claudeQuota.unconfigured?state.claudeQuota.step:0;}
function openaiHeld(state){return state.claudeQuota?.openai?.held===true;}
function describe(quota){
  if(!quota)return '尚未讀取';
  if(quota.unconfigured)return '測試環境沒有額度來源，不套用降級階梯';
  const share=quota.available===null?'讀不到':quota.available+'%';
  const next=LADDER[quota.step];
  const why=quota.step===0?'各角色用順位第一站':'降級第 '+quota.step+' 階（'+(quota.available===null?'讀不到用量，不假定還有額度':'低於 '+LADDER[Math.min(quota.step,LADDER.length)-1]+'%')+(quota.fiveHourStep?'，另因 5 小時額度都已用到 '+FIVE_HOUR_HIGH+'% 多降一階':'')+'）'+
    '：子代理退 '+floorOf(quota,'subagent')+' 站、監督退 '+floorOf(quota,'supervisor')+' 站、執行主線退 '+floorOf(quota,'executor')+' 站';
  const when=at=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const stops=(quota.stops||[]).map(s=>s.label+' 是共用帳號，週用量到停用線 '+s.line+'%，已暫停到 '+when(s.resetAt)+' 重置');
  const failed=(quota.stopActions||[]).filter(a=>a.error).map(a=>a.label+(a.type==='pause'?' 暫停':' 恢復')+'失敗：'+a.error);
  return 'Agent 可用量 '+share+'（停用線以上留給你）：'+why+(next!==undefined&&quota.available!==null?'；低於 '+next+'% 再降一階':'')+
    [...stops,...failed].map(s=>'；'+s).join('')+(quota.error?'；讀取錯誤：'+quota.error:'');
}
function describeOpenAI(quota){
  const openai=quota?.openai;
  if(!openai)return '尚未讀取';
  if(quota.unconfigured)return '測試環境沒有額度來源，不套用保留';
  const when=at=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const left=openai.accounts.map(a=>a.label+' 剩 '+(a.remaining===null?'讀不到':a.remaining+'%')+(a.line!==null?'（停用線 '+a.line+'%）':'')).join('、')||'沒有未暫停的帳號';
  if(openai.held)return left+'：都已到停用線或只剩 '+openai.floor+'% 以下，留給你自己用，長任務改用下一順位到 '+when(openai.resetAt)+' 重置';
  return left+'：長任務照常可用'+(openai.error?'；讀取錯誤：'+openai.error:'');
}
module.exports={LADDER,LADDER_DELAY,FIVE_HOUR_HIGH,FIVE_HOUR_NEAR_MS,READ_EVERY_MS,OPENAI_FLOOR,weightOf,shared,evaluate,evaluateOpenAI,stepOf,floorOf,nextReadAt,read,temporary,refresh,
  step,openaiHeld,describe,describeOpenAI,planStops,applyStops,stopsFile};
