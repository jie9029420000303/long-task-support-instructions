#!/usr/bin/env node
// A resident, model-free bridge for one bound executor and one supervisor.
const fs = require('node:fs');
const checkedWait = require('./checked-wait.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('./mcp-client.cjs');
const { hash, read, need, validateContract, validateDecision, quietReview, PROGRESS_REVIEW_MS } = require('./guard.cjs');
const clock = require('./supervisor-clock.cjs');
const fallback = require('./model-fallback.cjs');
const probes = require('./route-probe.cjs');
const quota = require('./claude-quota.cjs');
const catalog = require('./model-catalog.cjs');
const dashboard = require('./dashboard.cjs');
const pace = require('./pace.cjs');
const executionWake = require('./execution-wake.cjs');
const questions = require('./pending-decisions.cjs');
const rework = require('./rework.cjs');
const notify = require('./notify.cjs');
const { inspect:inspectDispatch, eventFor:dispatchEvent, markAnnounced, releaseAnnounced, stillCurrent, hold:holdDispatch } = require('./dispatch-audit.cjs');
const { activityMarker, supervisorPollFromThread, observeActivity, due:progressDue, eventFor:progressEvent } = require('./progress-review.cjs');
const run = path.resolve(process.argv[2] || '');
const binding = read(path.join(run, 'binding.json'));
const statePath = path.join(run, 'daemon-state.json');
const contractPath = path.join(run, 'contract.json');
const lockPath = path.join(run, 'watcher.lock');
// Authorizations reach the effective contract through this running watcher (2026-11-09: WEB's supervisor stopped the
// watcher to record one at 23:14, hit its usage limit six seconds later, and the run stayed unwatched until 01:01).
// supervise.cjs amend leaves the request here; the watcher records it at a safe point and writes the result.
const AMEND_REQUEST = path.join(run, 'amend-request.json'), AMEND_RESULTS = path.join(run, 'amend-results');
let state = read(statePath), ownsLock = false, lastMentionCheck = 0;
const client = createClient({nodePath:process.execPath});
const meta = {'x-codex-turn-metadata':{thread_id:binding.supervisorId,turn_id:binding.callerTurnId}};
const SUPERVISOR_WAKE_MS = Number(process.env.CODEX_SUPERVISOR_WAKE_MS) || 45000;
const DECISION_POLL_MS = Number(process.env.CODEX_SUPERVISOR_DECISION_POLL_MS) || 15000;
// The executor is read every 3 minutes (Jay 2026-10-29: 「拉長成180秒好了」). A read is a local program call, no model
// and no tokens; an executor event is noticed at most 3 minutes late.
const WATCH_IDLE_SLEEP_MS = Number(process.env.CODEX_WATCH_IDLE_SLEEP_MS) || 180000;
// After 10 minutes without a working watch the supervisor gets one warning and Jay one push (Jay 2026-10-29).
const OUTAGE_MS = Number(process.env.LONG_TASK_OUTAGE_MS) || 10 * 60000;
const WAIT_MINUTE_MS = Number(process.env.CODEX_WAIT_MINUTE_MS) || 60000;
// A delivery queued behind a running turn no longer holds the whole watcher (2026-11-21 review): after 10 minutes it
// stays queued in the target's own message queue and is confirmed later, so rate limits and other events still run.
const BUSY_LIMIT_MS = Number(process.env.LONG_TASK_BUSY_LIMIT_MS) || 10 * 60000;
const SWITCH_RESENDS = 3;
// A quota reading younger than this counts as fresh for a switch; an older one is read again before the switch.
const QUOTA_FRESH_MS = 60000;
// The App unloads a chat idle for about three hours and ends the processes it started, this watcher included
// (2026-10-12: research chat idle 02:16→05:33, both watchers gone; every chat in the log unloaded after ~3h idle).
// After 150 idle minutes the watcher sends its host, the supervisor chat, one short turn to stay loaded.
const KEEPALIVE_MS = Number(process.env.CODEX_KEEPALIVE_MS) || 150 * 60000;
const KEEPALIVE_TEXT = 'LONG_TASK_KEEPALIVE：背景監看掛在本對話，閒置約 3 小時 App 會卸載本對話並終止監看。這則只為保持載入：不讀資料、不做處理、不回覆使用者，用一句話結束回合即可。';
const watchStartedAt = Date.now();
const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function save(file, object) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(object, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function checkpoint() { state.updatedAt = now(); save(statePath, state); }
function unpack(result) {
  if (result.isError) throw Error(JSON.stringify(result));
  const block = result.content && result.content.find(item => item.type === 'text');
  return block ? JSON.parse(block.text) : result;
}
// The App bridge has returned this error both with and without the "MCP error -32000: " prefix (2026-10-29: only the
// bare text, so the old read_thread fallback never engaged and the run reconnected for 9 hours). Match either form.
const isAppToolFailure=error=>error?.code===-32000&&String(error.message||'').replace(/^MCP error -32000: /,'')==='Codex app tool request failed';
// A read is safe to repeat; one transient bridge failure stopped a live run for 35 minutes (2026-10-11 equity
// re-review). Sends are never retried here: a repeated send needs receipt reconciliation, not a blind resend.
const READ_RETRY_MS=[2000,5000,15000];
// A read_thread over the bridge size limit fails every time with the same arguments (2026-10-19 V32: the executor's
// last 8 turns at 20000 chars per item no longer fit, and the watcher stopped after 3 hours of reconnects). Shrink the
// read instead: fewer turns first, then shorter items. Callers only scan recent turns, so a smaller window is safe.
// The App words this reply two ways and both are in use at the same time (2026-11-14 measured; the second is not a
// replacement that arrived with one App version): "Tool response exceeds the size limit ... A single oversized turn
// cannot be returned by this tool" and "Thread history exceeds the read size limit. Try fewer turns. A single
// oversized turn cannot be read by this tool" (2026-11-13 OPS: only the first was matched, so neither the smaller
// read nor the rollout read engaged and the watcher restarted every 10 to 40 seconds from 16:45 Taipei). Match both.
const SIZE_LIMIT=/exceeds the (?:read )?size limit|oversized turn cannot be/i;
function smallerRead(args){
  if((args.turnLimit||1)>1)return {...args,turnLimit:Math.max(1,Math.floor(args.turnLimit/2))};
  if((args.maxOutputCharsPerItem||500)>500)return {...args,maxOutputCharsPerItem:Math.max(500,Math.floor(args.maxOutputCharsPerItem/4))};
  return null;
}
// Even 1 turn at 500 characters can be too large: the App cannot return a single oversized turn (2026-11-09 OPS: one
// executor turn from 21:44 to 04:03 restarted the watcher 11 times, and the read kept failing after the turn ended
// until a new one began). The thread's own rollout on this Mac holds the same turns: read them there, at the size first
// asked for, so a final answer keeps its event line.
function rolloutRead(args){
  let turns=[];
  try{const file=pace.sessionFile(args.threadId);if(file)turns=require('./rollout-turns.cjs').recent(file,args);}catch{}
  if(!turns.length)return null;
  (state.rolloutReads||=[]).push({threadId:args.threadId,turnLimit:args.turnLimit||1,latestTurn:turns[0].id,at:now()});
  if(state.rolloutReads.length>20)state.rolloutReads.splice(0,state.rolloutReads.length-20);
  return {content:[{type:'text',text:JSON.stringify({thread:{id:args.threadId,status:{type:turns[0].status==='inProgress'?'active':'idle'}},turns,source:'local rollout'})}]};
}
// Whether the watch works, kept across restarts in daemon-state: watch-health.cjs (the parent each minute, the system
// guard every 3 minutes) pushes Jay after 10 minutes. Only a successful read of the bound executor counts as working;
// a send that gets through while reads fail does not end the outage.
function appOk(){
  const health=state.appHealth||={};
  health.lastOkAt=now();
  if(!health.failingSince)return;
  if(health.warnedFor===health.failingSince&&health.warnedOk)health.recoveryNotice=health.failingSince;
  (health.history||=[]).push({since:health.failingSince,until:now(),kind:health.kind,lastError:health.lastError});
  if(health.history.length>10)health.history.splice(0,health.history.length-10);
  delete health.failingSince;delete health.kind;delete health.lastError;
  checkpoint();
}
function appFailing(kind,message){
  const health=state.appHealth||={};
  if(!health.failingSince){health.failingSince=now();health.kind=kind;}
  health.lastError=String(message||'').slice(0,300);
  checkpoint();
}
async function rpc(name, args, timeout = 75000) {
  const asked=args;
  for(let attempt=0;;attempt++){
    const response = await client.request('tools/call',{name,arguments:args,_meta:meta},timeout);
    if (!(response.error || response.result?.isError)) {
      if(name==='read_thread'&&args.threadId===binding.executorId)appOk();
      return response.result;
    }
    const oversized=name==='read_thread'&&response.result?.isError&&SIZE_LIMIT.test(JSON.stringify(response.result));
    const smaller=oversized?smallerRead(args):null;
    if(smaller){
      (state.readShrinks||=[]).push({from:{turnLimit:args.turnLimit,maxOutputCharsPerItem:args.maxOutputCharsPerItem},to:{turnLimit:smaller.turnLimit,maxOutputCharsPerItem:smaller.maxOutputCharsPerItem},at:now()});
      if(state.readShrinks.length>20)state.readShrinks.splice(0,state.readShrinks.length-20);
      args=smaller;attempt--;continue;
    }
    const local=oversized?rolloutRead(asked):null;
    if(local){if(asked.threadId===binding.executorId)appOk();return local;}
    const transient=name==='read_thread'&&isAppToolFailure(response.error);
    if(transient&&attempt<READ_RETRY_MS.length){
      (state.readRetries||=[]).push({tool:name,attempt:attempt+1,at:now()});if(state.readRetries.length>20)state.readRetries.splice(0,state.readRetries.length-20);
      await sleep(Number(process.env.LONG_TASK_READ_RETRY_MS)||READ_RETRY_MS[attempt]);continue;
    }
    const error=Error(name + ': ' + JSON.stringify(response.error || response.result));
    error.rpcError=response.error;appFailing('read',error.message);throw error;
  }
}
// Every executor read goes through read_thread. wait_threads belongs to the supervisor's live turn: once that turn
// ends the App answers it with "Codex app tool request failed" (App log 2026-10-28 23:11, the call handed to a hidden
// window), and when that error text changed the run reconnected for 9 hours. read_thread keeps working between turns.
async function waitExecutor() {
  markExecutorLog();
  const detail=unpack(await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
  need(detail.thread?.id===binding.executorId,'Bound executor missing from read');
  return {polls:[{thread:detail.thread,...supervisorPollFromThread(detail)}]};
}
// The executor's own rollout records every finished turn. Seeing one ends the wait between reads, so a stopped main
// line reaches its next owner within seconds; the 3-minute read stays the fallback (Jay 2026-11-08: 主線寫明下一步就直接續做，
// 其他所有停下一律立刻交監督; WEB 20:57: 180 of a 659-second stop were only the read interval). Only new bytes are scanned.
const TURN_END=/"type":"(?:task_complete|turn_aborted)"/,TURN_SCAN_MAX=16*1024*1024;
const IDLE_SLICE_MS=Number(process.env.CODEX_IDLE_SLICE_MS)||5000;
// The App can show the finished turn a moment after its rollout closes it: read again every 2 seconds, up to 5 times,
// with the clock checked each time, so a turn the platform failed also reaches the supervisor at once.
const TURN_END_REREADS=5,TURN_END_REREAD_MS=Number(process.env.CODEX_TURN_END_REREAD_MS)||2000;
let turnLog=null,turnOffset=0,turnTail='',turnEndReads=0;
function markExecutorLog(){
  turnLog=state.executorLog||null;turnOffset=0;turnTail='';
  if(turnLog)try{turnOffset=fs.statSync(turnLog).size;}catch{turnLog=null;}
}
function executorTurnEnded(){
  if(!state.executorLog)return false;
  if(turnLog!==state.executorLog){markExecutorLog();return false;}
  let size;try{size=fs.statSync(turnLog).size;}catch{return false;}
  if(size<turnOffset){markExecutorLog();return false;}
  if(size===turnOffset)return false;
  const start=Math.max(turnOffset,size-TURN_SCAN_MAX),buffer=Buffer.alloc(size-start);let fd;
  try{fd=fs.openSync(turnLog,'r');fs.readSync(fd,buffer,0,buffer.length,start);}catch{return false;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  turnOffset=size;
  const text=turnTail+buffer.toString('utf8'),ended=TURN_END.test(text);
  turnTail=ended?'':text.slice(-64);
  return ended;
}
// The 3 minutes between reads still end at once on STOP, and the dashboard stays current.
async function idle(ms){
  const end=Date.now()+ms;
  while(Date.now()<end&&!fs.existsSync(path.join(run,'STOP'))&&!amendWaiting()){
    writeDashboard();
    const changed=await executionWake.waitChange(Math.min(IDLE_SLICE_MS,end-Date.now()),()=>{
      if(amendWaiting())return {ready:[{kind:'amend'}],files:[]};
      const result=completionNow();
      return isPaused()||state.executorStatus==='active'||state.executionWakeDeferred?{...result,ready:[]}:result;
    },[path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),path.join(run,'STOP'),AMEND_REQUEST]);
    if(changed==='completion')return;
    // Give the App a moment to report the turn its rollout just closed.
    if(executorTurnEnded()){turnEndReads=TURN_END_REREADS;await sleep(1000);return;}
  }
}
function completionNow(wait=state.progressWait){
  let snapshot=null;try{snapshot=read(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'));}catch{}
  return executionWake.inspect(binding,wait,snapshot,pace.agentRuns(binding),state.executionWakeReceipts||{});
}
async function resumeExecution(inspection){
  if(isPaused()||!state.progressWait&&!inspection.ready.length)return false;
  let wait=state.progressWait||{event:state.executionContinuation?{id:state.executionContinuation.eventId}:{
    id:'execution-'+require('node:crypto').createHash('sha256').update(JSON.stringify(inspection.ready.map(item=>item.key))).digest('hex').slice(0,24),
    nextAction:'收回這次已交回的成果與程序結果，核對原始證據，再依目前工作包整合、修正或續派。'}};
  // Read the current owner before sending: a newer question, submission, or an already active main line wins.
  const detail=unpack(await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
  need(detail.thread?.id===binding.executorId,'Bound executor missing from execution resume read');
  const latest=detail.turns?.[0];state.executorStatus=detail.thread?.status?.type;
  const eligible=inspection.ready.filter(item=>item.kind==='agent' && state.workerHandoff?.workers.includes(item.id));
  const finishingHandoff=latest?.status==='failed' && latest.id===state.workerHandoff?.turnId && eligible.length;
  if(finishingHandoff){
    inspection={...inspection,ready:eligible};
    wait={event:{id:state.executionContinuation?.eventId||'handoff-'+require('node:crypto').createHash('sha256').update(eligible.map(s=>s.key).sort().join(',')).digest('hex').slice(0,32),
      nextAction:'用 read_thread 讀指定子代理的原交付及工作包結果檔，核對證據再 collect。'}};
  }
  const key='continue-'+wait.event.id;
  if(!latest||state.executorStatus==='active'||!finishingHandoff&&(latest.status!=='completed'||latest.id!==wait.event.id&&!state.seen.includes(latest.id))){
    state.executionWakeDeferred=latest?.id||'unknown';return false;
  }
  delete state.executionWakeDeferred;
  checkSources();
  if(fs.existsSync(path.join(run,'STOP'))||isPaused())return false;
  const pending=state.executionContinuation||{eventId:wait.event.id,key,prompt:executionWake.prompt(wait.event,inspection),sources:inspection.ready};
  need(pending.eventId===wait.event.id,'Another execution continuation needs receipt reconciliation');
  state.executionContinuation=pending;checkpoint();
  await sendAndRead(binding.executorId,pending.prompt,pending.key);
  for(const source of pending.sources)(state.executionWakeReceipts||={})[source.key]={eventId:wait.event.id,packageId:source.packageId,
    deliveryKey:pending.key,deliveredAt:now()};
  // A receipt proves delivery, not successful work. The existing dispatch/clock checks still verify actual progress.
  state.progressWait=null;state.executionContinuation=null;checkpoint();return true;
}
// One warning in the supervisor chat per outage, when the App still takes a message (a read can fail while sends work).
// It is marked before sending, so a lost reply never repeats it; Jay's push comes from watch-health.cjs either way.
async function warnSupervisor(){
  const health=state.appHealth;
  if(!health?.failingSince||health.warnedFor===health.failingSince||Date.now()-Date.parse(health.failingSince)<OUTAGE_MS)return;
  health.warnedFor=health.failingSince;health.warnedOk=false;checkpoint();
  const minutes=Math.round((Date.now()-Date.parse(health.failingSince))/60000);
  const prompt='LONG_TASK_WATCH_ALERT：背景監看已 '+minutes+' 分鐘沒在運作（最後錯誤：'+String(health.lastError||'').slice(0,160)+'）。背景程式仍在自動重試，並另外用小秘書推播通知使用者。'+
    '請跑 node '+path.join(__dirname,'supervise.cjs')+' status '+run+'：active 為 true 就用一句話結束回合；不是就依 runtime「監看中斷」處理完再結束回合。';
  try{await rpc('send_message_to_thread',{threadId:binding.supervisorId,prompt},20000);health.warnedOk=true;}
  catch(error){health.warnError=String(error.message).slice(0,200);}
  checkpoint();
}
function contains(value, needle) {
  if (typeof value === 'string') {
    if (value.includes(needle)) return true;
    try { return contains(JSON.parse(value), needle); } catch { return false; }
  }
  return Boolean(value && typeof value === 'object' && Object.values(value).some(item => contains(item, needle)));
}
function checkSources() {
  need(hash(contractPath) === binding.contractSha256, 'Locked contract changed');
  return validateContract(require('./contract-state.cjs').effective(run,binding), {run, binding});
}
function lock() {
  need(!fs.existsSync(path.join(run,'contract-update.lock')),'Contract update is in progress');
  if (fs.existsSync(lockPath)) {
    const old = read(lockPath);
    const alive = require('./process-probe.cjs').probe(old.pid);
    need(alive === false, 'Another watcher owns this executor or its PID cannot be verified');
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({pid:process.pid,run,at:now(),decisionProtocol:'explicit-decision-v1'}),{flag:'wx'});
  ownsLock = true;
}
function markSent(target, key) {
  if (!state.messages.some(item => item.key === key)) state.messages.push({target,key,at:now()});
  state.inflight = null;
  checkpoint();
}
function deliveryMarker(key) {return 'LONG_TASK_DELIVERY:' + key;}
// Every message to the executor ends with the push to dispatch at full speed (Jay 2026-11-09), with one reminder about
// subagents that ran above the skill default since the last one, and with the Taipei time it was sent (2026-11-10).
// Only the sent text carries them: receipts, saved deliveries and their hashes keep the bare prompt, so a delivery
// saved before an upgrade still matches.
function outgoing(target,prompt,key=''){
  if(target!==binding.executorId||isPaused())return prompt;
  let reminder='';
  const selected=state.inflight?.route?.model||state.executorSettings?.model;
  if(require('./openrouter-route.cjs').choices.some(route=>route.model===selected)){
    reminder='\n目前執行路線為 '+selected+'。新派子代理明確指定同一完整模型 ID、max 推論與獨立上下文。既有其他模型的代理從原包讀交付檔與原件，無須再向它發訊核對。';
  }else{
    try{
      const workers=pace.agentRuns(binding).filter(agent=>!require('./openrouter-route.cjs').choices.some(route=>route.model===agent.model&&agent.effort==='max'));
      const found=executionWake.modelReminder(workers,{mainModel:selected,reported:state.modelReminded||[]});
      if(found){reminder='\n\n'+found.text;state.modelReminded=[...(state.modelReminded||[]),...found.ids].slice(-500);}
    }catch{}
  }
  if(key.startsWith('answer-') && state.pending?.kind==='submission'){
    const decision=require('./decision-commit.cjs').readSnapshot(run,state.pending.id)?.decision;
    if(decision?.packageRulings)prompt+='\n當輪以 dispatch.cjs collect 登記本次裁決，讀回各包剩餘條文後再推進。'+
      JSON.stringify({ruling:{eventId:state.pending.id,revision:state.pending.revision},packageRulings:decision.packageRulings});
  }
  return prompt+'\n\n'+executionWake.EXECUTOR_PUSH+reminder+'\n'+executionWake.sentLine();
}
function assistantMarker(detail) {
  for (const turn of detail.turns || []) {
    const message=(turn.items || []).filter(item=>item.type==='agentMessage').at(-1);
    if(message)return JSON.stringify([turn.id,message.id || null,require('node:crypto').createHash('sha256').update(message.text || '').digest('hex')]);
  }
  return null;
}
// Every segment of the target thread counts: after compaction a delivery can sit in an earlier or later file.
// No local file is not a receipt failure; reconcile then reads the thread through the App instead.
function localReceipt(target, key) {
  const result=require('./pace.cjs').markerIn(target,deliveryMarker(key));
  if(!result.files)state.receiptLookup={target,key,files:0,note:'No local rollout for this thread; confirming through read_thread',at:now()};
  return result.found;
}
// A message sent while the target runs a turn is queued, and an interrupted turn drops it (2026-10-11 GDB: an event
// sent at 22:07 never reached the supervisor and the watcher restarted every 30 seconds for half an hour). Resend
// once, only with proof it was not taken in: the target has local rollouts, it is idle, a turn finished after the
// send, and no segment holds the delivery marker. Without that proof the delivery stays uncertain as before.
async function provenLost(delivery) {
  if (delivery.resentAt) return false;
  const pace=require('./pace.cjs');
  if (!pace.sessionFiles(delivery.target).length) return false;
  const detail=unpack(await rpc('read_thread',{threadId:delivery.target,turnLimit:3,includeOutputs:false,maxOutputCharsPerItem:500}));
  const sentAt=Date.parse(delivery.at)/1000;
  // Any chat that is not running a turn has taken in or dropped the message; a turn that ended in an error leaves it
  // in systemError, not idle (2026-11-25 工區 E 11:59: an answer queued behind a turn Jay stopped was judged
  // uncertain and the watcher stopped, model switching with it).
  if (detail.thread?.status?.type==='active' || !(detail.turns||[]).some(turn=>Number(turn.completedAt)>sentAt)) return false;
  return !pace.markerIn(delivery.target,deliveryMarker(delivery.key)).found;
}
// A message sent while the target runs a turn waits in its queue until that turn ends; that is not an uncertain
// delivery (2026-10-11: A's watcher restarted three times and GDB's once for messages queued behind a busy supervisor).
async function targetBusy(target) {
  try {
    const detail=unpack(await rpc('read_thread',{threadId:target,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200}));
    return detail.thread?.status?.type==='active';
  } catch { return false; }
}
async function reconcile(delivery) {
  for (;;) {
  for (let attempt = 0; attempt < 8; attempt++) {
    need(!fs.existsSync(path.join(run,'STOP')),'Run stopped');
    // The local session transcript is the smallest and most reliable receipt on
    // this host. Check it before asking read_thread for a potentially large turn;
    // otherwise a tool-heavy executor turn can time out even though delivery was
    // already durably recorded.
    let confirmed = localReceipt(delivery.target,delivery.key);
    if (!confirmed) {
      const readback = await rpc('read_thread',{
        threadId:delivery.target,turnLimit:2,includeOutputs:false,maxOutputCharsPerItem:4000
      });
      confirmed = contains(readback, deliveryMarker(delivery.key));
    }
    save(path.join(run,'receipt-' + delivery.key + '.json'),{
      target:delivery.target,key:delivery.key,promptSha256:require('node:crypto').createHash('sha256').update(delivery.prompt).digest('hex'),
      sent:delivery.sent || null,confirmed,at:now()
    });
    if (confirmed) { markSent(delivery.target, delivery.key); return; }
    await sleep(Number(process.env.LONG_TASK_RECEIPT_RETRY_MS)||2000);
  }
  if (!(await targetBusy(delivery.target))) break;
  if (!delivery.busySince) { delivery.busySince = now(); delivery.phase = 'queued-behind-running-turn'; checkpoint(); }
  // The message waits in the target's own queue; confirm it later instead of holding every other check.
  if (Date.now() - Date.parse(delivery.busySince) >= BUSY_LIMIT_MS && state.inflight === delivery) {
    (state.queuedDeliveries ||= {})[delivery.key] = {...delivery, queuedAt:now()};
    state.inflight = null; checkpoint(); return;
  }
  await sleep(Number(process.env.LONG_TASK_BUSY_RETRY_MS)||15000);
  }
  if (await provenLost(delivery)) {
    (state.lostDeliveries ||= []).push({target:delivery.target,key:delivery.key,sentAt:delivery.at,resentAt:now()});
    delivery.resentAt = now();
    delivery.sent = await rpc('send_message_to_thread',{threadId:delivery.target,prompt:deliveryMarker(delivery.key)+'\n'+outgoing(delivery.target,delivery.prompt,delivery.key),...(delivery.route||{})});
    delivery.at = now(); delivery.phase = 'resent-awaiting-readback';
    checkpoint();
    return reconcile(delivery);
  }
  throw Error('Delivery uncertain: ' + delivery.key);
}
// Queued deliveries are confirmed by their marker; once the target is idle without it, the normal read-back,
// proven-lost resend or uncertain-delivery path takes over as for any other delivery.
async function settleQueued() {
  for (const [key, delivery] of Object.entries(state.queuedDeliveries || {})) {
    if (state.inflight) return;
    if (localReceipt(delivery.target, key)) {
      save(path.join(run,'receipt-' + key + '.json'),{target:delivery.target,key,promptSha256:require('node:crypto').createHash('sha256').update(delivery.prompt).digest('hex'),
        sent:delivery.sent || null,confirmed:true,at:now()});
      if (!state.messages.some(item => item.key === key)) state.messages.push({target:delivery.target,key,at:now()});
      delete state.queuedDeliveries[key]; checkpoint(); continue;
    }
    if (await targetBusy(delivery.target)) continue;
    delete state.queuedDeliveries[key];
    state.inflight = {...delivery, busySince:null, phase:'queued-target-idle'}; checkpoint();
    await reconcile(state.inflight);
  }
  if (state.queuedDeliveries && !Object.keys(state.queuedDeliveries).length) { delete state.queuedDeliveries; checkpoint(); }
}
async function sendAndRead(target, prompt, key, options = {}) {
  need(!fs.existsSync(path.join(run,'STOP')),'Run stopped');
  need([binding.executorId,binding.supervisorId].includes(target), 'Target is not bound');
  if (state.messages.some(item => item.key === key) || state.queuedDeliveries?.[key]) return;
  const receiptFile = path.join(run,'receipt-' + key + '.json');
  if (state.inflight) {
    need(state.inflight.key === key && state.inflight.target === target && state.inflight.prompt === prompt,'Another delivery remains unresolved');
    await reconcile(state.inflight);
    return;
  }
  if (fs.existsSync(receiptFile)) {
    const receipt = read(receiptFile);
    const digest=require('node:crypto').createHash('sha256').update(prompt).digest('hex');
    need(receipt.target === target && receipt.promptSha256 === digest, 'Receipt binding mismatch');
    state.inflight = {target,prompt,key,sent:receipt.sent,at:now()};
    checkpoint();
    await reconcile(state.inflight);
    return;
  }
  // A regular delivery after reset can also carry the restoration, including while the thread is busy. A route the
  // quota reading holds back (the Claude reserve, the OpenAI floor) counts as limited.
  const activeRoute=state.modelSwitch?.[target];
  const role=target===binding.supervisorId?'supervisor':'executor';
  const due=activeRoute && !activeRoute.original?.startsWith('openrouter/') && (!state.routeWaiting?.[target]) && activeRoute.until<=Date.now() &&
    !fallback.limited(state,activeRoute.original,Date.now(),role);
  // The restore rides the delivery only once its route answers a probe (Jay 2026-11-27 decision 44).
  const carryRestore=fallback.modelPolicy(binding)==='automatic' && !options.model && due && (!activeRoute.restored || activeRoute.current===activeRoute.original&&!activeRoute.respondedAt) &&
    (await probes.probe(activeRoute.original,run)).ok;
  if(carryRestore)options={model:activeRoute.original,thinking:activeRoute.effort};
  // The supervisor reasons at xhigh where a case is judged (a submission, and its closing review) and at High for every
  // other event (Jay 2026-11-26 decision 2). An open-source supervisor stays at max, and a restore keeps its model.
  if(role==='supervisor'&&key.startsWith('review-')&&state.pending){
    const model=options.model||fallback.settingsOf(target)?.applied?.model||fallback.settingsOf(target)?.model;
    if(model&&!model.startsWith('openrouter/'))options={model,thinking:state.pending.kind==='submission'?'xhigh':'high'};
  }
  const route=options.model?{model:options.model,...(options.thinking?{thinking:options.thinking}:{})}:{};
  state.inflight = {target,prompt,key,at:now(),phase:'sending',route};
  checkpoint();
  // If the process exits after send but before its receipt, never issue a second send.
  const sent = await rpc('send_message_to_thread',{threadId:target,prompt:deliveryMarker(key)+'\n'+outgoing(target,prompt,key),...route});
  if(carryRestore && !activeRoute.restored){
    activeRoute.restored=now();activeRoute.current=activeRoute.original;activeRoute.since=Date.now();delete activeRoute.respondedAt;
  }
  state.inflight.sent = sent;
  state.inflight.phase = 'sent-awaiting-readback';
  checkpoint();
  await reconcile(state.inflight);
}
// Each segment submission's time, so the dashboard can count the image builds that went into it (Jay 2026-11-28 3A).
function noteSubmission(event){
  if(event.kind!=='submission'||!event.segment)return;
  const list=state.segmentSubmissions||=[];
  if(!list.some(item=>item.id===event.id))list.push({id:event.id,segment:event.segment,at:event.at});
  if(list.length>200)list.splice(0,list.length-200);
}
// Every image build of this run, the mainline's and its subagents', each counted toward the next segment submission
// after it: the rule is one build per segment candidate, so a segment's count above one shows the extra builds. Counting
// starts when this watcher first looked, like the notes (subagentBuildsSince).
function imageBuildCount(){
  const since=state.subagentBuildsSince??=Date.now();
  const builds=[...(state.imageBuilds||[]).map(item=>item.at),...pace.agentRuns(binding).flatMap(agent=>(agent.builds||[]).map(item=>item.at))]
    .map(at=>Date.parse(at)).filter(at=>Number.isFinite(at)&&at>=since).sort((a,b)=>a-b);
  const submissions=(state.segmentSubmissions||[]).map(item=>({segment:item.segment,at:Date.parse(item.at)})).sort((a,b)=>a.at-b.at);
  const bySegment={};let pending=0;
  for(const at of builds){const next=submissions.find(item=>item.at>=at);if(next)bySegment[next.segment]=(bySegment[next.segment]||0)+1;else pending++;}
  return {bySegment,pending,total:builds.length};
}
function extractEvent(turn, message) {
  const text = message.text || '';
  const marker = 'LONG_TASK_EVENT ';
  const markerAt = text.lastIndexOf(marker);
  let item;
  if (markerAt !== -1) {
    // The event line is complete on its own; prose the executor writes after it is not part of the event
    // (2026-10-11 GDB: a valid progress event was rejected as malformed for text following it).
    const rest = text.slice(markerAt + marker.length);
    try { item = JSON.parse(rest.trim()); }
    catch { try { item = JSON.parse(rest.split('\n')[0].trim()); } catch { item = {kind:'protocol_error'}; } }
  } else item = {kind:'unmarked_final'};
  if (!item || !['submission','question','blocked','progress','waiting','unmarked_final'].includes(item.kind)) item = {kind:'protocol_error'};
  if (item.kind === 'submission' && (!/^sha256:[a-f0-9]{64}$/.test(item.revision) || typeof item.manifest !== 'string')) item = {kind:'protocol_error'};
  if (['progress','waiting'].includes(item.kind) && !(typeof item.nextAction === 'string' && item.nextAction.trim())) item = {kind:'protocol_error'};
  return {id:turn.id,kind:item.kind,revision:item.revision || null,manifest:item.manifest || null,nextAction:item.nextAction || null,
    // A submission of one segment names it and its criteria (Jay 2026-11-25), as candidate.cjs prints them.
    ...(item.kind==='submission'&&typeof item.segment==='string'?{segment:item.segment,criteria:Array.isArray(item.criteria)?item.criteria:[]}:{}),
    waitMinutes:Number.isFinite(item.waitMinutes)?item.waitMinutes:null,
    ...(Array.isArray(item.waitFor)?{waitFor:item.waitFor}:{}),text,at:now()};
}
// Waiting on the supervisor's own ruling is a question for the supervisor, whatever kind the executor marked it
// (2026-10-12 05:59 GDB: K1 sent as progress + waitMinutes 60 "Waiting for the supervisor's K1 ruling").
function asksSupervisor(text) {
  return /(?:等待?|待|需要?|請).{0,10}監督.{0,20}(?:裁決|裁定|決定|決策|核准|判定|回覆|指示)|(?:waiting for|awaiting|needs?|requires?).{0,30}supervisor/i.test(text || '');
}
function waitingHasBlocker(text) {
  const body=text.split('\n').filter(line=>!line.trim().startsWith('LONG_TASK_EVENT ')).join('\n');
  return /(?:權限.{0,16}(?:審查|拒絕|阻擋)|(?:審查|核准).{0,16}(?:拒絕|阻擋)|(?:merge|push|release|deploy|合併|發版|發布).{0,40}(?:被擋|遭擋|阻塞|拒絕|blocked|denied|approval)|(?:需要|等待|等).{0,20}(?:Jay|使用者).{0,20}(?:決定|核准|授權)|(?:requires?|needs?|waiting for).{0,20}(?:user|Jay).{0,20}(?:approval|authorization|decision)|(?:待決|需要授權|授權或處置))/i.test(body);
}
async function exactFinal(turnId) {
  for (let attempt=0;attempt<3;attempt++) {
    const detail=unpack(await rpc('read_thread',{
      threadId:binding.executorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000
    }));
    const turn=detail.turns?.find(item=>item.id===turnId && item.status==='completed');
    const final=turn?.items?.filter(item=>item.type==='agentMessage' && item.phase==='final_answer').at(-1);
    if (final && typeof final.text==='string') return final;
    await sleep(1000);
  }
  throw Error('Completed executor turn has no exact readable final message: '+turnId);
}
// wait_threads reports only the latest turn, so a turn that completed while another event was pending, or between two
// reads, was never reviewed (GDB 2026-10-10T19:55Z and 10-11T14:12Z: two submissions never accepted). Read back to the
// last handled turn and queue what the supervisor must see, oldest first; a progress or wait that a later turn
// superseded, or a turn with no final answer, is only marked handled.
async function queueSkipped(latestId){
  const detail=unpack(await rpc('read_thread',{threadId:binding.executorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}));
  const turns=detail.turns||[],start=turns.findIndex(item=>item.id===latestId),queue=state.eventQueue||=[],older=[];
  if(start===-1)return;
  for(const turn of turns.slice(start+1)){
    if(state.seen.includes(turn.id))break;
    if(turn.status==='completed'&&!queue.some(item=>item.id===turn.id))older.unshift(turn);
  }
  for(const turn of older){
    const final=(turn.items||[]).filter(item=>item.type==='agentMessage'&&item.phase==='final_answer').at(-1);
    if(!(typeof final?.text==='string'&&final.text.trim())){state.seen.push(turn.id);continue;}
    const event=extractEvent(turn,final);noteSubmission(event);
    if(['waiting','progress'].includes(event.kind)&&asksSupervisor(event.text))event.kind='question';
    if(event.kind==='waiting'&&waitingHasBlocker(event.text))event.kind='blocked';
    if(['waiting','progress'].includes(event.kind))state.seen.push(turn.id);else queue.push(event);
  }
  checkpoint();
}
function reviewPrompt(event) {
  // Preserve an unresolved old delivery byte-for-byte across upgrades.
  if(state.inflight?.key==='review-'+event.id && state.inflight.target===binding.supervisorId)return state.inflight.prompt;
  return require('./review-context.cjs').prompt(run,event);
}
// Three stops the program can judge without a model go straight back to the executor (Jay 2026-11-25 chose 甲): a wait
// whose sources have all finished, a wait with no observable source, and a turn that ended with no event. Five runs had
// 291 of them (78, 103 and 110), and the executor waited about 596 minutes in all for the supervisor's fixed reply.
function autoContinueKind(event){
  if(event.kind==='unmarked_final')return 'unmarked_final';
  if(event.kind!=='waiting'||event.completion.blocked||event.completion.running.length)return null;
  return event.completion.finished.length?'waiting_ready':'waiting_no_source';
}
function autoContinuePrompt(kind,event){
  if(kind==='waiting_ready'){
    const done=event.completion.finished.map(item=>(item.path||item.id||item.kind)+(item.finishedAt?'（'+item.finishedAt+' 完成）':''));
    return '長任務續接 '+event.id+'：你在等的來源都已完成：'+done.join('、')+'。直接讀結果，接著做「'+event.nextAction+'」。'+
      '還有真的要等的工作，再送 waiting 並附可觀察的 waitFor。';
  }
  if(kind==='waiting_no_source'){
    return '長任務續接 '+event.id+'：你說在等的東西，背景程式查不到可觀察的完成來源'+
      (event.completion.issues.length?'（'+event.completion.issues.join('；')+'）':'')+'。'+
      '背景程序請用 resource-ledger 啟動並登記，結果檔寫進 waitFor，再送 waiting；不需要等的，現在就做「'+event.nextAction+'」。';
  }
  return '長任務續接 '+event.id+'：回合結束沒有送事件。照你最後寫的下一步現在就做，做完或真的要等時再送 progress 或 waiting。';
}

async function changed(directory, alreadyChanged = () => false) {
  await new Promise(resolve => {
    let watcher, finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(poll);
      watcher?.close(); resolve();
    };
    const timer = setTimeout(done,DECISION_POLL_MS);
    const poll = setInterval(()=>{if (alreadyChanged()||fs.existsSync(path.join(run,'STOP'))) done();},1000);
    try {
      watcher = fs.watch(directory,done);
      watcher.on('error',()=>{watcher?.close();watcher=null;});
    } catch {}
    if (alreadyChanged()) done();
  });
}
// A decision file that fails its checks stays where the supervisor wrote it and the watcher keeps running; the event
// stays pending. Before, any invalid decision ended the watcher, and a decision still carrying the old pendingApprovals
// field would have stopped a live run after the upgrade. The supervisor usually checks its file with supervise.cjs
// decision in the same turn and fixes it, so the watcher wakes it only when the same version still stands after the
// backup-wake delay, once per written version, with the original event and the error text.
async function refuseDecision(event,file,error){
  let sha256;try{sha256=hash(file);}catch{return;} // removed meanwhile: the next pass waits for a new file
  const errors=state.decisionErrors||={};
  if(errors[event.id]?.sha256!==sha256){errors[event.id]={sha256,message:error.message,at:Date.now(),notifiedAt:null};checkpoint();}
  const known=errors[event.id];
  if(!known.notifiedAt&&Date.now()-known.at>=SUPERVISOR_WAKE_MS&&!fs.existsSync(path.join(run,'STOP'))){
    await sendAndRead(binding.supervisorId,
      `決策未套用 ${event.id}：已提交版本沒通過檢查，背景監看沒有套用它、照常監看，這個事件仍待決（提交快照保留）。錯誤原文：${known.message}\n`+
      `請修正草稿 ${require('./decision-commit.cjs').draft(run,event.id)}，再用 supervise.cjs decision 明確提交；不要修改已提交快照或指標，不要重建或重送業務事件。原事件：\n`+require('./review-context.cjs').prompt(run,event),
      'decision-error-'+event.id+'-'+sha256.slice(0,12));
    known.notifiedAt=Date.now();checkpoint();return;
  }
  await changed(run,()=>!fs.existsSync(file)||hash(file)!==sha256);
}
// An executor whose turn ended on an event waits for this ruling (Jay 2026-10-15): its silence, idle and quiet-hour
// clocks restart when the ruling is applied, not at its submission (GDB 05:07 and 08:10: a 21- and a 27-minute review
// each ended in a silence check of an executor that had been waiting for the verdict). Clock reviews do not stop it.
function ruled(event) { if (!['progress_review','dispatch_review'].includes(event.kind)) state.lastDecisionAt = Date.now(); }
// An interim open-source supervisor reviews every event as usual (Jay 2026-11-21). Only its acceptance waits: the
// submission tool keeps it as a marker, the watcher parks the candidate here and frees the supervisor for other events.
function holdAcceptance(event,marker){
  let saved=null;try{saved=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{}
  try{fs.unlinkSync(marker);}catch{}
  if(saved?.eventId!==event.id||saved.eventSha256!==require('./decision-commit.cjs').eventHash(event))return;
  fs.appendFileSync(path.join(run,'held-acceptances.jsonl'),JSON.stringify({...saved,heldAt:now()})+'\n');
  (state.heldFinalReviews||=[]).push({event,model:saved.model,at:now()});
  if(!state.seen.includes(event.id))state.seen.push(event.id);
  delete state.supervisorWake?.[event.id];
  // The kept acceptance is on the dashboard at once, not up to a minute later.
  state.pending=null;state.phase='watching';checkpoint();lastDashboardAt=0;writeDashboard();
}
// Once Sol, Astra, Opus or Fable runs the supervisor again, the newest kept candidate goes back for a fresh review;
// an older one is replaced by it, as a newer submission replaces an older one.
function scheduleFinalReviews(){
  const held=(state.heldFinalReviews||[]).map(item=>item.event?item:{event:item,model:null});
  if(!held.length||state.pending||state.inflight)return;
  const route=state.modelSwitch?.[binding.supervisorId], actual=fallback.settingsOf(binding.supervisorId);
  const inTransit=route && !route.restored && Date.parse(actual?.at||0)<route.since;
  if(inTransit||!fallback.finalReviewer(actual?.model))return;
  const latest=held[held.length-1];
  for(const item of held.slice(0,-1))(state.resolved||={})[item.event.id]={event:item.event,obsolete:true,supersededBy:latest.event.id};
  const id=latest.event.id;
  (state.finalReviewAttempts||={})[id]=(state.finalReviewAttempts[id]||0)+1;
  (state.finalReviewFrom||={})[id]=latest.model;
  delete state.supervisorWake?.[id];
  (state.eventQueue||=[]).unshift(latest.event);state.heldFinalReviews=[];checkpoint();lastDashboardAt=0;writeDashboard();
}
function finalReviewPrompt(event){
  const attempt=state.finalReviewAttempts?.[event.id];
  if(!attempt)return reviewPrompt(event);
  return '高階監督複驗：暫代監督（'+(state.finalReviewFrom?.[event.id]||'開源模型')+'）已審查這個候選並要求結案。請在本回合逐條核對原件，重新寫裁決草稿後提交；不沿用暫代的結論。\n'+reviewPrompt(event);
}
async function pendingDecision() {
  const event = state.pending;
  if(event.kind==='dispatch_review' && !(state.messages||[]).some(m=>m.key==='review-'+event.id) && !state.inflight){
    const preflight=stillCurrent(run,binding,state,event);
    if(preflight.current===false){
      releaseAnnounced(state,event);(state.resolved||={})[event.id]={event,obsolete:true};state.seen.push(event.id);
      state.pending=null;state.phase='watching';checkpoint();return;
    }
  }
  if (!(state.supervisorWake ||= {})[event.id]) {
    const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}));
    state.supervisorWake[event.id]={deliveredAt:null,assistantMarker:assistantMarker(detail),activityMarker:require('./supervisor-response.cjs').activityMarker(detail),wakeSentAt:null};checkpoint();
  }
  const reviewKey='review-'+event.id+(state.finalReviewAttempts?.[event.id]?'-high-'+state.finalReviewAttempts[event.id]:'');
  await sendAndRead(binding.supervisorId,finalReviewPrompt(event),reviewKey);
  const file = require('./decision-commit.cjs').file(run,event.id), heldMarker = require('./decision-commit.cjs').held(run,event.id);
  const armed=state.supervisorWake[event.id];
  if(!armed.deliveredAt){armed.deliveredAt=Date.now();checkpoint();}
  if (!fs.existsSync(file)) {
    if(event.kind==='submission'&&fs.existsSync(heldMarker)){holdAcceptance(event,heldMarker);return;}
    await changed(run,()=>fs.existsSync(file)||fs.existsSync(heldMarker));
    const wake=state.supervisorWake[event.id];
    if(fs.existsSync(file)||fs.existsSync(heldMarker)||fs.existsSync(path.join(run,'STOP'))||isPaused())return;
    if(!wake.completionWakeSentAt){
      const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
      const closed=require('./supervisor-response.cjs').closedWithoutDecision(detail,wake.deliveredAt);
      if(closed&&!wake.completionRecovery){
        // Persist the key and exact prompt before sending, so a restart reconciles this delivery instead of
        // inventing another recovery for a newer turn. One completion reminder per unresolved event.
        wake.completionRecovery={...closed,key:'decision-required-'+reviewKey.slice(7),prompt:
          `監督回合已結束，但事件 ${event.id} 尚未提交決策。先核對 STOP、原事件與既有提交；已授權且有答案的部分先正式提交並確認送達，再處理延展研究。仍須本人決定的部分只登記待決，不凍結其他工作。不要重建或重送業務事件。\n`+finalReviewPrompt(event)};
        checkpoint();
      }
      if(wake.completionRecovery){
        await sendAndRead(binding.supervisorId,wake.completionRecovery.prompt,wake.completionRecovery.key);
        wake.completionWakeSentAt=Date.now();checkpoint();return;
      }
      if(!wake.wakeSentAt&&Date.now()-wake.deliveredAt>=SUPERVISOR_WAKE_MS){
      // The reminder is for a delivery that started nothing. A chat that is running a turn, or whose newest turn has
      // gained commands or reasoning since the review was armed, is working and gets none.
      const busy=require('./supervisor-response.cjs').working(detail,wake.activityMarker);
      if(assistantMarker(detail)===wake.assistantMarker&&!busy){
        await sendAndRead(binding.supervisorId,
          `監督喚醒補訊 ${event.id}：既有事件已送達，但本對話之後沒有進行中的回合，也沒有新的指令或模型活動。請處理既有 ${deliveryMarker(reviewKey)}；不要重建或重送業務事件，先檢查 STOP 與既有 decision。`,
          'wake-' + reviewKey);
        wake.wakeSentAt=Date.now();checkpoint();
      }else{wake.modelStartedAt=Date.now();if(busy)wake.workingBecause=busy;checkpoint();}
      }
    }
    return;
  }
  const contract = checkSources();
  let decision;
  let submitted;
  try { submitted = require('./decision-commit.cjs').load(run,binding,contract,event);
    decision = validateDecision(binding,contract,event,submitted.decision,state.eventQueue); }
  catch (error) { await refuseDecision(event,file,error); return; }
  if(event.kind==='dispatch_review'){
    const preflight=stillCurrent(run,binding,state,event);checkpoint();
    // An unreadable source is unknown. Defer this review without blocking new executor events; keep the submitted
    // decision and evidence, but require a fresh review when the source becomes readable again.
    if(preflight.current===null){
      (state.deferredDispatch||={})[event.id]={event,decisionSha256:submitted.decisionSha256};
      state.pending=null;state.phase='watching';checkpoint();return;
    }
    if(!preflight.current){releaseAnnounced(state,event);(state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:submitted.decisionSha256};state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;}
    // A ruled review of the mainline's own work ends it; another one needs another note and another repeat.
    if(state.selfWorkEscalated&&event.dispatchIssueKeys?.includes(state.selfWorkEscalated.key))delete state.selfWorkEscalated;
    if(state.subagentBuildEscalated&&event.dispatchIssueKeys?.includes(state.subagentBuildEscalated.key))delete state.subagentBuildEscalated;
  }
  if(event.kind==='progress_review'){
    const fresh=await waitExecutor();
    const poll=fresh.polls?.find(item=>item.thread?.id===binding.executorId);
    need(poll,'Bound executor missing from progress preflight');
    // Silence ends with new activity; overdue, blocked and the other clock reasons are meant for a busy executor
    // (rule A, Jay 2026-10-13: an overdue check asks about the baseline and scope, so fresh output does not void it).
    if(fs.existsSync(path.join(run,'STOP'))||quietReview(event)&&activityMarker(poll)!==event.activityMarker){
      observeActivity(state,poll,binding);
      (state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:submitted.decisionSha256};
      state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;
    }
    if(event.reasons?.includes('parallel_test_review')){
      // Do not deliver an instruction based on a test confirmed ended while review was queued. Changed agent
      // records or snapshots require a fresh review; neither alone proves actual live platform capacity.
      // Preserve the immutable event and submitted decision; remaining reasons get a new event.
      const parallel=require('./parallel-test.cjs');
      let readable=false;try{readable=clock.readExecutor(state,binding)?.readable===true;}catch{}
      const agents=parallel.observedAgents(binding,state);
      const check=parallel.reassess(event,state,clock.snapshotOf(run,binding),agents,{readable});
      if(check.changed){
        let replacement=null;
        if(check.reasons.length){
          const {id:_id,kind:_kind,at:_at,parallelTestReview:_old,...details}=event;
          details.reasons=check.reasons;
          if(check.tests.length||check.missingDetails)details.parallelTestReview={tests:check.tests,fingerprint:check.fingerprint,
            ...(check.missingDetails?{sourceCoverage:'unknown'}:{})};
          replacement=progressEvent(state,Date.now(),details);
          (state.eventQueue||=[]).push(replacement);
        }
        (state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:submitted.decisionSha256,
          ...(replacement?{supersededBy:replacement.id}:{})};
        state.seen.push(event.id);parallel.clear(state,event,{retain:check.tests.map(item=>item.source?.callId).filter(Boolean)});
        state.pending=null;state.phase='watching';checkpoint();return;
      }
    }
  }
  if (decision.disposition === 'needs_user') {
    state.phase = 'needs_user'; checkpoint();
    state.waitingDecisionSha256 = submitted.decisionSha256; checkpoint();
    const previousDecision = hash(file);
    await changed(run,()=>!fs.existsSync(file) || hash(file)!==previousDecision);
    return;
  }
  if (decision.disposition === 'observe') {
    if(decision.collectionNote)require('./review-followup.cjs').noteCollection(run,event.id,decision.collectionNote);
    if(decision.wait){
      const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
      observeActivity(state,supervisorPollFromThread(detail),binding,Date.now(),'supervisor');
      checkedWait.observeSupervisorInput(state,detail);
      checkedWait.remember(state,decision,binding);
    }
    state.lastProgressReviewAt=Date.now();ruled(event);
    if(event.kind==='progress_review')state.failedCommands={};
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:submitted.decisionSha256};
    if(event.kind==='progress_review')require('./parallel-test.cjs').clear(state,event);
    state.seen.push(event.id); state.pending = null;
    state.phase = 'watching'; checkpoint(); return;
  }
  if (decision.disposition === 'accept') {
    // Questions and blocks queued behind the accepted submission close with it: context gave the supervisor their full
    // text for its closing list to Jay (Jay's ruling 2026-10-14). The executor is not read while an event is pending,
    // so the queue is the one the supervisor saw.
    for (const item of state.eventQueue || []) { (state.resolved ||= {})[item.id] = {event:item,closedWithAcceptance:event.id}; state.seen.push(item.id); }
    state.eventQueue = [];
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:submitted.decisionSha256};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'accepted'; state.acceptedAt = now(); checkpoint(); return;
  }
  await sendAndRead(binding.executorId,decision.reply,'answer-' + event.id);
  ruled(event);
  // Every instruction is tracked against a deadline; the clock wakes the supervisor if nothing acts on it.
  const given = decision.instruction;
  state.instruction = {eventId:event.id,what:given?.what || decision.reply.replace(/\s+/g,' ').slice(0,200),doneWhen:given?.doneWhen || null,
    sentAt:Date.now(),deadlineMs:(given?.deadlineMinutes || 30)*60000,misses:0};
  state.coveredOverdue=require('./review-followup.cjs').coverage(clock.snapshotOf(run,binding),event,given?.coveredOverdue,state.instruction.sentAt+state.instruction.deadlineMs);
  if(event.kind==='progress_review'){state.lastProgressReviewAt=Date.now();state.failedCommands={};}
  (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:submitted.decisionSha256};
  if(event.kind==='progress_review')require('./parallel-test.cjs').clear(state,event);
  state.seen.push(event.id); state.pending = null;
  state.phase = 'watching'; checkpoint();
}
const isPaused = () => fs.existsSync(path.join(run,'PAUSED.json'));
// The existing keep-loaded interval also applies while an event waits for a decision. That branch used to
// continue before the keepalive check, letting a live pending review outlast the App's unload interval.
async function keepLoaded(){
  const due=()=>Date.now()-Math.max(state.lastSupervisorActivityAt||0,state.lastKeepaliveAt||0,watchStartedAt)>=KEEPALIVE_MS;
  if(isPaused()||state.inflight||!due())return false;
  const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
  const latest=detail.turns?.[0],completed=Number(latest?.completedAt);
  if(detail.thread?.status?.type==='active'){state.lastSupervisorActivityAt=Date.now();checkpoint();return false;}
  if(Number.isFinite(completed)&&completed>0){const at=completed<1e12?completed*1000:completed;
    state.lastSupervisorActivityAt=Math.max(state.lastSupervisorActivityAt||0,Math.min(at,Date.now()));}
  if(!due()){checkpoint();return false;}
  state.lastKeepaliveAt=Date.now();state.keepalives=(state.keepalives||0)+1;checkpoint();
  await sendAndRead(binding.supervisorId,KEEPALIVE_TEXT,'keepalive-'+state.keepalives);return true;
}
// Recheck deferred reviews only after reading and queuing any new executor event.
async function recheckDeferred(){
  if(isPaused())return false;
  for(const [id,deferred] of Object.entries(state.deferredDispatch||{})){
      const preflight=stillCurrent(run,binding,state,deferred.event);
      if(preflight.current===null)continue;
      delete state.deferredDispatch[id];
      if(!preflight.current){releaseAnnounced(state,deferred.event);(state.resolved||={})[id]={event:deferred.event,obsolete:true,decisionSha256:deferred.decisionSha256};state.seen.push(id);checkpoint();continue;}
      const keys=new Set(deferred.event.dispatchIssueKeys||[]),items=preflight.result.issues.filter(item=>keys.has(item.key)).map(item=>({...item,occurrence:state.dispatchAudit?.occurrences?.[item.key]}));
      const event=dispatchEvent({newIssues:items,file:preflight.result.file});
      event.id='dispatch-recheck-'+require('node:crypto').randomBytes(12).toString('hex');event.previousEventId=id;
      (state.resolved||={})[id]={event:deferred.event,deferredTo:event.id,decisionSha256:deferred.decisionSha256};state.seen.push(id);
      state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);return true;
    }
  return false;
}
let lastDashboardAt = 0;
function writeDashboard() {
  if (Date.now() - lastDashboardAt < 60000) return;
  lastDashboardAt = Date.now();
  try {
    // A paused run skips the clock, so the permission mode is read here too.
    if (!state.executorSettings) { const found = fallback.settingsOf(binding.executorId); if (found) state.executorSettings = found; }
    const snapshot = clock.snapshotOf(run,binding);
    dashboard.write(run,{binding,state,snapshot,paced:clock.paceNow(run,binding,state,snapshot),alive:true,paused:isPaused(),imageBuilds:imageBuildCount()});
  } catch (error) { state.dashboardError = {message:error.message,at:now()}; }
}
// Jay's questions reach his phone once the supervisor has finished the event that raised them (Jay 2026-11-09: on
// 11/07 at 23:16 WEB put questions to him and nothing was pushed). pending-decisions decides whether the list is new,
// retries a failed push every 10 minutes and keeps the failure where the dashboard and status show it.
async function pushQuestions(){
  if(state.pending||state.inflight||isPaused())return;
  try{
    const result=await questions.pushOpen(run,{title:state.threadTitles?.supervisor});
    if(!result.skipped||result.error)state.questionPush={ok:result.ok,key:result.key||null,error:result.error||null,at:now()};
  }catch(error){state.questionPush={ok:false,error:error.message,at:now()};}
}
const clockText = ms => new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
// A criterion that failed six times and was studied waits for Jay (Jay 2026-11-26 decisions 33-34): the supervisor is
// woken once per round to read the six deliveries, the rejections and the studies and to put one question to Jay in the
// pending ledger. Veda's thrice-daily summary carries it; nothing is pushed at once. The executor keeps working.
let cycleCheckAt=0;
async function reworkDecisions(){
  if(state.inflight||state.pending||isPaused()||Date.now()<cycleCheckAt)return;
  cycleCheckAt=Date.now()+60000;
  let due=[];try{due=rework.alerts(run,binding);}catch(error){state.cycleAlert={ok:false,error:error.message,at:now()};return;}
  const asked=new Set(questions.load(run).items.map(item=>item.key));
  for(const alert of due.filter(item=>!asked.has(item.key)&&!(state.messages||[]).some(m=>m.key==='rework-decision-'+item.key))){
    const prompt='LONG_TASK_REWORK_DECISION：驗收條文 '+alert.criterionId+' 這一輪已 '+alert.failures+' 次不合格，研究也登記了 '+alert.studies.length+' 次，這條停止派工與送驗，其他工作照常。\n'+
      '請讀這 '+alert.failures+' 次交付、退件理由與研究結果（rework.cjs status、acceptance-history.jsonl），用 pending-decisions.cjs 在待決帳登記一題給 Jay：key '+alert.key+'、kind rework_decision，四段寫齊（情境、現況、選項含推薦、效果）。'+
      '只走 Veda 每天 09:00、12:00、19:00 的彙整，不另外推播；Jay 在本對話在線時當場列出。Jay 裁決後，照錄他的原話用 rework.cjs resume 登記，這條才重新起算。\n'+rework.describe(alert,state.threadTitles?.supervisor);
    await sendAndRead(binding.supervisorId,prompt,'rework-decision-'+alert.key);
    state.cycleAlert={ok:true,key:alert.key,at:now()};checkpoint();return;
  }
}
// The mainline's own edits, tests and sleeps (supervisor-clock selfWorkOf; Jay 2026-11-26 decisions 31 and 35): the first
// in a turn gets a fixed note from this watcher, without waking the supervisor; doing it again in the same turn after
// that note wakes the supervisor through a dispatch review, which asks the mainline to hand the work over.
async function selfWorkNotice(){
  const work=state.selfWork;
  if(!work?.hits?.length||work.escalated||isPaused()||state.inflight)return;
  let directory=null;try{directory=read(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')).workPackageDirectory||null;}catch{}
  const hits=clock.selfWorkHits(work,run,directory);
  if(!hits.length)return;
  if(!work.noticeKey){
    work.noticeKey='self-work-'+fallback.hashId(binding.executorId+'/'+work.turnId).slice(0,16);work.noticeAt=Date.now();checkpoint();
    await sendAndRead(binding.executorId,clock.selfWorkPrompt(hits),work.noticeKey);return;
  }
  const again=hits.filter(hit=>Date.parse(hit.at)>work.noticeAt);
  if(!again.length)return;
  work.escalated=true;
  state.selfWorkEscalated={key:'self-work-'+fallback.hashId(binding.executorId+'/'+work.turnId),turnId:work.turnId,hits:again.slice(0,10),at:now()};checkpoint();
}
// A subagent built, pushed or moved an image (pace imageCommand; Jay 2026-11-28 3A): deploying is the mainline's, and
// the experiments that must run on Staging use the test containers already there. The first build in a subagent turn
// gets a note to the mainline; another one in that same turn after the note wakes the supervisor through a dispatch
// review. Builds made before this watcher first looked are not reported.
async function subagentBuildNotice(){
  if(isPaused()||state.inflight)return;
  const since=state.subagentBuildsSince??=Date.now(),seen=state.subagentBuilds||={};
  for(const agent of require('./pace.cjs').agentRuns(binding)){
    const builds=(agent.builds||[]).filter(item=>Date.parse(item.at)>=since);
    if(!builds.length)continue;
    const last=builds.at(-1),record=seen[agent.id],name=agent.path||agent.id;
    if(!record||record.turnId!==last.turnId){
      seen[agent.id]={turnId:last.turnId,noticeAt:Date.now()};checkpoint();
      await sendAndRead(binding.executorId,'LONG_TASK_SUBAGENT_IMAGE：背景程式看到子代理 '+name+' 建映像或搬映像：'+last.command+'\n'+
        '建映像、部署只由主線做，一個區段整合完才建一次。要在 Staging 跑的實驗，請子代理用 Staging 上既有的測試容器跑指定 commit 的程式，不另建映像。'+
        '請通知這個子代理停止建映像。這一則不叫醒監督；同一回合它再建一次，背景程式會請監督處理。','subagent-image-'+fallback.hashId(agent.id+'/'+last.turnId).slice(0,16));
      return;
    }
    const again=builds.filter(item=>item.turnId===record.turnId&&Date.parse(item.at)>record.noticeAt);
    if(again.length&&!record.escalated){
      record.escalated=true;
      state.subagentBuildEscalated={key:'subagent-image-'+fallback.hashId(agent.id+'/'+record.turnId),agent:name,turnId:record.turnId,builds:again.slice(0,5),at:now()};
      checkpoint();return;
    }
  }
}
// supervise.cjs amend, run while this watcher is alive, leaves Jay's authorization in amend-request.json. The watcher records
// it at a safe point (no event waiting for a ruling, no unconfirmed delivery) under its own lock and keeps watching. The
// requester reads amend-results/<id>.json; when it has already returned, the supervisor gets one message instead.
let amendRetryAt=0,amendUnreadableSince=0;
const amendWaiting=()=>Date.now()>=amendRetryAt&&!state.pending&&!state.inflight&&fs.existsSync(AMEND_REQUEST);
async function handleAmendRequest(){
  if(!amendWaiting())return false;
  let request=null,error=null,result=null;
  try{request=read(AMEND_REQUEST);amendUnreadableSince=0;}
  catch(caught){
    // A request still being written is read again shortly; one that stays unreadable is answered as failed.
    amendUnreadableSince||=Date.now();
    if(Date.now()-amendUnreadableSince<30000){amendRetryAt=Date.now()+1000;return false;}
    amendUnreadableSince=0;error='Unreadable amend request: '+caught.message;
  }
  const id=/^[a-f0-9]{16,64}$/.test(request?.id||'')?request.id:null;
  if(!error&&!id)error='Amend request without a valid id';
  if(!error){
    checkpoint();
    const caller=process.env.CODEX_THREAD_ID;
    try{
      if(request.caller)process.env.CODEX_THREAD_ID=request.caller;else delete process.env.CODEX_THREAD_ID;
      result=require('./pending-decisions.cjs').amend(run,binding,request.input,{self:process.pid});
    }catch(caught){
      // The executor's dispatch writer holds its lock only for a moment: record once it is done.
      if(/Run writer is active: dispatch-write\.lock/.test(caught.message)){amendRetryAt=Date.now()+5000;return false;}
      error=caught.message;
    }finally{if(caller===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=caller;}
  }
  if(result){
    // The amendment rewrote binding.json (contractStateSha256): read it back into the binding this process uses.
    const fresh=read(path.join(run,'binding.json'));
    for(const key of Object.keys(binding))if(!(key in fresh))delete binding[key];
    Object.assign(binding,fresh);checkSources();
  }
  const record={id,ok:!error,...(error?{error}:{result}),recordedBy:'watcher',watcherPid:process.pid,at:now()};
  fs.mkdirSync(AMEND_RESULTS,{recursive:true});
  if(id)save(path.join(AMEND_RESULTS,id+'.json'),record);
  // Decided right after the result is written: a requester still polling reads it and reports it itself.
  const left=!id||!request.requesterPid||fs.existsSync(path.join(AMEND_RESULTS,id+'.requester-left'))||
    require('./process-probe.cjs').probe(request.requesterPid)!==true;
  fs.rmSync(AMEND_REQUEST,{force:true});
  (state.amendRequests||=[]).push({id,ok:!error,at:record.at});
  if(state.amendRequests.length>20)state.amendRequests.splice(0,state.amendRequests.length-20);
  checkpoint();lastDashboardAt=0;writeDashboard();
  if(left){
    const tag=require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0,8);
    await sendAndRead(binding.supervisorId,error
      ?'LONG_TASK_AMEND_FAILED：授權登記'+(id?' '+id:'')+' 沒有完成：'+String(error).slice(0,300)+'。背景監看照常運作；修正 amend 輸入後重跑 supervise.cjs amend，不要停監看。'
      :'LONG_TASK_AMEND_RECORDED：授權登記 '+id+' 已由背景監看寫入有效契約（'+(request.input?.id||'')+'），監看照常運作。不要重做登記或停監看；依授權流程把它交給執行主線，並核對待決帳。',
      'amend-'+(error?'failed':'recorded')+'-'+(id||'unreadable')+'-'+tag);
  }
  return true;
}
// Model routes (Jay 2026-10-11, revised 2026-11-21 and 2026-11-26): this background watcher, not the chats, moves each
// mainline. A mainline moves down when it is refused itself or when the quota ladder keeps it off its front stops
// (claude-quota.cjs, model-fallback.cjs held), and moves back up once the reset passes or the ladder rises. A refused
// subagent is re-dispatched on the subagent order; new packages follow the ladder through model-route.cjs.
// The notice names what actually happened (2026-11-23: ten notices said 額度限速 while no provider had refused for
// quota): model-fallback.cjs switchReason / restoreReason.
// What a refusal of a route means for every later choice: the limit of that route until its reset, and the records
// every run on this Mac reads. A failed probe that names the quota, the balance or the model is recorded the same way.
function recordLimit(hit,files) {
  const plain=fallback.keyOf(hit.model), open=String(hit.model||'').startsWith('openrouter/');
  const billing=hit.billing?fallback.billingAccount(hit.model):null;
  const key=open&&hit.status===402?fallback.OPENROUTER_ACCOUNT:fallback.limitKey(hit.role,billing||hit.model), known=state.rateLimits?.[key];
  const reset=hit.quotaReset||(hit.failure?{until:hit.at+fallback.FAILURE_COOLDOWN_MS,basis:fallback.FAILURE_BASIS,cooldown:'failure'}:
    hit.unsupported?{until:hit.at+fallback.FALLBACK_MS,basis:fallback.UNSUPPORTED_BASIS,cooldown:'unsupported'}:
    billing?{until:hit.at+fallback.FALLBACK_MS,basis:fallback.BILLING_BASIS,cooldown:'billing'}:
    open&&hit.status!==402?{until:hit.at+fallback.OPENROUTER_COOLDOWN_MS,basis:fallback.OPENROUTER_BASIS,cooldown:'short'}:fallback.resetFor(plain,hit.at,files));
  if (!known || known.until <= hit.at) (state.rateLimits ||= {})[key] = {since:hit.at,model:hit.model,files,...reset};
  else {
    known.files = [...new Set([...(known.files || []),...files])];
    if(hit.quotaReset?.fromError)Object.assign(known,hit.quotaReset);
  }
  // The Claude API month cap holds for every run until its named reset.
  if(plain==='anthropic-apikey/'&&hit.quotaReset)fallback.recordApiMonth(state,run,hit.quotaReset.until,hit.quotaReset.basis);
  if(hit.unsupported)fallback.recordUnsupported(run,plain,hit.at,hit.at+fallback.FALLBACK_MS);
  // Every role of every run skips the key from now on, this run's other side included.
  if(billing){fallback.recordUnsupported(run,billing,hit.at,hit.at+fallback.FALLBACK_MS,fallback.BILLING_BASIS);fallback.syncUnsupported(state,run);}
}
// A failed probe read as a refusal: the provider's code tells the balance, the model or the quota. An outage or a
// timeout records nothing; the failed probe itself keeps that model out of every run's choice for a minute.
function probeRefusal(result,role,threadId) {
  const code=String(result.code||''), error=('換模型前試打：'+(result.code||result.status)+' '+(result.message||'')).slice(0,200);
  const base={role,threadId,model:result.model,at:result.at,error};
  if(/credit_balance|insufficient_quota|billing/.test(code)&&fallback.billingAccount(result.model))return {...base,status:429,billing:true};
  if(code==='model_unavailable')return {...base,status:400,unsupported:true};
  if(result.status===402)return {...base,status:402};
  if(result.status===429||/rate_limit|usage_limit/.test(code))return {...base,status:429};
  return null;
}
// fresh: the quota was read at once for a switch of this pass, which is decided again on that reading.
async function handleRateLimits({fresh=false}={}) {
  if (fallback.modelPolicy(binding)==='locked') return;
  let dirty=fallback.migrateLimits(state);
  if(fallback.syncApiMonth(state,run))dirty=true;
  if(fallback.syncUnsupported(state,run))dirty=true;
  // A new reading is published even when the decision stays, so model-fallback.json shows the current share and
  // thresholds (after v1.21.1 it kept the old thresholds' text until a step changed).
  const readBefore=state.claudeQuota?.at;
  if(await quota.refresh(state,Date.now(),run)||state.claudeQuota?.at!==readBefore)dirty=true;
  // The supervisor hears once when OpenCodex's plaintextV2AgentMessages is read off, and once when it is back on
  // (Jay 2026-11-28「背景程式加檢查 plaintext 設定還開著」). A shared supervisor hears it from its owner watcher only.
  const plain=state.claudeQuota?.plaintext?.enabled;
  if(typeof plain==='boolean'&&state.plaintextSeen!==plain){
    if(plain===false||state.plaintextSeen===false)state.plaintextNotice={enabled:plain,at:now()};
    state.plaintextSeen=plain;dirty=true;
  }
  // A supervisor shared with another run is moved by one watcher only (model-fallback.cjs supervisorOwner). This one
  // leaves it alone: its own open switch of that supervisor is closed and nothing of it is queued or judged here.
  const ownsSupervisor=fallback.supervisorOwner(run,binding.supervisorId);
  const supervisorRecord=state.modelSwitch?.[binding.supervisorId];
  if(!ownsSupervisor&&supervisorRecord&&!supervisorRecord.restored){supervisorRecord.restored=now();supervisorRecord.restoredBy='other-watcher';dirty=true;}
  if(!ownsSupervisor&&state.routeWaiting?.[binding.supervisorId]){delete state.routeWaiting[binding.supervisorId];dirty=true;}
  const awaitingOutput=Object.values(state.modelSwitch||{}).filter(record=>!record.restored&&!record.respondedAt);
  const subagents = pace.agentRuns(binding).map(item => ({role:'subagent',threadId:item.id,path:item.path,file:item.sourceFile}));
  const hits = fallback.scan(state,[...(ownsSupervisor?[{role:'supervisor',threadId:binding.supervisorId}]:[]),{role:'executor',threadId:binding.executorId},...subagents]);
  // A switch has taken once a turn that started after it runs the new model, as the chat's own turn_context says. A
  // turn that started after the switch on the model it left means the chat did not take it: the switch is sent again
  // while the chat is idle, once for each such turn and at most three times. Nothing is judged by elapsed time (Jay
  // 2026-11-27 decision 44, replacing the 15-minute silent judgment and the resend read from failed requests: 15:19
  // 清票's executor was judged silent the moment a turn it had started on Opus before the 14:56 switch ended, and was
  // moved on to Terra although Opus had answered all along).
  for (const [id,record] of Object.entries(state.modelSwitch||{})) {
    if (record.restored || record.takenAt || record.delivery) continue;
    const turn=fallback.settingsOf(id);
    if (!turn?.turnId || !(Date.parse(turn.at)>=record.since)) continue;
    if (turn.model===record.current) { record.takenAt=Date.parse(turn.at); dirty=true; continue; }
    if (turn.model!==(record.from||record.original) || record.resentFor===turn.turnId || (record.resends||0)>=SWITCH_RESENDS || await targetBusy(id)) continue;
    record.resends=(record.resends||0)+1;record.resentFor=turn.turnId;
    record.delivery={key:'model-switch-resend-'+id.slice(0,8)+'-'+(state.modelSwitches||0)+'-'+record.resends,
      prompt:'重送換模型通知（第 '+record.resends+' 次）：上一則換模型之後，新回合仍用 '+turn.model+'。本對話改用 '+record.current+'，從已確認的進度接續。',
      effort:record.current.startsWith('openrouter/')?'max':record.effort};
    dirty=true;
  }
  for (const hit of hits) {
    // The refused thread's own rollout names the reset; its file is kept so later looks can still find that error.
    recordLimit(hit,[hit.file || pace.sessionFile(hit.threadId)].filter(Boolean));
    const queue = state.switchQueue ||= [];
    if (!queue.some(item => item.threadId === hit.threadId && item.model === hit.model)) queue.push(hit);
  }
  // Limits saved before 2026-11-09 have no files: use the rollouts of the threads switched for them.
  for (const [key,item] of Object.entries(state.rateLimits || {})) if (!item.files)
    item.files = Object.entries(state.modelSwitch || {}).filter(([,record]) => fallback.limitKey(record.role,record.original) === key)
      .map(([threadId]) => pace.sessionFile(threadId)).filter(Boolean);
  const refined = fallback.refine(state), back = fallback.recovered(state), reading=state.claudeQuota;
  // Keep one durable route decision per role. The next poll can resume it without a new failure or user message.
  const waiting=state.routeWaiting||={};
  // The model a mainline is set to run. A turn in progress keeps the model it started with, so a setting applied
  // since then is what counts; the executor's incremental reader already follows it, and after a restart its settings
  // come from the same tail read as the supervisor's.
  const setModel=id=>{const seen=id===binding.executorId?state.executorSettings:fallback.settingsOf(id);return seen?.applied?.model||seen?.model;};
  if(state.rateLimitedAll?.threadId && !state.routeWaitMigrated){
    const legacy=state.rateLimitedAll;
    waiting[legacy.threadId]={...legacy,at:Date.parse(legacy.at)||Date.now()};
  }
  state.routeWaitMigrated=true;
  // This incremental reader also runs while a decision is pending.
  clock.readExecutor(state,binding);
  // A chat set to another model by hand after this watcher switched it runs from that choice: the switch record no
  // longer says what the chat runs, so it is closed and the chosen model is judged like any start, by the order and the
  // Claude reserve (Jay 2026-11-25 Q13 A: 工區 E was set to Opus at 13:26 while the record still said Muse, and neither
  // looked at Opus; it would have used the supervisor's Claude quota until the OpenAI pauses ended at 16:58). A chat set
  // back to its original model is left to the restore below, which records it as already on the original.
  for(const [id,record] of Object.entries(state.modelSwitch||{})){
    if(record.restored||record.delivery)continue;
    const seen=id===binding.executorId?state.executorSettings:fallback.settingsOf(id),chosen=setModel(id);
    if(!chosen||chosen===record.current||chosen===record.original)continue;
    if(Date.parse(seen?.applied?.at||seen?.at)>record.since){record.restored=now();record.restoredBy='manual-change';dirty=true;}
  }
  if(state.switchQueue?.length){
    // A worker's refusal reaches the same conversation as its mainline's: keep the one for the model the chat runs.
    for(const hit of state.switchQueue)if(waiting[hit.threadId]?.model!==setModel(hit.threadId))waiting[hit.threadId]=hit;
    state.switchQueue=[];checkpoint();
  }
  if(awaitingOutput.some(record=>record.respondedAt))checkpoint();
  // A drain left by an older version (the executor waiting to leave the Claude subscription) has no meaning now.
  if(state.quotaDrain){delete state.quotaDrain;dirty=true;}
  const active=Object.entries(state.modelSwitch||{}).filter(([,r])=>!r.restored);
  // A mainline left off its role's order without a switch of this watcher is moved up like a switched one: an
  // open-source route a model chose under the rule retired 2026-11-21 (open source is only for when every route above
  // it is out), or another Claude tier (工區 D's executor, started on Sonnet for the 11/26 test, Jay 2026-11-27).
  const mainlines=[binding.executorId,...(ownsSupervisor?[binding.supervisorId]:[])];
  const offOrder=(model,role)=>{const chain=fallback.chainFor(role);return Boolean(model)&&(String(model).startsWith('openrouter/')||chain.length>0&&!chain.includes(model));};
  const strandedIds=mainlines.filter(id=>!(state.modelSwitch?.[id]&&!state.modelSwitch[id].restored)&&!waiting[id]&&
    offOrder(setModel(id),id===binding.executorId?'executor':'supervisor'));
  // A mainline set to a stop the quota reading holds back moves on: the OpenAI subscription at its line or last 2%
  // (Jay 2026-11-25), or a stop in front of its ladder floor (2026-11-26 decision 24). So does an executor on the
  // ChatGPT subscription whose subscription Terra cannot serve its workers (2026-11-27 decision 37).
  const heldIds=mainlines.map(id=>[id,id===binding.executorId?'executor':'supervisor']).filter(([id,role])=>!waiting[id]&&
    setModel(id)&&(fallback.held(state,setModel(id),role)||fallback.cannotDispatch(state,setModel(id),role))).map(([id])=>id);
  for(const id of Object.keys(state.strandedNotice||{}))if(!strandedIds.includes(id)){delete state.strandedNotice[id];dirty=true;}
  if(hits.length||refined||back||dirty){fallback.publish(run,state,Date.now(),binding.fourthExecutorModel);checkpoint();}
  if(!active.length && !Object.keys(waiting).length && !strandedIds.length && !heldIds.length)return;
  const ids=new Set([...Object.keys(waiting),...active.map(([id])=>id),...strandedIds,...heldIds].filter(id=>ownsSupervisor||id!==binding.supervisorId));
  for(const id of ids){
    if(state.inflight)return;
    const hit=waiting[id], record=state.modelSwitch?.[id], switched=record&&!record.restored;
    const role=hit?.role||record?.role||(id===binding.supervisorId?'supervisor':'executor');
    if(role==='subagent'){
      const target=fallback.next(hit.model,role,state,Date.now());
      const notice='rate-subagent-'+fallback.hashId(id+'/'+hit.at);
      await sendAndRead(binding.executorId,'子代理 '+(hit.path||id)+' 遇額度限速。'+(target?'依子代理順位重派，候選為 '+target+'。':'依派工清單與 model-fallback.json 重查可用模型，先繼續其他工作。'),notice);
      delete waiting[id];checkpoint();continue;
    }
    if(record?.delivery){
      const msg=record.delivery;
      await sendAndRead(id,msg.prompt,msg.key,{model:record.current,thinking:msg.effort});
      delete record.delivery;checkpoint();
    }
    const time=Date.now();
    // A refusal of a model the chat is no longer set to run is not answered with another switch: the chat already
    // runs its target, and a request on the old model (a worker's, or a compaction before the new turn) is left to
    // the supervisor, which the failed turn wakes (Jay 2026-11-25 Q1 A: 12:03～12:04 工區 E's watcher sent the same
    // switch to Muse 21 times while every new turn first asked for gpt-6.2-sol and failed before its turn context).
    if(hit && switched && record.current!==hit.model && setModel(id)!==hit.model){
      delete waiting[id];checkpoint();continue;
    }
    const observed=setModel(id);
    const stranded=!switched&&!hit&&offOrder(observed,role);
    const chain=fallback.chainFor(role);
    // Every mainline comes back to the first stop of its role, whatever model it was started on or switched from
    // (Jay 2026-11-27: 工區 D's executor was switched back to its Sonnet start at 15:34).
    const original=chain[0]||(switched?record.original:hit?.model||observed);
    const current=hit?.model||(switched?record.current:observed);
    chain.push(...fallback.openRoutes(role,binding.fourthExecutorModel).map(r=>r.model));
    // A model whose probe failed in the last minute, in any run on this Mac, is left out like a limited one.
    const candidates=[...new Set(chain)].filter(model=>model && !fallback.limited(state,model,time,role) && !probes.failedRecently(model,run) &&
      !(switched && model===original && record.until>time && !state.rateLimits?.[fallback.limitKey(role,original)]));
    const target=candidates[0];
    // Without its own refusal the supervisor goes down to an open-source route only at the ladder's bottom step.
    const ladder=!hit && fallback.held(state,current,role);
    const noWorker=!hit && !ladder && fallback.cannotDispatch(state,current,role,time);
    if(role==='supervisor' && !hit && !ladder && !current?.startsWith('openrouter/') && target?.startsWith('openrouter/'))continue;
    if(!target){
      if(!waiting[id])waiting[id]={threadId:id,model:current,role,at:time,error:'等待可用順位',waitingOnly:true};
      delete state.rateLimitedAll;
      continue;
    }
    if(!hit && target===current)continue;
    // A chat waiting for a free route that is already set to that route and still working needs no notice (2026-11-23
    // WebRPA -22: set to DeepSeek since 16:24, its turn running, told at 16:36 to use DeepSeek). A real refusal always
    // gets its continuation: the turn it stopped does not resume by itself.
    if(hit?.waitingOnly && target===observed && await targetBusy(id)){delete waiting[id];checkpoint();continue;}
    const floor=ladder && fallback.subscriptionOpenAI(current) && require('./claude-quota.cjs').openaiHeld(state);
    // A stranded mainline is told while it is idle and once per turn: a notice cannot move the turn in progress
    // (2026-11-23 工區 E: 72 identical notices in 19 minutes into one supervisor turn). A notice sent again says why
    // (Jay 2026-11-23:「印出來的訊息要讓我知道重送原因，不然我會以為是死迴圈不斷傳訊息」).
    const told=stranded?state.strandedNotice?.[id]||null:null;
    const turnId=stranded?(id===binding.executorId?state.executorSettings?.turnId:fallback.settingsOf(id)?.turnId)||null:null;
    if(stranded && (told&&told.turnId===turnId || await targetBusy(id)))continue;
    // Prevent old refusal data from pulling a healthy manually selected model into the chain.
    if(!hit && switched && target===original && !original.startsWith('openrouter/') && (()=>{const actual=fallback.settingsOf(id);return actual?.model===original && Date.parse(actual.at)>=record.since;})() && !record.delivery){
      record.restored=now();record.restoredBy='already-on-original';checkpoint();continue;
    }
    // Every switch goes to an idle chat. A turn in progress keeps the model it started with, and a notice steered into
    // it was taken as an instruction mid-turn (Jay 2026-11-27 decision 44: 清票's executor was told at 14:56 during a
    // turn that ran on Opus until 15:19). A refused turn has ended, so a refusal is answered at once.
    if(await targetBusy(id))continue;
    // The quota is read again right before the switch, and the switch is decided again on that reading, so a reset
    // nobody announced counts (Jay 2026-11-27 decision 45:「掃模型的排程只是多做一個即時確認剩餘額度」).
    if(!fresh && Date.now()-(state.claudeQuota?.at||0)>=QUOTA_FRESH_MS){
      await quota.refresh(state,Date.now(),run,{force:true});
      fallback.publish(run,state,Date.now(),binding.fourthExecutorModel);checkpoint();
      return handleRateLimits({fresh:true});
    }
    // The target answers a probe before the chat is switched to it. One that does not is left out, recorded as refused
    // when its error names the quota, the balance or the model, and the next pass takes the next stop (decision 44).
    const tried=await probes.probe(target,run);
    if(!tried.ok){
      const refusal=probeRefusal(tried,role,id);
      if(refusal)recordLimit(refusal,[]);
      fallback.publish(run,state,Date.now(),binding.fourthExecutorModel);checkpoint();
      continue;
    }
    // Back at the first stop the record closes: nothing is left above it to come back to.
    const restored=target===original;
    const settings=fallback.settingsOf(id)||{};
    // Leaving open source (always max) a stranded mainline takes its role's usual effort: xhigh for both (decisions 1-2).
    const effort=(switched?record.effort:stranded?'xhigh':settings.effort)||null;
    const targetEffort=target.startsWith('openrouter/')?'max':effort;
    const until=state.rateLimits?.[fallback.limitKey(role,original)]?.until || time;
    let prompt=isPaused()?'本對話切換至 '+target+'。任務維持暫停，等原恢復指示。':stranded?'模型順位由背景程式切換：'+observed+' 不在本角色的順位上（開源模型只在前面順位都不能用時使用）。本對話改用 '+target+'，從已確認的進度接續。':restored&&(switched||target===current) ? (hit?'額度限速恢復時間已過。':'LONG_TASK_MODEL_RESTORED：'+fallback.restoreReason(state.rateLimits?.[fallback.limitKey(role,original)]))+'本對話用 '+target+' 從中斷處接續原工作。':
      floor?'OpenAI 訂閱留給 Jay 自己用（'+quota.describeOpenAI(reading)+'）：本對話改用 '+target+'，從已確認的進度接續。':
      ladder?'降級階梯（'+quota.describe(reading)+'）：本對話改用 '+target+'，從已確認的進度接續。':
      noWorker?'主線在 ChatGPT 訂閱上只能派 Terra 訂閱子代理，Terra 訂閱目前不能用：本對話改用 '+target+'，從已確認的進度接續。':
      fallback.switchReason(hit,target)+'本對話改用 '+target+'，從已確認的進度接續。';
    // Workers keep their own order whatever the mainline runs (Jay 2026-11-26 decision 20), except under a mainline on
    // the ChatGPT subscription while OpenCodex's plaintextV2AgentMessages is off, whose workers can only be the
    // subscription Terra (2026-11-27 decision 37, lifted with the setting on 2026-11-28). So a change of model family is
    // told, and with the setting off so is a move onto or off the ChatGPT subscription.
    const familyOf=model=>String(model||'').startsWith('openrouter/')?model:catalog.identity(model)?.family||model;
    const onSubscription=fallback.subscriptionOpenAI(target);
    const otherFamily=familyOf(current)!==familyOf(target), familyRule=!quota.crossFamily(state);
    if(role==='executor' && !isPaused() && (otherFamily||familyRule&&fallback.subscriptionOpenAI(current)!==onSubscription))
      prompt+=' '+(otherFamily?'換到不同家模型':onSubscription?'換到 ChatGPT 訂閱':'離開 ChatGPT 訂閱')+'：在途子代理改從工作包交付檔與原件收件，不再向它發訊；'+(onSubscription&&familyRule?
        '新派子代理一律用 Terra 訂閱（主線在 ChatGPT 訂閱上派其他家子代理會被平台拒絕），照 model-route 的結果派。':
        '新派子代理照 model-fallback.json 的子代理順位（ladder.first.subagent）。');
    if(role==='supervisor' && !isPaused() && target.startsWith('openrouter/'))prompt+=' 暫代監督依原契約照常收件、查證與派工；要結案的候選照常審查並提交，背景程式會保留原件，交恢復的高階監督逐條複驗結案。';
    if(stranded && told)prompt+='（第 '+(told.count+1)+' 次通知。重送原因：上一則在 '+clockText(Date.parse(told.at))+' 送出，之後開始的新回合仍設定為 '+observed+'。）';
    state.modelSwitches=(state.modelSwitches||0)+1;
    const key='model-switch-'+id.slice(0,8)+'-'+state.modelSwitches;
    // since is the moment the notice goes out, after the busy check and the probe: a turn the chat starts later is the
    // one that shows whether it took the switch.
    (state.modelSwitch||={})[id]={role,original,from:current,current:target,effort,since:Date.now(),until,restored:null,
      ...(ladder||switched&&record.ladderOrigin&&!hit?{ladderOrigin:true}:{}),delivery:{key,prompt,effort:targetEffort}};
    if(stranded)(state.strandedNotice||={})[id]={turnId,at:now(),count:(told?.count||0)+1};
    delete waiting[id];
    if(state.rateLimitedAll?.threadId===id)delete state.rateLimitedAll;
    checkpoint();
    await sendAndRead(id,prompt,key,{model:target,thinking:targetEffort});
    const updated=state.modelSwitch[id];delete updated.delivery;
    if(restored)updated.restored=now();
    fallback.publish(run,state,time,binding.fourthExecutorModel);checkpoint();
  }
}
async function watch() {
  lock();
  if(fs.existsSync(path.join(run,'STOP'))||['accepted','stopped'].includes(state.phase))return;
  need(state.phase!=='needs_reconcile'||state.inflight,'Receipt recovery requires a saved inflight delivery');
  checkSources();
  clock.kernelSleep(state,binding);
  state.pid = process.pid;
  checkpoint();
  const initialized = await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'long-task-supervisor',version:'1.0'}});
  if (initialized.error) throw Error(JSON.stringify(initialized.error));
  client.notify('notifications/initialized');
  const available = await require('./mcp-client.cjs').listTools(client,meta);
  for (const name of ['read_thread','send_message_to_thread']) need(available.has(name),'Missing Codex App tool ' + name);
  const proof = await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500});
  need(contains(proof,binding.executorId),'Cannot read bound executor conversation');
  try {
    const supervisorProof = unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
    state.threadTitles = {executor:unpack(proof).thread?.title || null,supervisor:supervisorProof.thread?.title || null};
  } catch {}
  save(path.join(run,'native-ready.json'),{pid:process.pid,bridgePid:client.pid,executorId:binding.executorId,readVerified:true,at:now()});
  if (state.error) {
    (state.history ||= []).push({error:state.error,at:state.endedAt});
    delete state.error; delete state.endedAt;
  }
  if (state.inflight && state.inflight.key.startsWith('answer-')) {
    // An answer left in the target's queue can belong to an earlier event than the one now pending (2026-11-25 工區 E:
    // the answer to progress-review-367 waited behind a stuck turn while 372 became pending, and every restart refused
    // to start). It is checked against its own committed decision; only that exact reply is ever confirmed or resent.
    const eventId = state.inflight.key.slice('answer-'.length), event = state.pending?.id === eventId ? state.pending : null, contract = checkSources();
    const commit = require('./decision-commit.cjs');
    let submitted = null;
    try { submitted = event ? commit.load(run,binding,contract,event) : commit.readSnapshot(run,eventId); } catch {}
    need(submitted?.decision?.eventId === eventId && submitted.decision.reply === state.inflight.prompt,
      'Legacy or mismatched in-flight answer requires manual receipt reconciliation; no resend');
  }
  if (state.inflight) await reconcile(state.inflight);
  if (state.phase === 'accepted') return;
  state.phase = state.pending ? 'awaiting_decision' : 'watching';
  checkpoint();
  while (!fs.existsSync(path.join(run,'STOP'))) {
    await settleQueued();
    await handleRateLimits();
    if (await handleAmendRequest()) continue;
    writeDashboard();
    await pushQuestions();
    await reworkDecisions();
    await selfWorkNotice();
    await subagentBuildNotice();
    // The supervisor saw an outage warning: one short note once reads work again, so it does not act on a stale alarm.
    if (state.appHealth?.recoveryNotice && !state.inflight && !state.pending) {
      const since = state.appHealth.recoveryNotice;
      await sendAndRead(binding.supervisorId,'LONG_TASK_WATCH_RECOVERED：背景監看已恢復讀取執行對話（'+clockText(Date.parse(since))+' 起中斷）。不用處理，用一句話結束回合即可。',
        'watch-recovered-'+require('node:crypto').createHash('sha256').update(since).digest('hex').slice(0,12));
      delete state.appHealth.recoveryNotice; checkpoint();
      continue;
    }
    // The quota reading has failed for 30 minutes (claude-quota unreadableAlert): the last good reading is still in use.
    const unreadable = quota.unreadableAlert(state.claudeQuota);
    if (unreadable && state.quotaUnreadableNoticed !== unreadable.since && !state.inflight && !state.pending) {
      state.quotaUnreadableNoticed = unreadable.since; checkpoint();
      if (fallback.supervisorOwner(run,binding.supervisorId))
        await sendAndRead(binding.supervisorId,'LONG_TASK_QUOTA_UNREADABLE：背景程式從 '+clockText(unreadable.since)+' 起讀不到 OpenCodex 的額度（'+unreadable.message.slice(0,120)+
          '）。各角色的模型沿用最後一次讀到的數字，沒有換站，背景程式每 2 分鐘重讀。請把這件事登記到待決帳讓 Jay 知道，其他工作照常。',
          'quota-unreadable-'+require('node:crypto').createHash('sha256').update(String(unreadable.since)).digest('hex').slice(0,12));
      continue;
    }
    if (state.plaintextNotice && !state.inflight && !state.pending) {
      const notice = state.plaintextNotice;
      if (fallback.supervisorOwner(run,binding.supervisorId))
        await sendAndRead(binding.supervisorId,notice.enabled
          ?'LONG_TASK_PLAINTEXT_ON：OpenCodex 的 plaintextV2AgentMessages 又開著了，主線在 ChatGPT 訂閱上也照子代理順位派工（model-route 已照這個算）。不用處理，用一句話結束回合即可。'
          :'LONG_TASK_PLAINTEXT_OFF：背景程式讀到 OpenCodex 的 plaintextV2AgentMessages 沒有開著（'+quota.describePlaintext(state.claudeQuota)+'）。主線在 ChatGPT 訂閱上時，子代理改為只能用 Terra 訂閱，背景程式與 model-route 已照這個算。請把這件事登記到待決帳讓 Jay 知道，其他工作照常。',
          'plaintext-'+(notice.enabled?'on':'off')+'-'+require('node:crypto').createHash('sha256').update(notice.at).digest('hex').slice(0,12));
      delete state.plaintextNotice; checkpoint();
      continue;
    }
    if(await keepLoaded())continue;
    if(!isPaused())scheduleFinalReviews();
    if (state.pending) {
      // While the supervisor reviews a declared wait, its result still goes straight to the executor; the ruling lands after.
      if(state.pending.kind==='waiting'&&state.progressWait?.event?.id===state.pending.id&&!isPaused()){
        const completion=completionNow();
        if(!completion.blocked&&completion.ready.length&&await resumeExecution(completion))continue;
      }
      await pendingDecision();
      if (state.phase === 'accepted') break;
      continue;
    }
    // Executor events reach the supervisor one at a time, oldest first, ahead of dispatch checks and clocks.
    if (state.eventQueue?.length) {
      const event = state.eventQueue.shift();
      state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      continue;
    }
    clock.tickSleep(state);
    // Jay's pause stops every model wake; a real executor event still reaches the supervisor. Resuming restarts the clocks.
    const paused = isPaused();
    if (state.pausedSeen && !paused) { state.lastRealEventAt = Date.now(); state.lastExecutorWorkAt = Date.now(); state.lastProgressReviewAt = Date.now(); state.unplanned = {}; }
    state.pausedSeen = paused;
    if(!paused){
      const completion=completionNow();
      if(!completion.blocked&&(completion.ready.length||state.progressWait&&(state.progressWait.immediate||Date.now()>=state.progressWait.deadline&&!completion.observable))&&await resumeExecution(completion))continue;
    }
    const audit=inspectDispatch(run,binding,state);
    // Repair a known follow-up via the same locked writer the executor uses. Unknown owners,
    // changed package files and work still awaiting integration go through normal review.
    if(!paused && audit.newIssues.some(issue=>issue.kind==='untracked_agent')){
      const snapshot=clock.snapshotOf(run,binding);
      const unlisted=new Set(audit.newIssues.filter(i=>i.kind==='untracked_agent').flatMap(i=>i.affected));
      const workers=pace.agentRuns(binding);
      let repaired=false;
      for(const agent of workers){
        if(!unlisted.has(agent.path)||!snapshot?.workPackageDirectory || !require('./worker-start.cjs').continuation(snapshot,agent))continue;
        if(workers.filter(a=>a.path===agent.path).length!==1 && !snapshot.workerOwners?.[agent.id])continue;
        try{
          execFileSync(process.execPath,[path.join(__dirname,'dispatch.cjs'),'resume-observed',run,path.dirname(snapshot.workPackageDirectory),agent.id,agent.turnId],{timeout:30000,stdio:'ignore'});
          repaired=true;
        }catch{ /* The normal audit retains any unresolved discrepancy. */ }
      }
      if(repaired)continue;
    }
    // The executor learns the run from the binding message; until then, or 15 minutes, a missing snapshot is expected.
    if(!state.executorKnowsRun&&audit.newIssues.some(item=>item.kind==='snapshot_missing')&&Date.now()-(Date.parse(binding.createdAt)||0)<PROGRESS_REVIEW_MS){
      if(Date.now()-lastMentionCheck>=60000){lastMentionCheck=Date.now();state.executorKnowsRun=contains(await rpc('read_thread',{threadId:binding.executorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}),run);}
      if(!state.executorKnowsRun)audit.newIssues=audit.newIssues.filter(item=>item.kind!=='snapshot_missing');
    }
    // Unfilled seats, an unlisted agent and a package-file mismatch are re-checked for 3 minutes before they wake the model.
    audit.newIssues=holdDispatch(state,audit.newIssues);
    const auditEvent=paused?null:dispatchEvent(audit);checkpoint();
    if(auditEvent){markAnnounced(state,auditEvent);state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();continue;}
    const response = await waitExecutor();
    const poll = response.polls?.find(item => item.thread?.id === binding.executorId);
    need(poll,'Bound executor missing from wait result');
    state.executorStatus=poll.thread?.status?.type;
    const supervisorDetail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
    need(supervisorDetail.thread?.id===binding.supervisorId,'Bound supervisor missing from read result');
    const supervisorPoll=supervisorPollFromThread(supervisorDetail);
    checkedWait.observeSupervisorInput(state,supervisorDetail);
    state.reads++; state.lastReadAt = now();
    observeActivity(state,poll,binding);
    observeActivity(state,supervisorPoll,binding,Date.now(),'supervisor');
    const nextCursor = poll.cursor || state.cursor;
    const turn = poll.latestTurn;
    if(!paused && turn?.status==='failed' && ['idle','systemError'].includes(poll.thread?.status?.type) && !state.pending && !state.eventQueue?.length){
      clock.readExecutor(state,binding);
      const receipt=require('./worker-handoff.cjs').workerHandoff(turn,state.workerMailTurn,clock.snapshotOf(run,binding),pace.agentRuns(binding),binding.executorId);
      if(receipt && state.workerHandoffKey!==receipt.key){
        const delivered=completionNow().ready.filter(source=>source.kind==='agent' &&
          receipt.finished.some(row=>row.worker===source.id && row.packageId===source.packageId && row.finishedAt===source.finishedAt));
        checkSources();if(isPaused()||fs.existsSync(path.join(run,'STOP')))continue;
        await sendAndRead(binding.executorId,receipt.prompt,receipt.key);
        for(const source of delivered)(state.executionWakeReceipts||={})[source.key]={
          eventId:turn.id,packageId:source.packageId,deliveryKey:receipt.key,deliveredAt:now()};
        state.workerHandoffKey=receipt.key;state.workerHandoff={turnId:turn.id,workers:receipt.workers};
        if(state.platformError?.since){state.platformErrorHandledSince=state.platformError.since;state.platformError=null;}
        checkpoint();continue;
      }
    }
    if (turn?.status === 'completed' && !state.seen.includes(turn.id) && !(state.eventQueue || []).some(item => item.id === turn.id)) {
      turnEndReads=0;
      await queueSkipped(turn.id);
      state.lastRealEventAt=Date.now();
      if(state.progressWait)state.progressWait=null;
      const event = extractEvent(turn,await exactFinal(turn.id));noteSubmission(event);
      if(['waiting','progress'].includes(event.kind)&&asksSupervisor(event.text))event.kind='question';
      if(event.kind==='waiting'){
        if(waitingHasBlocker(event.text))event.kind='blocked';
        else if(!(event.waitMinutes>=1&&event.waitMinutes<=120))event.kind='protocol_error';
        else{
          // Every declared wait goes to the supervisor at once (Jay 2026-11-08): the executor's own claim no longer keeps
          // both chats idle. Its sources stay registered, so after the ruling a result still goes straight to the executor.
          state.progressWait={event,deadline:Date.now()+event.waitMinutes*WAIT_MINUTE_MS};
          event.completion=executionWake.facts(completionNow());
        }
      }
      const autoKind=paused?null:autoContinueKind(event);
      if(autoKind&&state.lastAutoContinue?.kind!==autoKind){
        const inspection=event.kind==='waiting'?completionNow():{ready:[]};
        await sendAndRead(binding.executorId,autoContinuePrompt(autoKind,event),'auto-'+event.id);
        for(const source of inspection.ready)(state.executionWakeReceipts||={})[source.key]={eventId:event.id,packageId:source.packageId,
          deliveryKey:'auto-'+event.id,deliveredAt:now()};
        fs.appendFileSync(path.join(run,'auto-continue.jsonl'),JSON.stringify({at:now(),eventId:event.id,kind:autoKind,sentTo:'executor'})+'\n');
        state.lastAutoContinue={kind:autoKind,eventId:event.id};state.progressWait=null;
        state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
      }
      if(autoKind){
        // The same stop twice in a row means the fixed reply did not help, so the supervisor looks at why.
        event.autoContinueRepeat={kind:autoKind,previousEventId:state.lastAutoContinue.eventId};
        fs.appendFileSync(path.join(run,'auto-continue.jsonl'),JSON.stringify({at:now(),eventId:event.id,kind:autoKind,sentTo:'supervisor'})+'\n');
      }
      delete state.lastAutoContinue;
      if (event.kind === 'progress') {
        const repeated = state.lastProgressAction === event.nextAction ? (state.repeatedProgress || 0) + 1 : 1;
        state.lastProgressAction = event.nextAction;
        state.repeatedProgress = repeated;
        // A named next step resumes the executor at once (Jay 2026-11-08); waitMinutes or waitFor no longer turn
        // progress into a silent wait (WEB 20:40 and 20:57: progress + waitMinutes 10 with work to do left both chats
        // idle 8-9 minutes). A real wait is reported as waiting and reaches the supervisor.
        if (repeated < 2) {
          if(paused){state.progressWait={event,deadline:Date.now(),immediate:true};state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;}
          await sendAndRead(binding.executorId,
            `長任務續接 ${event.id}：執行你剛才明列的下一步「${event.nextAction}」。沿用原契約及已完成工作；只在下一個真實事件送驗或回報，不重述整份 prompt。`+
            (event.waitMinutes!==null||Array.isArray(event.waitFor)?executionWake.PROGRESS_WAIT_NOTE:''),
            'continue-' + event.id);
          state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
        }
        if(event.kind==='progress')event.kind = 'stalled';
      }
      // Behind any older skipped turn; the loop head hands it to the supervisor in order.
      (state.eventQueue ||= []).push(event);
      state.cursor=nextCursor;checkpoint();
    } else {
      state.cursor=nextCursor;
      if(await recheckDeferred())continue;
      if(!paused){
        const completion=completionNow();
        if(!completion.blocked&&(completion.ready.length||state.progressWait&&(state.progressWait.immediate||Date.now()>=state.progressWait.deadline&&!completion.observable))&&await resumeExecution(completion))continue;
      }
      // An executor's own pace no longer silences the supervisor (Jay 2026-10-07): silence, an overdue or
      // unbaselined package, a stalled test process, a blocked command and repeated failures each start a check.
      const hadCheckedWait=Boolean(state.checkedWait),found=paused?null:clock.check(run,binding,state,turnEndReads>0),silent=paused?false:progressDue(state);
      // A wait that just ended leaves one line in the run whether or not it is reviewed (checked-wait.cjs).
      if(hadCheckedWait&&!state.checkedWait)checkedWait.logRelease(run,state);
      if(silent||found){
        const reasons=[...(silent?[hadCheckedWait&&state.waitReleased?.review!==false?'wait_changed':'silence']:[]),...(found?.reasons||[])];
        const {reasons:_r,pace:_p,...extra}=found||{};
        const event=progressEvent(state,Date.now(),{reasons,pace:found?.pace||clock.paceNow(run,binding,state),overdue:found?.overdue||[],
          baselineMissing:found?.baselineMissing||[],processStalled:found?.processStalled||[],executorBlocked:found?.executorBlocked||[],
          resourceUnderused:found?.resourceUnderused||[],failedCommands:found?.failedCommands||[],
          ...extra});
        state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
        await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
        continue;
      }
      checkpoint();
      await idle(turnEndReads>0?(turnEndReads--,TURN_END_REREAD_MS):WATCH_IDLE_SLEEP_MS);
    }
  }
  if (state.phase !== 'accepted') {state.phase = 'stopped';state.stoppedAt = now();checkpoint();}
}
(async () => {
  try {await watch();}
  catch (error) {
    if(!ownsLock){
      console.error(error.stack || error);process.exitCode=1;
    }else if(fs.existsSync(path.join(run,'STOP'))){
      state.phase='stopped';state.stoppedAt=now();delete state.error;checkpoint();
    }else{
      // A second watcher on the same run means the run is watched; anything else means it is not.
      if(!/Another watcher owns this executor/.test(error.message))
        appFailing(error.rpcError||/timed out|MCP child|Codex app/.test(error.message)?'read':'error',error.message);
      await warnSupervisor().catch(()=>{});
      state.phase = /^(Delivery uncertain:|Legacy or mismatched in-flight answer requires manual receipt reconciliation)/.test(error.message) ? 'needs_reconcile' : 'error';
      state.error = {message:error.message,at:now()};checkpoint();
      console.error(error.stack || error);process.exitCode = 1;
    }
  } finally {
    if (ownsLock) {
      state.endedAt = now();checkpoint();
      try {
        if (read(lockPath).pid === process.pid) fs.unlinkSync(lockPath);
      } catch {}
    }
    await client.close();
  }
})();
