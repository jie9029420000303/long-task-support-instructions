// Claude subscription reserve (Jay 2026-11-21, Q48 A / Q49 A / Q51 C): OpenCodex is only read, never changed
// ("不是叫你去控制opencodex，只是透過他查詢額度判斷長任務中的模型切換時機"). The executor may use the Claude
// subscription while the weighted weekly remainder of the usable accounts is at least 35%; below that, or while every
// usable account has used 80% of its five-hour window, the executor moves to Sol so the rest stays for the Opus supervisor.
const fs=require('node:fs');
const {execFile}=require('node:child_process');
const RESERVE_PERCENT=35, FIVE_HOUR_HIGH=80, FIVE_HOUR_NEAR_MS=30*60000, READ_EVERY_MS=30*60000, RESET_GRACE_MS=60000;
// Max 20x counts four shares and Max 5x one (Q48 A); another plan has no agreed weight and is left out.
function weightOf(plan){const match=/^max_(\d+)x$/.exec(plan||'');return match?Number(match[1])/5:null;}
function fresh(value,reset,now){return Number.isFinite(value)&&value>=0&&value<=100&&Number.isFinite(reset)&&reset>now;}
// An account whose weekly quota is used up still counts, at 0% remaining (Jay 2026-11-21, Q52 A), so the reserve does
// not jump when an account reaches 100%. Paused accounts are left out.
function evaluate(data,now=Date.now(),previous=null){
  const accounts=(Array.isArray(data?.accounts)?data.accounts:[]).filter(a=>a&&a.provider==='anthropic');
  const usable=accounts.filter(a=>!a.paused), rows=[];
  let weight=0,remaining=0;
  for(const account of usable){
    const w=weightOf(account.plan), q=account.quota||{};
    const weekly=fresh(q.weeklyPercent,q.weeklyResetAt,now)?q.weeklyPercent:null;
    const row={label:account.label||account.id||'unknown',plan:account.plan||null,weight:w,weeklyUsed:weekly,weeklyResetAt:q.weeklyResetAt||null,
      fiveHourUsed:fresh(q.fiveHourPercent,q.fiveHourResetAt,now)?q.fiveHourPercent:null,fiveHourResetAt:q.fiveHourResetAt||null};
    rows.push(row);
    if(w===null){row.counted=false;row.note='方案沒有約定權重';continue;}
    // An unreadable weekly use is never taken to mean the account still has quota.
    if(weekly===null){row.counted=true;row.note='讀不到有效週用量，以 0% 剩餘計';weight+=w;continue;}
    row.counted=true;weight+=w;remaining+=w*(100-Math.min(weekly,100));
  }
  const weeklyRemaining=weight>0?Math.round(remaining/weight*10)/10:null;
  // The five-hour window matters only for accounts that can still serve this week.
  const serving=rows.filter(r=>r.weight!==null&&r.weeklyUsed!==null&&r.weeklyUsed<100);
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
function nextReadAt(result,readAt){
  const regular=readAt+READ_EVERY_MS;
  return result?.nextResetAt&&result.nextResetAt+RESET_GRACE_MS<regular?result.nextResetAt+RESET_GRACE_MS:regular;
}
// A test or an isolated run names a JSON file; otherwise ask the OpenCodex command line. A read at a reset bypasses
// the quota cache so the reset is seen at once.
function read(refresh=false){
  const file=process.env.LONG_TASK_CLAUDE_QUOTA_FILE;
  if(file)return new Promise(resolve=>{try{resolve(JSON.parse(fs.readFileSync(file,'utf8')));}catch(error){resolve({error:String(error.message||error)});}});
  const bin=process.env.OPENCODEX_OCX_BIN||'ocx';
  return new Promise(resolve=>execFile(bin,['account','list','anthropic','--quota',...(refresh?['--refresh']:[]),'--json'],
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
    state.claudeQuota={at:now,allowed:true,hold:null,unconfigured:true,weeklyRemaining:null,reserve:RESERVE_PERCENT,accounts:[],nextReadAt:now+READ_EVERY_MS};
    return !known||!known.unconfigured;
  }
  const atReset=Boolean(known?.nextResetAt&&now>=known.nextResetAt);
  const data=await read(atReset);
  const result=data?.error?{...evaluate(null,now,known),error:data.error}:evaluate(data,now,known);
  result.nextReadAt=nextReadAt(result,now);
  const changed=!known||known.allowed!==result.allowed||known.hold!==result.hold;
  state.claudeQuota=result;
  return changed;
}
function allowed(state){return state.claudeQuota?.allowed===true;}
function describe(quota){
  if(!quota)return '尚未讀取';
  if(quota.unconfigured)return '測試環境沒有額度來源，不套用保留';
  const weekly=quota.weeklyRemaining===null?'讀不到':quota.weeklyRemaining+'%';
  const why={weekly:'低於 '+quota.reserve+'%，執行端改用 Sol',unknown:'讀不到用量，不假定有額度，執行端改用 Sol',
    'five-hour':'可用帳號 5 小時額度都已用到 '+FIVE_HOUR_HIGH+'%，執行端改用 Sol 到重置'}[quota.hold]||'執行端可用 Sonnet';
  return '可用帳號週剩餘加權 '+weekly+'（保留 '+quota.reserve+'% 給監督）：'+why+(quota.error?'；讀取錯誤：'+quota.error:'');
}
module.exports={RESERVE_PERCENT,FIVE_HOUR_HIGH,FIVE_HOUR_NEAR_MS,READ_EVERY_MS,weightOf,evaluate,nextReadAt,read,temporary,refresh,allowed,describe};
