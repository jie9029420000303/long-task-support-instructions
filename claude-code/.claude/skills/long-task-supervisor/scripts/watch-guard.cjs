#!/usr/bin/env node
// The system guard (Jay 2026-10-29): a launchd job, not a model and not the App. Every 3 minutes it runs
// watch-health.cjs for every registered run, so Jay hears about a watch that stopped even when the whole watcher
// process tree is gone and nothing inside the run can say so (GDB website line 2026-10-18: the watcher vanished and an
// executor question waited 3 hours). It cannot restart a Codex watcher: the App tools pipe only serves processes the
// App started (2026-10-29 test: "Codex app tools pipe closed"), so the supervisor restarts it at its next turn.
// Runs register themselves when their watcher starts; finished runs, removed directories and test runs under the
// system temp directory drop out of the registry here.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const notify=require('./notify.cjs');
const LABEL='com.long-task-supervisor.watch-guard';
const INTERVAL_SECONDS=180;
const runsDir=()=>path.join(notify.home(),'runs');
const entryFile=run=>path.join(runsDir(),crypto.createHash('sha256').update(path.resolve(run)).digest('hex').slice(0,16)+'.json');
const real=file=>{try{return fs.realpathSync(file);}catch{return path.resolve(file);}};
const temporary=run=>{const tmp=real(os.tmpdir()),dir=real(run);return dir===tmp||dir.startsWith(tmp+path.sep);};
// Test runs live under the system temp directory and never belong in the real registry, unless a test points
// LONG_TASK_HOME at its own registry.
function register(run,info={}){
  if(process.env.LONG_TASK_REGISTER==='0'||(temporary(run)&&!process.env.LONG_TASK_HOME))return null;
  fs.mkdirSync(runsDir(),{recursive:true});
  const file=entryFile(run);
  fs.writeFileSync(file+'.tmp',JSON.stringify({run:path.resolve(run),...info,registeredAt:new Date().toISOString()},null,2)+'\n');
  fs.renameSync(file+'.tmp',file);
  return file;
}
function entries(){
  let names=[];try{names=fs.readdirSync(runsDir()).filter(name=>name.endsWith('.json'));}catch{return [];}
  return names.map(name=>{try{return {file:path.join(runsDir(),name),...JSON.parse(fs.readFileSync(path.join(runsDir(),name),'utf8'))};}catch{return null;}}).filter(Boolean);
}
async function check(){
  const results=[];
  for(const entry of entries()){
    if(!entry.run||!fs.existsSync(path.join(entry.run,'binding.json'))||(temporary(entry.run)&&!process.env.LONG_TASK_HOME)){
      fs.rmSync(entry.file,{force:true});results.push({run:entry.run,removed:'missing'});continue;
    }
    try{
      const result=await require('./watch-health.cjs').check(entry.run);
      if(result.ended)fs.rmSync(entry.file,{force:true});
      results.push(result);
    }catch(error){results.push({run:entry.run,error:error.message});}
  }
  return {at:new Date().toISOString(),runs:results};
}
const plistFile=()=>path.join(os.homedir(),'Library','LaunchAgents',LABEL+'.plist');
const xml=text=>String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function install(){
  fs.mkdirSync(notify.home(),{recursive:true});
  const log=path.join(notify.home(),'watch-guard.log');
  const plist='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'+
    '<key>Label</key><string>'+LABEL+'</string>\n<key>ProgramArguments</key><array><string>'+xml(process.execPath)+'</string><string>'+xml(__filename)+'</string><string>check</string></array>\n'+
    '<key>StartInterval</key><integer>'+INTERVAL_SECONDS+'</integer>\n<key>RunAtLoad</key><true/>\n'+
    '<key>EnvironmentVariables</key><dict><key>LANG</key><string>zh_TW.UTF-8</string><key>LONG_TASK_HOME</key><string>'+xml(notify.home())+'</string></dict>\n'+
    '<key>StandardOutPath</key><string>'+xml(log)+'</string>\n<key>StandardErrorPath</key><string>'+xml(log)+'</string>\n</dict></plist>\n';
  fs.mkdirSync(path.dirname(plistFile()),{recursive:true});
  fs.writeFileSync(plistFile(),plist);
  const domain='gui/'+process.getuid();
  try{execFileSync('launchctl',['bootout',domain+'/'+LABEL],{stdio:'ignore'});}catch{}
  execFileSync('launchctl',['bootstrap',domain,plistFile()],{stdio:'pipe'});
  return {installed:true,label:LABEL,plist:plistFile(),script:__filename,node:process.execPath,everySeconds:INTERVAL_SECONDS,log};
}
function status(){
  let loaded=false;
  try{execFileSync('launchctl',['print','gui/'+process.getuid()+'/'+LABEL],{stdio:'ignore'});loaded=true;}catch{}
  let script=null;try{script=/<string>([^<]*watch-guard\.cjs)<\/string>/.exec(fs.readFileSync(plistFile(),'utf8'))?.[1]||null;}catch{}
  return {label:LABEL,loaded,plist:fs.existsSync(plistFile())?plistFile():null,script,notify:{configured:Boolean(notify.settings()),file:notify.configFile()},
    runs:entries().map(entry=>entry.run)};
}
module.exports={register,entries,check,status,LABEL};
if(require.main===module){
  const [command='check',arg]=process.argv.slice(2);
  (async()=>{
    const result=command==='check'?await check():command==='install'?install():command==='status'?status()
      :command==='register'?{registered:register(path.resolve(arg||''),{manual:true})}
      :(()=>{throw Error('Commands: check, install, status, register RUN');})();
    console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
