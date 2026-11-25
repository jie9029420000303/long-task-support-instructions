// Claude subscription reserve (Jay 2026-11-21, Q48 A / Q49 A / Q51 C): the quota is read from OpenCodex
// ("不是叫你去控制opencodex，只是透過他查詢額度判斷長任務中的模型切換時機"). The executor may use the Claude
// subscription while the weighted weekly remainder of the usable accounts is at least 35%; below that, or while every
// usable account has used 80% of its five-hour window, the executor moves to Sol so the rest stays for the Opus supervisor.
// The one change made in OpenCodex is the account stop line (Jay 2026-11-23, Q68 A): an account whose own threshold
// (OpenCodex 自訂門檻) is set is paused once its weekly use reaches it and resumed after its weekly reset.
// The same reading covers the OpenAI subscription (Jay 2026-11-25「能否在剩下2%時長任務就跳過openai帳號，但不用切暫停」):
// once every OpenAI account Jay has not paused is down to its last 2%, every role skips the subscription GPT models so
// the rest stays for Jay's own use (voice). Nothing is paused in OpenCodex for it.
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const RESERVE_PERCENT=35, FIVE_HOUR_HIGH=80, FIVE_HOUR_NEAR_MS=30*60000, READ_EVERY_MS=30*60000, RESET_GRACE_MS=60000, OPENAI_FLOOR=2;
// Max 20x counts four shares and Max 5x one (Q48 A); another plan has no agreed weight and is left out.
function weightOf(plan){const match=/^max_(\d+)x$/.exec(plan||'');return match?Number(match[1])/5:null;}
function fresh(value,reset,now){return Number.isFinite(value)&&value>=0&&value<=100&&Number.isFinite(reset)&&reset>now;}
// OpenCodex reports OpenAI resets in seconds and Anthropic resets in milliseconds.
const millis=at=>Number.isFinite(at)&&at<1e12?at*1000:at;
// OpenAI subscription floor. The main slot and a pool slot of one ChatGPT account share an upstream key and count once.
// An account is down to the floor when any of its current windows (five hours, week, month) has at most 2% left; it
// serves again at the latest reset among those windows. An account whose use cannot be read keeps the subscription in
// use: only a reading at the floor holds it back, and a refusal still moves a route as before.
function evaluateOpenAI(data,now=Date.now()){
  if(!data||data.error)return {held:false,floor:OPENAI_FLOOR,accounts:[],resetAt:null,...(data?.error?{error:data.error}:{})};
  const seen=new Set(),accounts=[];
  for(const account of (Array.isArray(data.accounts)?data.accounts:[])){
    if(!account||account.provider!=='openai'||account.paused)continue;
    const key=account.upstreamAccountKey||account.id;
    if(seen.has(key))continue;
    seen.add(key);
    const q=account.quota||{};
    const windows=['fiveHour','weekly','monthly'].map(name=>({used:q[name+'Percent'],resetAt:millis(q[name+'ResetAt'])})).filter(w=>fresh(w.used,w.resetAt,now));
    const low=windows.filter(w=>100-w.used<=OPENAI_FLOOR);
    accounts.push({label:account.label||account.id||'unknown',plan:account.plan||null,
      remaining:windows.length?100-Math.max(...windows.map(w=>w.used)):null,resetAt:low.length?Math.max(...low.map(w=>w.resetAt)):null});
  }
  const held=accounts.length>0&&accounts.every(a=>a.resetAt!==null);
  return {held,floor:OPENAI_FLOOR,accounts,resetAt:held?Math.min(...accounts.map(a=>a.resetAt)):null};
}
// An account whose weekly quota is used up still counts, at 0% remaining (Jay 2026-11-21, Q52 A), so the reserve does
// not jump when an account reaches 100%. An account paused at its stop line cannot serve either, so it counts the same
// way. Accounts Jay paused are left out.
function evaluate(data,now=Date.now(),previous=null,stopped=new Set()){
  const accounts=(Array.isArray(data?.accounts)?data.accounts:[]).filter(a=>a&&a.provider==='anthropic');
  const usable=accounts.filter(a=>!a.paused||stopped.has(a.id)), rows=[];
  let weight=0,remaining=0;
  for(const account of usable){
    const w=weightOf(account.plan), q=account.quota||{};
    const weekly=fresh(q.weeklyPercent,q.weeklyResetAt,now)?q.weeklyPercent:null;
    const row={label:account.label||account.id||'unknown',plan:account.plan||null,weight:w,weeklyUsed:weekly,weeklyResetAt:q.weeklyResetAt||null,
      fiveHourUsed:fresh(q.fiveHourPercent,q.fiveHourResetAt,now)?q.fiveHourPercent:null,fiveHourResetAt:q.fiveHourResetAt||null};
    rows.push(row);
    if(w===null){row.counted=false;row.note='方案沒有約定權重';continue;}
    if(account.paused){row.stopped=true;row.counted=true;row.note='到自訂門檻已暫停，以 0% 剩餘計';weight+=w;continue;}
    // An unreadable weekly use is never taken to mean the account still has quota.
    if(weekly===null){row.counted=true;row.note='讀不到有效週用量，以 0% 剩餘計';weight+=w;continue;}
    row.counted=true;weight+=w;remaining+=w*(100-Math.min(weekly,100));
  }
  const weeklyRemaining=weight>0?Math.round(remaining/weight*10)/10:null;
  // The five-hour window matters only for accounts that can still serve this week.
  const serving=rows.filter(r=>!r.stopped&&r.weight!==null&&r.weeklyUsed!==null&&r.weeklyUsed<100);
  const high=serving.length>0&&serving.every(r=>r.fiveHourUsed!==null&&r.fiveHourUsed>=FIVE_HOUR_HIGH);
  const fiveHourResetAt=high?Math.min(...serving.map(r=>r.fiveHourResetAt)):null;
  const wasFiveHour=previous?.hold==='five-hour';
  let hold=null;
  if(weeklyRemaining===null)hold='unknown';
  else if(weeklyRemaining<RESERVE_PERCENT)hold='weekly';
  // Close to the five-hour reset the executor stays where it is; once moved it stays until that reset.
  else if(high&&(wasFiveHour||fiveHourResetAt-now>=FIVE_HOUR_NEAR_MS))hold='five-hour';
  const resets=accounts.flatMap(a=>[a.quota?.weeklyResetAt,a.quota?.fiveHourResetAt]).filter(at=>Number.isFinite(at)&&at>now);
  return {at:now,allowed:hold===null,hold,weeklyRemaining,reserve:RESERVE_PERCENT,fiveHourHigh:high,fiveHourResetAt,
    accounts:rows,excludedPaused:accounts.length-usable.length,nextResetAt:resets.length?Math.min(...resets):null};
}
// Stop line (Q68 A). Only an account whose own threshold is set in OpenCodex has one; the pool-wide threshold stays a
// routing preference. The ledger names the accounts this program paused, so only those are ever resumed: an account
// Jay paused stays paused. If Jay resumes a stopped account himself, it is left in use until its weekly reset.
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
function stopLine(account){
  const line=account?.autoSwitchThresholdOverride;
  return Number.isFinite(line)&&line>0&&line<=100?line:null;
}
// Pure: what to do with each account given this reading and the ledger.
function planStops(data,ledger,now=Date.now()){
  const actions=[];
  for(const account of (Array.isArray(data?.accounts)?data.accounts:[])){
    if(!account||account.provider!=='anthropic'||!account.id)continue;
    const entry=ledger.accounts[account.id], q=account.quota||{}, label=account.label||account.id;
    if(entry?.state==='paused'){
      if(now>=entry.resetAt){actions.push({type:account.paused?'resume':'forget',id:account.id,label});continue;}
      // Jay resumed it himself (a minute after the pause, so a reading taken at the pause is not mistaken for that).
      if(!account.paused&&now-entry.pausedAt>=60000)actions.push({type:'released',id:account.id,label,until:entry.resetAt});
      continue;
    }
    if(entry?.state==='released'){if(now<entry.until)continue;actions.push({type:'forget',id:account.id,label});}
    const line=stopLine(account);
    const weekly=fresh(q.weeklyPercent,q.weeklyResetAt,now)?q.weeklyPercent:null;
    if(account.paused||line===null||weekly===null||weekly<line)continue;
    actions.push({type:'pause',id:account.id,label,line,weekly,resetAt:q.weeklyResetAt});
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
      const result=await ocx(['account',action.type,'anthropic',action.id]);
      if(result.error){done.push({...action,error:result.error});continue;}
      if(action.type==='pause'){
        ledger.accounts[action.id]={state:'paused',label:action.label,line:action.line,weeklyUsed:action.weekly,pausedAt:now,resetAt:action.resetAt};
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
// Reads every 30 minutes and once just after any account reset (Q51 C). Returns true when the decision changed.
async function refresh(state,now=Date.now(),run=null){
  const known=state.claudeQuota;
  if(known&&now<known.nextReadAt)return false;
  if(!process.env.LONG_TASK_CLAUDE_QUOTA_FILE&&run&&temporary(run)){
    state.claudeQuota={at:now,allowed:true,hold:null,unconfigured:true,weeklyRemaining:null,reserve:RESERVE_PERCENT,accounts:[],
      openai:evaluateOpenAI(null,now),nextReadAt:now+READ_EVERY_MS};
    return !known||!known.unconfigured;
  }
  // The ledger is read before OpenCodex, so a pause the other run just made shows in this reading.
  const file=stopsFile(run), ledger=loadStops(file);
  const reading=await read(), data=reading.anthropic;
  const actions=data?.error?[]:await applyStops(data,ledger,now);
  if(actions.some(action=>!action.error))saveStops(file,ledger);
  const result=data?.error?{...evaluate(null,now,known),error:data.error}:evaluate(data,now,known,stoppedIds(ledger));
  result.stops=Object.values(ledger.accounts).filter(entry=>entry.state==='paused').map(({label,line,resetAt})=>({label,line,resetAt}));
  if(actions.length)result.stopActions=actions;
  result.openai=evaluateOpenAI(reading.openai,now);
  // The OpenAI reset is read at once too, so the subscription comes back a minute after it.
  const resets=[result.nextResetAt,result.openai.resetAt].filter(at=>Number.isFinite(at)&&at>now);
  result.nextResetAt=resets.length?Math.min(...resets):null;
  result.nextReadAt=nextReadAt(result,now);
  const changed=!known||known.allowed!==result.allowed||known.hold!==result.hold||known.openai?.held!==result.openai.held||actions.length>0;
  state.claudeQuota=result;
  return changed;
}
function allowed(state){return state.claudeQuota?.allowed===true;}
function openaiHeld(state){return state.claudeQuota?.openai?.held===true;}
function describe(quota){
  if(!quota)return '尚未讀取';
  if(quota.unconfigured)return '測試環境沒有額度來源，不套用保留';
  const weekly=quota.weeklyRemaining===null?'讀不到':quota.weeklyRemaining+'%';
  const why={weekly:'低於 '+quota.reserve+'%，執行端改用 Sol',unknown:'讀不到用量，不假定有額度，執行端改用 Sol',
    'five-hour':'可用帳號 5 小時額度都已用到 '+FIVE_HOUR_HIGH+'%，執行端改用 Sol 到重置'}[quota.hold]||'執行端可用 Sonnet';
  const when=at=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const stops=(quota.stops||[]).map(s=>s.label+' 週用量到自訂門檻 '+s.line+'%，已暫停到 '+when(s.resetAt)+' 重置');
  const failed=(quota.stopActions||[]).filter(a=>a.error).map(a=>a.label+(a.type==='pause'?' 暫停':' 恢復')+'失敗：'+a.error);
  return '可用帳號週剩餘加權 '+weekly+'（保留 '+quota.reserve+'% 給監督）：'+why+[...stops,...failed].map(s=>'；'+s).join('')+(quota.error?'；讀取錯誤：'+quota.error:'');
}
function describeOpenAI(quota){
  const openai=quota?.openai;
  if(!openai)return '尚未讀取';
  if(quota.unconfigured)return '測試環境沒有額度來源，不套用保留';
  const when=at=>new Date(at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const left=openai.accounts.map(a=>a.label+' 剩 '+(a.remaining===null?'讀不到':a.remaining+'%')).join('、')||'沒有未暫停的帳號';
  if(openai.held)return left+'：都只剩 '+openai.floor+'% 以下，留給你自己用，長任務改用下一順位到 '+when(openai.resetAt)+' 重置';
  return left+'：長任務照常可用'+(openai.error?'；讀取錯誤：'+openai.error:'');
}
module.exports={RESERVE_PERCENT,FIVE_HOUR_HIGH,FIVE_HOUR_NEAR_MS,READ_EVERY_MS,OPENAI_FLOOR,weightOf,evaluate,evaluateOpenAI,nextReadAt,read,temporary,refresh,
  allowed,openaiHeld,describe,describeOpenAI,planStops,applyStops,stopsFile};
