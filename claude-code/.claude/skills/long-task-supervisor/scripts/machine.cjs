#!/usr/bin/env node
// This machine's shared limits (Jay 2026-11-16: fix the skills in one pass, then measure). On 2026-11-14 a 16GB
// machine crashed with 42 swap files while three long tasks dispatched on their own; each run knew only its own
// subagents, and the total of 8 that Jay then set was split 4/2/2 by hand, so a waiting run's seats stayed idle.
// Everything here is model-free and reads one local file, <LONG_TASK_HOME or ~/.config/long-task-supervisor>/capacity.json:
//   {"totalAgents":8,"stagger":{"batch":3,"seconds":30},"heavySlots":3,"heavyLongMax":2}
// totalAgents: subagents all supervised runs on this machine may have in flight together. A run's dispatch limit is
//   the smaller of its own limit and what the other runs leave, never below 1; the supervisor's own verification
//   agents are not counted. stagger: marking more than `batch` subagents in flight within `seconds` waits inside
//   dispatch.cjs mark. heavySlots/heavyLongMax: read by the orchestrator's test-run.py.
// A machine without the file, or a key left out, keeps the earlier behaviour: nothing is limited, staggered or queued.
// Nothing here watches the machine (Jay 2026-11-18: "技能裡面要監看資源這件事情完全拔掉，監督任務就是專注目標任務達成，
// 系統的事情不要管"). v1.6.0-v1.8.0 sampled speed, swap, uptime and free disk every minute and put a hint in the
// supervisor's brief; on 2026-11-18 each supervisor then reported the disk on its own, and one of them made up its
// own free-space thresholds, held a step back and sent four clean-up forms. The samples, the hint and the phone
// notice are gone. The fixed limits Jay set, and cleaning up what a task itself started, stay.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const notify=require('./notify.cjs');
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const real=file=>{try{return fs.realpathSync(file);}catch{return path.resolve(file);}};
// Test runs live under the system temp directory and never read or write the real machine files, unless a test
// points LONG_TASK_HOME at its own folder (the same rule as watch-guard.cjs).
const temporary=run=>{const tmp=real(os.tmpdir()),dir=real(run);return (dir===tmp||dir.startsWith(tmp+path.sep))&&!process.env.LONG_TASK_HOME;};
const configFile=()=>path.join(notify.home(),'capacity.json');
function config(){const value=readJson(configFile());return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
const seats=inFlight=>(inFlight||[]).filter(item=>item&&item.handle!=='main'&&!String(item.handle||'').startsWith('resource:')).length;
// A snapshot nobody has written for this long no longer says what is running (a run whose executor died mid-flight
// would otherwise hold seats from every other run for good).
const STALE_MS=6*3600000;
// The other supervised runs registered on this machine and the subagents each has in flight.
function otherRuns(executorId,nowMs=Date.now()){
  const out=[];
  for(const entry of require('./watch-guard.cjs').entries()){
    const binding=readJson(path.join(entry.run,'binding.json'));
    if(!binding||binding.executorId===executorId||fs.existsSync(path.join(entry.run,'STOP')))continue;
    const file=path.join(entry.run,binding.dispatchAudit?.snapshot||'dispatch.json');
    let agents=0;try{if(nowMs-fs.statSync(file).mtimeMs<STALE_MS)agents=seats(readJson(file)?.packages?.inFlight);}catch{}
    out.push({run:entry.run,agents});
  }
  return out;
}
function dispatchLimit(binding,run,own){
  const total=config().totalAgents;
  if(!run||temporary(run)||!Number.isInteger(total)||total<1)return {limit:own};
  const others=otherRuns(binding?.executorId).reduce((sum,item)=>sum+item.agents,0);
  return {limit:Math.min(own,Math.max(1,total-others)),machine:{total,others}};
}
// Staggered starts (2026-11-14 00:46: 34 subagents started at once and the platform refused 11 starts within 13
// minutes). A refill of one or two never waits; with 8 seats the waits add up to at most 60 seconds.
const startsFile=run=>path.join(run,'dispatch-starts.json');
function staggerWait(run,nowMs=Date.now()){
  const rule=config().stagger;
  if(!rule||temporary(run)||!(rule.batch>=1)||!(rule.seconds>0))return 0;
  const recent=(readJson(startsFile(run))||[]).filter(at=>Number.isFinite(at)&&nowMs-at<rule.seconds*1000).sort((a,b)=>a-b);
  return recent.length>=rule.batch?Math.max(0,recent[recent.length-rule.batch]+rule.seconds*1000-nowMs):0;
}
function recordStart(run,nowMs=Date.now()){
  if(!config().stagger||temporary(run))return;
  const starts=[...(readJson(startsFile(run))||[]).filter(Number.isFinite),nowMs].slice(-20);
  fs.writeFileSync(startsFile(run)+'.tmp',JSON.stringify(starts));fs.renameSync(startsFile(run)+'.tmp',startsFile(run));
}
// The skill's own logs only grow; keep the current file and one earlier one.
function rotate(file,maxBytes=5*1024*1024){
  try{if(fs.statSync(file).size>maxBytes){fs.renameSync(file,file+'.1');return true;}}catch{}
  return false;
}
function status(){
  const runs=otherRuns(null);
  return {configFile:configFile(),config:config(),runs,agentsInFlight:runs.reduce((sum,item)=>sum+item.agents,0)};
}
module.exports={config,configFile,otherRuns,dispatchLimit,staggerWait,recordStart,rotate,status,temporary};
if(require.main===module){
  const [command='status']=process.argv.slice(2);
  try{
    if(command==='status')console.log(JSON.stringify(status(),null,2));
    else throw Error('Commands: status (limits and the subagents each registered run has in flight)');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
