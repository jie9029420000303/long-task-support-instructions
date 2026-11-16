#!/usr/bin/env node
// This machine's shared limits and health samples (Jay 2026-11-16: fix the skills in one pass, then measure). On
// 2026-11-14 a 16GB machine crashed with 42 swap files while three long tasks dispatched on their own; each run knew
// only its own subagents, and the total of 8 that Jay then set was split 4/2/2 by hand, so a waiting run's seats stayed
// idle. Nothing recorded how the machine was doing in the hours before the crash.
// Everything here is model-free and reads one local file, <LONG_TASK_HOME or ~/.config/long-task-supervisor>/capacity.json:
//   {"totalAgents":8,"stagger":{"batch":3,"seconds":30},"heavySlots":3,"heavyLongMax":2}
// totalAgents: subagents all supervised runs on this machine may have in flight together. A run's dispatch limit is
//   the smaller of its own limit and what the other runs leave, never below 1; the supervisor's own verification
//   agents are not counted. stagger: marking more than `batch` subagents in flight within `seconds` waits inside
//   dispatch.cjs mark. heavySlots/heavyLongMax: read by the orchestrator's test-run.py.
// A machine without the file, or a key left out, keeps the earlier behaviour: nothing is limited, staggered or queued.
// Samples only record. Whether the machine is slow (2026-11-14 measured: a trivial command took 2 ms healthy and
// 1.7-6.0 s stuck; local routing 11-150 ms healthy and 225-2,161 ms stuck) is written to each sample and limits nothing.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
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
const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
function trivialCommandMs(){
  const times=[];
  for(let i=0;i<5;i++){const began=process.hrtime.bigint();spawnSync('/bin/cat',['/dev/null'],{stdio:'ignore',timeout:30000});times.push(Number(process.hrtime.bigint()-began)/1e6);}
  return Math.round(median(times)*10)/10;
}
// Local routing delay of the last 10 minutes, from the tail of opencodex's usage log (request received to route decided).
function routeDelay(nowMs){
  const file=process.env.LONG_TASK_USAGE_LOG||path.join(os.homedir(),'.opencodex','usage.jsonl');
  let fd;
  try{
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,length=Math.min(size,2*1024*1024),buffer=Buffer.alloc(length);
    fs.readSync(fd,buffer,0,length,size-length);
    const delays=[];
    for(const line of buffer.toString('utf8').split('\n')){
      let entry;try{entry=JSON.parse(line);}catch{continue;}
      const at=entry.timestamp,decided=entry.routeDecision?.createdAt;
      if(Number.isFinite(at)&&Number.isFinite(decided)&&nowMs-at<=10*60000)delays.push(decided-at);
    }
    return {requests:delays.length,medianMs:median(delays)};
  }catch{return {requests:0,medianMs:null};}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function googleDrive(){
  const out=spawnSync('/bin/ps',['-axo','pcpu=,rss=,comm='],{encoding:'utf8',timeout:30000}).stdout||'';
  let cpu=0,rss=0,found=false;
  for(const line of out.split('\n')){const match=/^\s*([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);if(match&&match[3].includes('Google Drive')){found=true;cpu+=Number(match[1]);rss+=Number(match[2]);}}
  return found?{cpuPercent:Math.round(cpu*10)/10,rssMb:Math.round(rss/1024)}:null;
}
const SAMPLE_GAP_MS=50000,KEEP_DAYS=30;
const sampleFile=(at=new Date())=>path.join(notify.home(),'samples','machine-'+new Date(at.getTime()-at.getTimezoneOffset()*60000).toISOString().slice(0,10)+'.jsonl');
function latest(){
  try{const lines=fs.readFileSync(sampleFile(),'utf8').trim().split('\n');return JSON.parse(lines[lines.length-1]);}catch{return null;}
}
// For the supervisor's brief: the latest sample, only when it is recent and says the machine is slow or due a restart.
// The supervisor tells Jay once at a safe point (nothing in flight); it never restarts, stops or delays anything itself.
function hint(run,nowMs=Date.now()){
  if(!run||temporary(run))return null;
  const last=latest();
  if(!last||!(last.slow||last.restartHint)||nowMs-Date.parse(last.at)>15*60000)return null;
  return {at:last.at,slow:last.slow,restartHint:last.restartHint,commandMs:last.commandMs,routeMedianMs:last.route?.medianMs??null,swapFiles:last.swapFiles,uptimeDays:last.uptimeDays};
}
// One line per call, at most one a minute however many callers there are. Records only; nothing reads it to limit work.
function sample(nowMs=Date.now()){
  const file=sampleFile(new Date(nowMs));
  try{if(nowMs-fs.statSync(file).mtimeMs<SAMPLE_GAP_MS)return null;}catch{}
  const settings=config(),darwin=process.platform==='darwin';
  let swapFiles=null;try{if(darwin)swapFiles=fs.readdirSync('/System/Volumes/VM').filter(name=>name.startsWith('swapfile')).length;}catch{}
  const level=darwin?Number.parseInt(spawnSync('/usr/sbin/sysctl',['-n','kern.memorystatus_vm_pressure_level'],{encoding:'utf8',timeout:10000}).stdout,10):NaN;
  let heavy=null;try{heavy=fs.readdirSync(path.join(notify.home(),'heavy-slots')).filter(name=>name.endsWith('.json')).length;}catch{}
  const commandMs=trivialCommandMs(),route=routeDelay(nowMs),uptimeDays=Math.round(os.uptime()/864)/100;
  const entry={at:new Date(nowMs).toISOString(),commandMs,route,swapFiles,pressureLevel:Number.isFinite(level)?level:null,uptimeDays,
    agentsInFlight:otherRuns(null,nowMs).reduce((sum,item)=>sum+item.agents,0),heavySlotsHeld:heavy,googleDrive:darwin?googleDrive():null,
    slow:commandMs>=(settings.slowCommandMs||500)||(route.medianMs??0)>=(settings.slowRouteMs||200),
    restartHint:(swapFiles??0)>=(settings.restartSwapFiles||32)||uptimeDays>=(settings.restartUptimeDays||3)};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.appendFileSync(file,JSON.stringify(entry)+'\n');
  const cutoff=path.basename(sampleFile(new Date(nowMs-KEEP_DAYS*86400000)));
  for(const name of fs.readdirSync(path.dirname(file)))if(/^machine-\d{4}-\d\d-\d\d\.jsonl$/.test(name)&&name<cutoff)fs.rmSync(path.join(path.dirname(file),name),{force:true});
  return entry;
}
// The skill's own logs only grow; keep the current file and one earlier one.
function rotate(file,maxBytes=5*1024*1024){
  try{if(fs.statSync(file).size>maxBytes){fs.renameSync(file,file+'.1');return true;}}catch{}
  return false;
}
function status(){
  const runs=otherRuns(null);
  return {configFile:configFile(),config:config(),runs,agentsInFlight:runs.reduce((sum,item)=>sum+item.agents,0),latestSample:latest()};
}
module.exports={config,configFile,otherRuns,dispatchLimit,staggerWait,recordStart,sample,latest,hint,rotate,status,temporary};
if(require.main===module){
  const [command='status']=process.argv.slice(2);
  try{
    if(command==='status')console.log(JSON.stringify(status(),null,2));
    else if(command==='sample')console.log(JSON.stringify(sample()||latest()));
    else throw Error('Commands: status (limits, runs and the latest sample), sample (record one now)');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
