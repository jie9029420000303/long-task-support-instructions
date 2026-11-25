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
// Before the executor leaves the Claude subscription for its reserve, its running Claude subagents may finish (Q49 A).
const DRAIN_MS = Number(process.env.LONG_TASK_QUOTA_DRAIN_MS) || 15 * 60000;
// A switched chat that has produced no successful answer after 15 minutes moves on to the next route.
const SILENT_SWITCH_MS = Number(process.env.LONG_TASK_SILENT_SWITCH_MS) || 15 * 60000;
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
      const found=executionWake.modelReminder(workers,{mainModel:selected,reported:state.modelReminded||[],sonnetEffort:require('./model-route.cjs').sonnetGeneral});
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
  if (detail.thread?.status?.type!=='idle' || !(detail.turns||[]).some(turn=>Number(turn.completedAt)>sentAt)) return false;
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
  const carryRestore=fallback.modelPolicy(binding)==='automatic' && !options.model && due && (!activeRoute.restored || activeRoute.current===activeRoute.original&&!activeRoute.respondedAt);
  if(carryRestore)options={model:activeRoute.original,thinking:activeRoute.effort};
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
    const event=extractEvent(turn,final);
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
    dashboard.write(run,{binding,state,snapshot,paced:clock.paceNow(run,binding,state,snapshot),alive:true,paused:isPaused()});
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
// The same criterion studied twice (then every two studies more) tells Jay like an important mail (Jay 2026-11-24): at
// once in Veda對接對話, held from 00:00 to 08:00 Taipei, and as an open item that Veda's thrice-daily summary repeats
// until he answers. The executor keeps working; nothing waits for the reply.
let cycleCheckAt=0;
async function cycleAlerts(){
  if(state.inflight||Date.now()<cycleCheckAt)return;
  cycleCheckAt=Date.now()+60000;
  try{rework.raiseAlerts(run,binding,{title:state.threadTitles?.supervisor});}
  catch(error){state.cycleAlert={ok:false,error:error.message,at:now()};return;}
  const target=notify.cycleAlertThread();
  if(!target)return;
  for(const item of rework.vedaDue(questions.load(run).items,{sent:key=>notify.sent(run,key)})){
    const key='veda-'+item.key;
    const prompt='LONG_TASK_REWORK_CYCLE：長任務通知（比照重要郵件，執行端照常繼續，不等回覆）。\n'+item.ask+
      '\n題目 key：'+item.key+'；監督對話：'+binding.supervisorId+'。Jay 回覆後，請把他的原話與題目 key 轉到監督對話，註明是 Jay 透過 Veda 回覆，由監督登記；沒回覆就列進每天三次的待決彙整，直到他回覆。';
    try{await rpc('send_message_to_thread',{threadId:target,prompt},20000);notify.mark(run,key,{target});state.cycleAlert={ok:true,key:item.key,at:now()};}
    catch(error){state.cycleAlert={ok:false,key:item.key,error:error.message,at:now()};return;}
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
// Model routes (Jay 2026-10-11, revised 2026-11-21): this background watcher, not the chats, moves each mainline. The
// supervisor moves down only when it is refused itself and returns to Opus once the reset passes. The executor also
// leaves the Claude subscription while the weighted weekly remainder is below the 35% kept for the supervisor or every
// usable account has used 80% of its five-hour window, and returns on the next turn once the reading allows it. A
// refused subagent is re-dispatched in the current executor's family.
// The notice names what actually happened (2026-11-23: ten notices said 額度限速 while no provider had refused for
// quota): model-fallback.cjs switchReason / restoreReason.
async function handleRateLimits() {
  if (fallback.modelPolicy(binding)==='locked') return;
  let dirty=fallback.migrateLimits(state);
  if(fallback.syncApiMonth(state,run))dirty=true;
  if(await quota.refresh(state,Date.now(),run))dirty=true;
  const claudeOk=quota.allowed(state);
  const awaitingOutput=Object.values(state.modelSwitch||{}).filter(record=>!record.restored&&!record.respondedAt);
  const subagents = pace.agentRuns(binding).map(item => ({role:'subagent',threadId:item.id,path:item.path,file:item.sourceFile}));
  const hits = fallback.scan(state,[{role:'supervisor',threadId:binding.supervisorId},{role:'executor',threadId:binding.executorId},...subagents]);
  // A switched chat that took the new model but has produced no successful answer for 15 minutes, or never started a
  // turn on it while idle, is treated like a failing route.
  for (const [id,record] of Object.entries(state.modelSwitch||{})) {
    if (record.restored || record.respondedAt || record.delivery || record.silentAt) continue;
    const actual=fallback.settingsOf(id), after=Boolean(actual&&Date.parse(actual.at)>=record.since);
    // A model chosen by hand after the switch is not a silent route.
    if (after && actual.model!==record.current) continue;
    // Only a fresh switch is judged: a record older than an hour (saved before this check, or whose answer fell
    // outside the first usage read) is left alone.
    // Only awake time counts: a Mac asleep through the window gives the new route no chance to answer (2026-11-23
    // 12:18 switch judged silent at 12:42 after 1,389 seconds of sleep and under a minute awake).
    const waited=clock.awakeSince(state,after?Date.parse(actual.at):record.since);
    if (waited < SILENT_SWITCH_MS || waited >= 4*SILENT_SWITCH_MS || !after && await targetBusy(id)) continue;
    record.silentAt=Date.now();
    hits.push({role:record.role,threadId:id,model:record.current,at:Date.now(),failure:true,silent:true,error:'切換後 '+Math.round(SILENT_SWITCH_MS/60000)+' 分鐘沒有成功回應'});
  }
  for (const hit of hits) {
    const plain=fallback.keyOf(hit.model), open=String(hit.model||'').startsWith('openrouter/');
    const key=open&&hit.status===402?fallback.OPENROUTER_ACCOUNT:fallback.limitKey(hit.role,hit.model), known=state.rateLimits?.[key];
    // The refused thread's own rollout names the reset; its file is kept so later looks can still find that error.
    const files = [hit.file || pace.sessionFile(hit.threadId)].filter(Boolean);
    const reset=hit.quotaReset||(hit.failure?{until:hit.at+fallback.FAILURE_COOLDOWN_MS,basis:hit.silent?fallback.SILENT_BASIS:fallback.FAILURE_BASIS,cooldown:'failure'}:
      open&&hit.status!==402?{until:hit.at+fallback.OPENROUTER_COOLDOWN_MS,basis:fallback.OPENROUTER_BASIS,cooldown:'short'}:fallback.resetFor(plain,hit.at,files));
    if (!known || known.until <= hit.at) (state.rateLimits ||= {})[key] = {since:hit.at,model:hit.model,files,...reset};
    else {
      known.files = [...new Set([...(known.files || []),...files])];
      if(hit.quotaReset?.fromError)Object.assign(known,hit.quotaReset);
    }
    // The Claude API month cap holds for every run until its named reset.
    if(plain==='anthropic-apikey/'&&hit.quotaReset)fallback.recordApiMonth(state,run,hit.quotaReset.until,hit.quotaReset.basis);
    const queue = state.switchQueue ||= [];
    if (!queue.some(item => item.threadId === hit.threadId && item.model === hit.model)) queue.push(hit);
  }
  // Limits saved before 2026-11-09 have no files: use the rollouts of the threads switched for them.
  for (const [key,item] of Object.entries(state.rateLimits || {})) if (!item.files)
    item.files = Object.entries(state.modelSwitch || {}).filter(([,record]) => fallback.limitKey(record.role,record.original) === key)
      .map(([threadId]) => pace.sessionFile(threadId)).filter(Boolean);
  const refined = fallback.refine(state), back = fallback.recovered(state);
  // The executor's Claude limit ends on a later reading that shows the subscription can serve it again; another
  // conversation's success never counts for it.
  const executorClaude=state.rateLimits?.['executor|anthropic/'], reading=state.claudeQuota;
  let quotaBack=false;
  if(executorClaude&&executorClaude.until>Date.now()&&claudeOk&&!reading.unconfigured&&!reading.fiveHourHigh&&reading.at>executorClaude.since+60000){
    executorClaude.until=Date.now();executorClaude.basis='額度讀值顯示訂閱可再供執行端使用';quotaBack=true;
    const record=state.modelSwitch?.[binding.executorId];
    if(record&&!record.restored&&fallback.subscriptionClaude(record.original)&&record.until>Date.now())record.until=Date.now();
  }
  // Keep one durable route decision per role. The next poll can resume it without a new failure or user message.
  const waiting=state.routeWaiting||={};
  if(state.rateLimitedAll?.threadId && !state.routeWaitMigrated){
    const legacy=state.rateLimitedAll;
    waiting[legacy.threadId]={...legacy,at:Date.parse(legacy.at)||Date.now()};
  }
  state.routeWaitMigrated=true;
  if(state.switchQueue?.length){
    for(const hit of state.switchQueue)waiting[hit.threadId]=hit;
    state.switchQueue=[];checkpoint();
  }
  if(awaitingOutput.some(record=>record.respondedAt))checkpoint();
  // This incremental reader also runs while a decision is pending.
  clock.readExecutor(state,binding);
  const executorRecord=state.modelSwitch?.[binding.executorId], executorSwitched=executorRecord&&!executorRecord.restored;
  const executorModel=executorSwitched?executorRecord.current:state.executorSettings?.model;
  // Below the reserve the executor first stops new Claude subagents and lets running ones finish (at most 15 minutes,
  // the mainline keeps working), then moves to Sol with Terra workers (Q49 A).
  let budgetChange=false;
  if(!claudeOk && fallback.subscriptionClaude(executorModel) && !waiting[binding.executorId]){
    if(!state.quotaDrain){state.quotaDrain={since:Date.now(),hold:reading?.hold||null};dirty=true;}
    const drain=state.quotaDrain;
    const running=pace.agentRuns(binding).filter(agent=>agent.active&&catalog.identity(agent.model)?.family==='claude');
    if(!drain.noticeKey && running.length && !isPaused() && !state.inflight){
      drain.noticeKey='quota-reserve-'+fallback.hashId(binding.executorId+'/'+drain.since).slice(0,12);checkpoint();
      await sendAndRead(binding.executorId,'LONG_TASK_QUOTA_RESERVE：'+quota.describe(reading)+'。先停派新的 Claude 子代理；在途子代理完成後（最多 '+
        Math.round(DRAIN_MS/60000)+' 分鐘），背景程式會把本對話改用 Sol，新子代理改用 Terra。等待期間照常工作。',drain.noticeKey);
    }
    budgetChange=!running.length||Date.now()-drain.since>=DRAIN_MS;
  }else if(state.quotaDrain){
    const drain=state.quotaDrain;delete state.quotaDrain;dirty=true;
    if(drain.noticeKey&&claudeOk&&fallback.subscriptionClaude(executorModel)&&!isPaused()&&!state.inflight)
      await sendAndRead(binding.executorId,'LONG_TASK_QUOTA_RESERVE_CLEARED：Claude 訂閱額度回到保留值以上，可照常派 Claude 子代理。',drain.noticeKey+'-cleared');
  }
  const active=Object.entries(state.modelSwitch||{}).filter(([,r])=>!r.restored);
  // The model a mainline is set to run. A turn in progress keeps the model it started with, so a setting applied
  // since then is what counts; the executor's incremental reader already follows it.
  const setModel=id=>{if(id===binding.executorId)return state.executorSettings?.model;const seen=fallback.settingsOf(id);return seen?.applied?.model||seen?.model;};
  // A mainline left on an open-source route without a switch of this watcher (a model chose it under the rule retired
  // 2026-11-21) is moved up like a switched one: open source is only for when every route above it is out.
  const strandedIds=[binding.executorId,binding.supervisorId].filter(id=>!(state.modelSwitch?.[id]&&!state.modelSwitch[id].restored)&&!waiting[id]&&
    String(setModel(id)||'').startsWith('openrouter/'));
  // A mainline set to the OpenAI subscription once it is down to its last 2% moves on to the next route (Jay 2026-11-25).
  const heldIds=[[binding.executorId,'executor'],[binding.supervisorId,'supervisor']].filter(([id,role])=>!waiting[id]&&
    fallback.subscriptionOpenAI(setModel(id))&&fallback.held(state,setModel(id),role)).map(([id])=>id);
  for(const id of Object.keys(state.strandedNotice||{}))if(!strandedIds.includes(id)){delete state.strandedNotice[id];dirty=true;}
  if(hits.length||refined||back||quotaBack||dirty){fallback.publish(run,state,Date.now(),binding.fourthExecutorModel);checkpoint();}
  if(!active.length && !Object.keys(waiting).length && !budgetChange && !strandedIds.length && !heldIds.length)return;
  const ids=new Set([...Object.keys(waiting),...active.map(([id])=>id),...(budgetChange?[binding.executorId]:[]),...strandedIds,...heldIds]);
  for(const id of ids){
    if(state.inflight)return;
    const hit=waiting[id], record=state.modelSwitch?.[id], switched=record&&!record.restored;
    const role=hit?.role||record?.role||(id===binding.supervisorId?'supervisor':'executor');
    if(role==='subagent'){
      const owner=fallback.settingsOf(binding.executorId)?.model;
      const target=fallback.next(hit.model,hit.model,role,state,Date.now(),owner);
      const notice='rate-subagent-'+fallback.hashId(id+'/'+hit.at+'/'+(owner||''));
      await sendAndRead(binding.executorId,'子代理 '+(hit.path||id)+' 遇額度限速。'+(target?'依目前執行主線重派，候選為 '+target+'。':'依執行主線派工清單重查可用模型，先繼續其他工作。'),notice);
      delete waiting[id];checkpoint();continue;
    }
    if(record?.delivery){
      const msg=record.delivery;
      await sendAndRead(id,msg.prompt,msg.key,{model:record.current,thinking:msg.effort});
      delete record.delivery;checkpoint();
    }
    const time=Date.now();
    if(hit && switched && record.current!==hit.model && fallback.settingsOf(id)?.model!==hit.model){
      delete waiting[id];checkpoint();continue;
    }
    const observed=setModel(id);
    const stranded=!switched&&!hit&&String(observed||'').startsWith('openrouter/');
    // A stranded mainline takes the first stop of its role as its original, so it climbs back as the routes free up.
    const original=switched?record.original:hit?.model||(stranded?fallback.chainFor(observed,role)[0]:observed);
    const current=hit?.model||(switched?record.current:observed);
    const chain=fallback.chainFor(original,role);
    // A manually chosen start stays in the chain; the executor never starts on the Claude API key.
    if(!chain.includes(original) && !original?.startsWith('openrouter/') && !(role!=='supervisor'&&fallback.keyOf(original)==='anthropic-apikey/'))chain.unshift(original);
    chain.push(...fallback.openRoutes(role,binding.fourthExecutorModel).map(r=>r.model));
    const candidates=[...new Set(chain)].filter(model=>model && !fallback.limited(state,model,time,role) &&
      !(switched && model===original && record.until>time && !state.rateLimits?.[fallback.limitKey(role,original)]));
    const target=candidates[0];
    // Without its own refusal the supervisor is never moved down to an open-source route.
    if(role==='supervisor' && !hit && !current?.startsWith('openrouter/') && target?.startsWith('openrouter/'))continue;
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
    const budget=budgetChange && id===binding.executorId && !hit;
    // Leaving the OpenAI subscription at its floor is told at once, like the Claude reserve: it takes effect on the next turn.
    const floor=!hit && fallback.subscriptionOpenAI(current) && fallback.held(state,current,role);
    if(!hit && !budget && !floor && switched && current!==target && await targetBusy(id))continue;
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
    const restored=target===original && !original.startsWith('openrouter/');
    const settings=fallback.settingsOf(id)||{};
    // Leaving open source (always max) a stranded mainline takes its role's usual effort: the executor High, the supervisor xhigh.
    const effort=(switched?record.effort:stranded?(role==='supervisor'?'xhigh':'high'):settings.effort)||null;
    const targetEffort=target.startsWith('openrouter/')?'max':effort;
    const until=state.rateLimits?.[fallback.limitKey(role,original)]?.until || time;
    let prompt=isPaused()?'本對話切換至 '+target+'。任務維持暫停，等原恢復指示。':stranded?'模型順位由背景程式切換：開源模型只在前面順位都不能用時使用。本對話改用 '+target+'，從已確認的進度接續。':restored ? (hit?'額度限速恢復時間已過。':'LONG_TASK_MODEL_RESTORED：'+fallback.restoreReason(state.rateLimits?.[fallback.limitKey(role,original)]))+'本對話用 '+target+' 從中斷處接續原工作。':
      budget?'Claude 訂閱保留給監督（'+quota.describe(reading)+'）：本對話改用 '+target+'，從已確認的進度接續。':
      floor?'OpenAI 訂閱留給 Jay 自己用（'+quota.describeOpenAI(reading)+'）：本對話改用 '+target+'，從已確認的進度接續。':
      fallback.switchReason(hit,target,SILENT_SWITCH_MS)+'本對話改用 '+target+'，從已確認的進度接續。';
    // The OpenAI subscription and the OpenAI API key are separate accounts: workers follow the mainline's account path.
    const familyOf=model=>{if(String(model||'').startsWith('openrouter/'))return model;const m=catalog.identity(model);return m?(m.family==='gpt'?'gpt|'+m.provider:m.family):model;};
    if(role==='executor' && !isPaused() && familyOf(current)!==familyOf(target)){
      const worker=familyOf(target)==='claude'?'同一家的 Sonnet（anthropic/，不用 Claude API）':familyOf(target)==='gpt|'?'最新 Terra（OpenAI 訂閱）':
        familyOf(target)==='gpt|openai-apikey/'?'openai-apikey/ 的最新 Terra':'同一完整模型 ID、max 推論';
      prompt+=' 換到不同家模型：在途的舊模型子代理改從工作包交付檔與原件收件，不再向它發訊；新派子代理用'+worker+'。';
    }
    if(role==='supervisor' && !isPaused() && target.startsWith('openrouter/'))prompt+=' 暫代監督依原契約照常收件、查證與派工；要結案的候選照常審查並提交，背景程式會保留原件，交恢復的高階監督逐條複驗結案。';
    if(stranded && told)prompt+='（第 '+(told.count+1)+' 次通知。重送原因：上一則在 '+clockText(Date.parse(told.at))+' 送出，之後開始的新回合仍設定為 '+observed+'。）';
    state.modelSwitches=(state.modelSwitches||0)+1;
    const key='model-switch-'+id.slice(0,8)+'-'+state.modelSwitches;
    (state.modelSwitch||={})[id]={role,original,current:target,effort,since:time,until,restored:null,
      ...(budget||switched&&record.budgetOrigin&&!hit?{budgetOrigin:true}:{}),delivery:{key,prompt,effort:targetEffort}};
    if(stranded)(state.strandedNotice||={})[id]={turnId,at:now(),count:(told?.count||0)+1};
    delete waiting[id];
    if(budget)delete state.quotaDrain;
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
    const event = state.pending, contract = checkSources();
    let submitted = null;
    try { if (event) submitted = require('./decision-commit.cjs').load(run,binding,contract,event); } catch {}
    need(submitted && state.inflight.key === 'answer-' + event.id && submitted.decision.reply === state.inflight.prompt,
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
    await cycleAlerts();
    // The supervisor saw an outage warning: one short note once reads work again, so it does not act on a stale alarm.
    if (state.appHealth?.recoveryNotice && !state.inflight && !state.pending) {
      const since = state.appHealth.recoveryNotice;
      await sendAndRead(binding.supervisorId,'LONG_TASK_WATCH_RECOVERED：背景監看已恢復讀取執行對話（'+clockText(Date.parse(since))+' 起中斷）。不用處理，用一句話結束回合即可。',
        'watch-recovered-'+require('node:crypto').createHash('sha256').update(since).digest('hex').slice(0,12));
      delete state.appHealth.recoveryNotice; checkpoint();
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
      const event = extractEvent(turn,await exactFinal(turn.id));
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
