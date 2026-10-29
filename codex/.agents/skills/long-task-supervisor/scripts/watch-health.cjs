// Tell Jay when a run's background watch has stopped working (Jay 2026-10-29). Three stalls (10-17 evening, 10-18
// early morning, 10-28 night) were each found hours later, about 18 hours of waiting in all. After 10 minutes without
// a working watch: one push through 「Jay的小秘書」 and a line at the top of the dashboard; when it works again, one
// more push saying nothing needs doing. Model-free. The Codex parent (run-watch.cjs) calls it every minute and the
// system guard (watch-guard.cjs, launchd) every 3 minutes, so a watch whose whole process tree is gone is still
// reported; notify.cjs claim files keep the two callers to one push. Works for Codex and Claude runs alike.
const fs=require('node:fs'),path=require('node:path');
const notify=require('./notify.cjs');
const outageMs=()=>Number(process.env.LONG_TASK_OUTAGE_MS)||10*60000;
const FILE='watch-health.json',DASHBOARD='監督儀表板.md';
const START='<!-- watch-health:start -->',END='<!-- watch-health:end -->';
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const iso=ms=>new Date(ms).toISOString();
function alive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}
// What is wrong with the watch right now, and since when. ended: the run is finished and needs no watch.
function outageOf(run,now=Date.now()){
  const binding=readJson(path.join(run,'binding.json')),state=readJson(path.join(run,'daemon-state.json'));
  if(!binding||!state||fs.existsSync(path.join(run,'STOP'))||['accepted','stopped'].includes(state.phase))return {ended:true,binding,state};
  const base={binding,state};
  if(binding.platform==='claude-code'){
    // A Claude watcher exits on purpose at each handoff ('awaiting_decision'); the supervisor starts the next one.
    if(state.phase==='error')return {...base,kind:'watcher_error',since:Date.parse(state.error?.at)||now,detail:state.error?.message};
    const lock=readJson(path.join(run,'watcher.lock'));
    if(['watching','starting'].includes(state.phase)&&!alive(lock?.pid??state.pid))return {...base,kind:'watcher_dead',since:Date.parse(state.updatedAt)||now};
    return base;
  }
  // Codex: the App-owned parent restarts its child; if the parent itself is gone, nothing outside the App can restart
  // it (2026-10-29: the App tools pipe closes on a process the App did not start), so this is Jay's push.
  const runtime=readJson(path.join(run,'runtime-state.json'));
  if(runtime&&!alive(runtime.pid)){
    const lastSeen=Math.max(Date.parse(runtime.heartbeatAt)||0,Date.parse(runtime.endedAt)||0,Date.parse(runtime.startedAt)||0);
    return {...base,kind:'watcher_dead',since:lastSeen||now,detail:runtime.phase};
  }
  const health=state.appHealth;
  if(health?.failingSince)return {...base,kind:health.kind==='read'?'read_failing':'watcher_error',since:Date.parse(health.failingSince)||now,detail:health.lastError};
  return base;
}
function names(run,{binding,state}){
  const titles=state?.threadTitles||{};
  return {executor:titles.executor||binding?.executorTitle||path.basename(run),supervisor:titles.supervisor||binding?.supervisorTitle||'本任務的監督對話',
    app:binding?.platform==='claude-code'?'Claude':'Codex'};
}
const minutesOf=(now,since)=>Math.max(1,Math.round((now-since)/60000));
const short=text=>String(text||'').replace(/\s+/g,' ').slice(0,80);
function alertText(outage,run,now){
  const n=names(run,outage),m=minutesOf(now,outage.since);
  if(outage.kind==='watcher_dead')return '【開發任務中止，需要開啟查看】『'+n.executor+'』的背景監看已停止約 '+m+' 分鐘，系統無法從 App 外重開。請打開 '+n.app+
    ' 的監督對話『'+n.supervisor+'』，說「繼續」就會重新掛上。';
  if(outage.kind==='read_failing')return '【開發任務中止，需要開啟查看】『'+n.executor+'』的背景監看已 '+m+' 分鐘讀不到執行對話。請打開 '+n.app+' 的監督對話『'+n.supervisor+'』查看。';
  return '【開發任務中止，需要開啟查看】『'+n.executor+'』的背景監看已 '+m+' 分鐘因錯誤停住（'+short(outage.detail)+'）。請打開 '+n.app+' 的監督對話『'+n.supervisor+'』查看。';
}
const KIND_TEXT={watcher_dead:'監看程式已停止，App 外無法自動重開',read_failing:'讀不到執行對話',watcher_error:'監看程式出錯'};
// The dashboard line, kept between markers so the watcher's own rewrite and this check agree on one block.
function banner(run,record=readJson(path.join(run,FILE))){
  const open=record?.open;
  if(!open)return '';
  const pushed=notify.sent(run,open.key);
  const push=pushed?.ok?'已用小秘書推播通知你':pushed?.error?'小秘書推播失敗（'+short(pushed.error)+'），請直接查看監督對話':'推播處理中';
  return START+'\n> **注意：背景監看從 '+new Date(Date.parse(open.since)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})+
    ' 起沒在運作（'+(KIND_TEXT[open.kind]||open.kind)+(open.detail?'：'+short(open.detail):'')+'）。'+push+'。**\n'+END+'\n';
}
function withBanner(body,run){
  const clean=body.replace(new RegExp(START+'[\\s\\S]*?'+END+'\\n?'),'');
  const block=banner(run);
  if(!block)return clean;
  const lines=clean.split('\n');
  return [lines[0],'',block.trimEnd(),...lines.slice(1)].join('\n');
}
function markDashboard(run){
  const file=path.join(run,DASHBOARD);
  if(!fs.existsSync(file))return;
  const body=withBanner(fs.readFileSync(file,'utf8'),run);
  fs.writeFileSync(file+'.tmp',body);fs.renameSync(file+'.tmp',file);
}
async function check(run,{now=Date.now()}={}){
  const outage=outageOf(run,now),file=path.join(run,FILE);
  const record=readJson(file)||{open:null,history:[]};
  let changed=false;
  const close=reason=>{(record.history||=[]).push({...record.open,closedAt:iso(now),closedBy:reason});record.history=record.history.slice(-20);record.open=null;changed=true;};
  if(outage.ended){if(record.open)close('ended');}
  else if(outage.kind&&now-outage.since>=outageMs()){
    // One episode, one push: a change of kind inside the same outage (failing reads, then a dead parent) is not new.
    if(!record.open){record.open={key:'outage-'+outage.since,since:iso(outage.since),detectedAt:iso(now)};changed=true;}
    if(record.open.kind!==outage.kind||record.open.detail!==(outage.detail||null)){record.open.kind=outage.kind;record.open.detail=outage.detail||null;changed=true;}
    if(!notify.sent(run,record.open.key)){await notify.sendOnce(run,record.open.key,alertText(outage,run,now));changed=true;}
  }else if(!outage.kind&&record.open){
    if(notify.sent(run,record.open.key)?.ok)await notify.sendOnce(run,'recovered-'+record.open.key,'【已恢復，不用處理】『'+names(run,outage).executor+'』的背景監看已恢復運作。');
    close('recovered');
  }
  if(changed){fs.writeFileSync(file+'.tmp',JSON.stringify(record,null,2)+'\n');fs.renameSync(file+'.tmp',file);markDashboard(run);}
  return {run,ended:Boolean(outage.ended),outage:outage.kind||null,since:outage.since?iso(outage.since):null,open:record.open};
}
module.exports={check,outageOf,banner,withBanner,alive,FILE};
