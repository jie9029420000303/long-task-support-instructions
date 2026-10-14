#!/usr/bin/env node
// Keep the supervisor chat loaded for the whole run: start once in the supervisor's background Bash, beside the watcher.
// The App's memory governor pauses a desktop chat that has no model turn and no background command running, and ends
// its process (main.log `CliGovernor ... pressure evicting`, `Pausing session (governor_evict)`). The watcher has to
// exit for its completion notice to wake the supervisor, and that exit leaves the chat exactly that idle: 2026-10-07,
// 10-13 twice and 10-14 the supervisor was paused within seconds of a watcher exit, before the notice started a model
// turn (up to 4.8 h lost), while main.log skipped every pause with `1 active background task(s)`. This command lives
// for the whole run, calls no model and never writes run state, so the chat is not idle when the watcher hands off.
// It is a separate script so that clearing stray watchers by name never ends it.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {ownerAlive}=require('./handoff-lib.cjs');
const SCRIPT='claude-hold.cjs';
// Poll every 10 s: after acceptance or STOP the hold ends while the supervisor still writes its report. A run folder
// on a synced drive can fail a read for a while; only 5 minutes of failed reads end the hold, with an error.
const HOLD_POLL_MS=10000,HOLD_ERROR_MS=5*60*1000;
const holdFile=run=>path.join(run,'hold.json');
// A live hold: hold.json names a running process whose command is this script; a reused PID is not a hold.
function holdAlive(run,owner){
  try{owner??=JSON.parse(fs.readFileSync(holdFile(run),'utf8'));}catch{return false;}
  if(!Number.isInteger(owner?.pid)||!ownerAlive(owner.pid))return false;
  try{return execFileSync('ps',['-ww','-o','command=','-p',String(owner.pid)],{encoding:'utf8'}).includes(SCRIPT);}catch{return false;}
}
module.exports={holdAlive,SCRIPT};
if(require.main===module){
  const run=path.resolve(process.argv[2]||'');
  const say=(tag,value)=>console.log(tag+' '+JSON.stringify(value));
  const mine=()=>{try{return JSON.parse(fs.readFileSync(holdFile(run),'utf8')).pid===process.pid;}catch{return false;}};
  const release=()=>{if(mine())try{fs.unlinkSync(holdFile(run));}catch{}};
  // Claim hold.json with wx as watcher.lock does; a stale claim (dead or reused PID, or a file left unreadable) is
  // cleared first. Returns the live owner's PID when another hold already keeps this chat loaded.
  function claim(){
    for(let attempt=0;attempt<3;attempt++){
      try{fs.writeFileSync(holdFile(run),JSON.stringify({pid:process.pid,run,at:new Date().toISOString()})+'\n',{flag:'wx'});return null;}
      catch(error){if(error.code!=='EEXIST')throw error;}
      let owner=null;try{owner=JSON.parse(fs.readFileSync(holdFile(run),'utf8'));}catch(error){if(error.code==='ENOENT')continue;if(error.code)throw error;}
      if(owner?.pid===process.pid)return null;
      if(owner&&holdAlive(run,owner))return owner.pid;
      try{fs.unlinkSync(holdFile(run));}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    throw Error('Cannot claim '+holdFile(run));
  }
  (async()=>{
    let failingSince=null;
    for(;;){
      try{
        // Only a run folder that no longer exists is gone; any other failed read is retried.
        try{fs.statSync(run);}catch(error){if(error.code==='ENOENT'){say('LONG_TASK_HOLD_END',{run,phase:'gone'});return;}throw error;}
        const owner=claim();
        if(owner){say('LONG_TASK_HOLD_ALREADY',{run,pid:owner});return;}
        const phase=fs.existsSync(path.join(run,'STOP'))?'stopped':JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'),'utf8')).phase;
        if(['accepted','stopped'].includes(phase)){release();say('LONG_TASK_HOLD_END',{run,phase});return;}
        failingSince=null;
      }catch(error){
        failingSince??=Date.now();
        if(Date.now()-failingSince>=HOLD_ERROR_MS){
          release();
          console.error('LONG_TASK_HOLD_ERROR '+JSON.stringify({run,since:new Date(failingSince).toISOString(),error:error.message}));
          process.exitCode=1;return;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,HOLD_POLL_MS));
    }
  })();
}
