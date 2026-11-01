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
const dashboard = require('./dashboard.cjs');
const pace = require('./pace.cjs');
const { inspect:inspectDispatch, eventFor:dispatchEvent, markAnnounced, releaseAnnounced, stillCurrent } = require('./dispatch-audit.cjs');
const { activityMarker, supervisorPollFromThread, observeActivity, due:progressDue, eventFor:progressEvent } = require('./progress-review.cjs');
const run = path.resolve(process.argv[2] || '');
const binding = read(path.join(run, 'binding.json'));
const statePath = path.join(run, 'daemon-state.json');
const contractPath = path.join(run, 'contract.json');
const lockPath = path.join(run, 'watcher.lock');
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
const SIZE_LIMIT_TEXT='Tool response exceeds the size limit';
function smallerRead(args){
  if((args.turnLimit||1)>1)return {...args,turnLimit:Math.max(1,Math.floor(args.turnLimit/2))};
  if((args.maxOutputCharsPerItem||500)>500)return {...args,maxOutputCharsPerItem:Math.max(500,Math.floor(args.maxOutputCharsPerItem/4))};
  return null;
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
  for(let attempt=0;;attempt++){
    const response = await client.request('tools/call',{name,arguments:args,_meta:meta},timeout);
    if (!(response.error || response.result?.isError)) {
      if(name==='read_thread'&&args.threadId===binding.executorId)appOk();
      return response.result;
    }
    const oversized=name==='read_thread'&&response.result?.isError&&JSON.stringify(response.result).includes(SIZE_LIMIT_TEXT);
    const smaller=oversized?smallerRead(args):null;
    if(smaller){
      (state.readShrinks||=[]).push({from:{turnLimit:args.turnLimit,maxOutputCharsPerItem:args.maxOutputCharsPerItem},to:{turnLimit:smaller.turnLimit,maxOutputCharsPerItem:smaller.maxOutputCharsPerItem},at:now()});
      if(state.readShrinks.length>20)state.readShrinks.splice(0,state.readShrinks.length-20);
      args=smaller;attempt--;continue;
    }
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
  const detail=unpack(await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
  need(detail.thread?.id===binding.executorId,'Bound executor missing from read');
  return {polls:[{thread:detail.thread,...supervisorPollFromThread(detail)}]};
}
// The 3 minutes between reads still end at once on STOP, and the dashboard stays current.
async function idle(ms){
  const end=Date.now()+ms;
  while(Date.now()<end&&!fs.existsSync(path.join(run,'STOP'))){writeDashboard();await sleep(Math.min(5000,end-Date.now()));}
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
    let alive = false;
    try { process.kill(old.pid, 0); alive = true; } catch {}
    need(!alive, 'Another watcher owns this executor');
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({pid:process.pid,run,at:now()}),{flag:'wx'});
  ownsLock = true;
}
function markSent(target, key) {
  if (!state.messages.some(item => item.key === key)) state.messages.push({target,key,at:now()});
  state.inflight = null;
  checkpoint();
}
function deliveryMarker(key) {return 'LONG_TASK_DELIVERY:' + key;}
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
  await sleep(Number(process.env.LONG_TASK_BUSY_RETRY_MS)||15000);
  }
  if (await provenLost(delivery)) {
    (state.lostDeliveries ||= []).push({target:delivery.target,key:delivery.key,sentAt:delivery.at,resentAt:now()});
    delivery.resentAt = now();
    delivery.sent = await rpc('send_message_to_thread',{threadId:delivery.target,prompt:deliveryMarker(delivery.key)+'\n'+delivery.prompt});
    delivery.at = now(); delivery.phase = 'resent-awaiting-readback';
    checkpoint();
    return reconcile(delivery);
  }
  throw Error('Delivery uncertain: ' + delivery.key);
}
// A thread switched for a rate limit gets its original model back on the first delivery after the limit resets.
function restoreFor(target) {
  const item = state.modelSwitch?.[target];
  return item && !item.restored && Date.now() >= item.until ? item : null;
}
async function sendAndRead(target, prompt, key, options = {}) {
  need(!fs.existsSync(path.join(run,'STOP')),'Run stopped');
  need([binding.executorId,binding.supervisorId].includes(target), 'Target is not bound');
  if (state.messages.some(item => item.key === key)) return;
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
  state.inflight = {target,prompt,key,at:now(),phase:'sending'};
  checkpoint();
  // If the process exits after send but before its receipt, never issue a second send.
  const restore = options.model ? null : restoreFor(target);
  const model = options.model || restore?.original, thinking = options.model ? options.thinking : restore?.effort;
  const sent = await rpc('send_message_to_thread',{threadId:target,prompt:deliveryMarker(key)+'\n'+prompt,
    ...(model?{model}:{}),...(model&&thinking?{thinking}:{})});
  if (restore) restore.restored = now();
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
    waitMinutes:Number.isFinite(item.waitMinutes)?item.waitMinutes:null,text,at:now()};
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
      `決策未套用 ${event.id}：${file} 沒通過檢查，背景監看沒有套用它、照常監看，這個事件仍待決（原檔保留）。錯誤原文：${known.message}\n`+
      `修正後覆寫同一個決策檔，先用 supervise.cjs decision 檢查通過再結束回合；不要重建或重送業務事件。原事件：\n`+require('./review-context.cjs').prompt(run,event),
      'decision-error-'+event.id+'-'+sha256.slice(0,12));
    known.notifiedAt=Date.now();checkpoint();return;
  }
  await changed(run,()=>!fs.existsSync(file)||hash(file)!==sha256);
}
// An executor whose turn ended on an event waits for this ruling (Jay 2026-10-15): its silence, idle and quiet-hour
// clocks restart when the ruling is applied, not at its submission (GDB 05:07 and 08:10: a 21- and a 27-minute review
// each ended in a silence check of an executor that had been waiting for the verdict). Clock reviews do not stop it.
function ruled(event) { if (!['progress_review','dispatch_review'].includes(event.kind)) state.lastDecisionAt = Date.now(); }
async function pendingDecision() {
  const event = state.pending;
  if (!(state.supervisorWake ||= {})[event.id]) {
    const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}));
    state.supervisorWake[event.id]={deliveredAt:null,assistantMarker:assistantMarker(detail),wakeSentAt:null};checkpoint();
  }
  await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-' + event.id);
  const file = path.join(run,'decision-' + event.id + '.json');
  const armed=state.supervisorWake[event.id];
  if(!armed.deliveredAt){armed.deliveredAt=Date.now();checkpoint();}
  if (!fs.existsSync(file)) {
    await changed(run,()=>fs.existsSync(file));
    const wake=state.supervisorWake[event.id];
    if(!fs.existsSync(file)&&!fs.existsSync(path.join(run,'STOP'))&&!wake.wakeSentAt&&Date.now()-wake.deliveredAt>=SUPERVISOR_WAKE_MS){
      const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}));
      if(assistantMarker(detail)===wake.assistantMarker){
        await sendAndRead(binding.supervisorId,
          `監督喚醒補訊 ${event.id}：既有事件已送達，但尚未偵測到本對話的模型輸出。請處理既有 ${deliveryMarker('review-'+event.id)}；不要重建或重送業務事件，先檢查 STOP 與既有 decision。`,
          'wake-review-' + event.id);
        wake.wakeSentAt=Date.now();checkpoint();
      }else{wake.modelStartedAt=Date.now();checkpoint();}
    }
    return;
  }
  const contract = checkSources();
  let decision;
  try { decision = validateDecision(binding,contract,event,read(file),state.eventQueue); }
  catch (error) { await refuseDecision(event,file,error); return; }
  if(event.kind==='dispatch_review'){
    const preflight=stillCurrent(run,binding,state,event);checkpoint();
    if(!preflight.current){releaseAnnounced(state,event);(state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:hash(file)};state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;}
  }
  if(event.kind==='progress_review'){
    const fresh=await waitExecutor();
    const poll=fresh.polls?.find(item=>item.thread?.id===binding.executorId);
    need(poll,'Bound executor missing from progress preflight');
    // Silence ends with new activity; overdue, blocked and the other clock reasons are meant for a busy executor
    // (rule A, Jay 2026-10-13: an overdue check asks about the baseline and scope, so fresh output does not void it).
    if(fs.existsSync(path.join(run,'STOP'))||quietReview(event)&&activityMarker(poll)!==event.activityMarker){
      observeActivity(state,poll,binding);
      (state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:hash(file)};
      state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;
    }
  }
  if (decision.disposition === 'needs_user') {
    state.phase = 'needs_user'; checkpoint();
    const previousDecision = hash(file);
    await changed(run,()=>!fs.existsSync(file) || hash(file)!==previousDecision);
    return;
  }
  if (decision.disposition === 'observe') {
    if(decision.wait){
      const detail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
      observeActivity(state,supervisorPollFromThread(detail),binding,Date.now(),'supervisor');
      checkedWait.observeSupervisorInput(state,detail);
      checkedWait.remember(state,decision,binding);
    }
    state.lastProgressReviewAt=Date.now();ruled(event);
    if(event.kind==='progress_review')state.failedCommands={};
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'watching'; checkpoint(); return;
  }
  if (decision.disposition === 'accept') {
    // Questions and blocks queued behind the accepted submission close with it: context gave the supervisor their full
    // text for its closing list to Jay (Jay's ruling 2026-10-14). The executor is not read while an event is pending,
    // so the queue is the one the supervisor saw.
    for (const item of state.eventQueue || []) { (state.resolved ||= {})[item.id] = {event:item,closedWithAcceptance:event.id}; state.seen.push(item.id); }
    state.eventQueue = [];
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'accepted'; state.acceptedAt = now(); checkpoint(); return;
  }
  await sendAndRead(binding.executorId,decision.reply,'answer-' + event.id);
  ruled(event);
  // Every instruction is tracked against a deadline; the clock wakes the supervisor if nothing acts on it.
  const given = decision.instruction;
  state.instruction = {eventId:event.id,what:given?.what || decision.reply.replace(/\s+/g,' ').slice(0,200),doneWhen:given?.doneWhen || null,
    sentAt:Date.now(),deadlineMs:(given?.deadlineMinutes || 30)*60000,misses:0};
  if(event.kind==='progress_review'){state.lastProgressReviewAt=Date.now();state.failedCommands={};}
  (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
  state.seen.push(event.id); state.pending = null;
  state.phase = 'watching'; checkpoint();
}
const isPaused = () => fs.existsSync(path.join(run,'PAUSED.json'));
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
const clockText = ms => new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
// Rate limits (Jay 2026-10-11, default on): a refused supervisor or executor is told to continue on the next model
// in anthropic/ -> anthropic-apikey/ -> gpt-6.1-sol; a refused subagent makes the executor re-dispatch on the next one.
async function handleRateLimits() {
  if (binding.modelFallback === false) return;
  const subagents = pace.agentRuns(binding).map(item => ({role:'subagent',threadId:item.id,path:item.path}));
  const hits = fallback.scan(state,[{role:'supervisor',threadId:binding.supervisorId},{role:'executor',threadId:binding.executorId},...subagents]);
  for (const hit of hits) {
    const key = fallback.keyOf(hit.model), known = state.rateLimits?.[key];
    if (!known || known.until <= hit.at) (state.rateLimits ||= {})[key] = {since:hit.at,model:hit.model,...fallback.resetFor(key,hit.at)};
    const queue = state.switchQueue ||= [];
    if (!queue.some(item => item.threadId === hit.threadId && item.model === hit.model)) queue.push(hit);
  }
  if (hits.length) { fallback.publish(run,state); checkpoint(); }
  while (state.switchQueue?.length && !state.inflight) {
    const hit = state.switchQueue[0], record = state.modelSwitch?.[hit.threadId];
    const original = record && !record.restored ? record.original : hit.model;
    // A refusal for a model this thread already left is stale.
    if (record && !record.restored && record.current !== hit.model) { state.switchQueue.shift(); checkpoint(); continue; }
    const target = fallback.next(original,hit.model,hit.role,state);
    const until = state.rateLimits?.[fallback.keyOf(original)]?.until || Date.now() + fallback.FALLBACK_MS;
    state.switchQueue.shift();
    if (!target) { state.rateLimitedAll = {threadId:hit.threadId,role:hit.role,model:hit.model,error:hit.error,at:now()}; checkpoint(); continue; }
    if (hit.role === 'subagent') {
      const notice = 'subagent:' + fallback.keyOf(hit.model) + '@' + state.rateLimits[fallback.keyOf(hit.model)].since;
      if ((state.rateNotices ||= []).includes(notice)) { checkpoint(); continue; }
      state.rateNotices.push(notice); checkpoint();
      await sendAndRead(binding.executorId,
        '子代理 ' + (hit.path || hit.threadId.slice(0,8)) + ' 使用 ' + hit.model + ' 遇額度限速（' + hit.error + '）。之後派子代理依 ' + path.join(run,'model-fallback.json') +
        ' 改用 ' + target + ' 同層級模型，' + clockText(until) + ' 後恢復原模型；已完成的成果照常收回，未完成的包改用新模型重派。',
        'rate-subagent-' + require('node:crypto').createHash('sha256').update(notice).digest('hex').slice(0,16));
      continue;
    }
    const settings = fallback.settingsOf(hit.threadId) || {};
    (state.modelSwitch ||= {})[hit.threadId] = {role:hit.role,original,current:target,effort:settings.effort || null,since:Date.now(),until,restored:null};
    state.modelSwitches = (state.modelSwitches || 0) + 1; checkpoint();
    await sendAndRead(hit.threadId,
      '額度限速：' + hit.model + ' 被拒（' + hit.error + '）。本對話自此改用 ' + target + '，預計 ' + clockText(until) + ' 換回 ' + original +
      '。請從中斷處接續原本的工作，不需重述或重做已完成的部分。',
      'model-switch-' + hit.threadId.slice(0,8) + '-' + state.modelSwitches,{model:target,thinking:settings.effort});
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
  if (state.inflight) await reconcile(state.inflight);
  if (state.phase === 'accepted') return;
  state.phase = state.pending ? 'awaiting_decision' : 'watching';
  checkpoint();
  while (!fs.existsSync(path.join(run,'STOP'))) {
    await handleRateLimits();
    writeDashboard();
    // The supervisor saw an outage warning: one short note once reads work again, so it does not act on a stale alarm.
    if (state.appHealth?.recoveryNotice && !state.inflight && !state.pending) {
      const since = state.appHealth.recoveryNotice;
      await sendAndRead(binding.supervisorId,'LONG_TASK_WATCH_RECOVERED：背景監看已恢復讀取執行對話（'+clockText(Date.parse(since))+' 起中斷）。不用處理，用一句話結束回合即可。',
        'watch-recovered-'+require('node:crypto').createHash('sha256').update(since).digest('hex').slice(0,12));
      delete state.appHealth.recoveryNotice; checkpoint();
      continue;
    }
    if (state.pending) {
      await pendingDecision();
      if (state.phase === 'accepted') break;
      continue;
    }
    // Executor events reach the supervisor one at a time, oldest first, ahead of dispatch checks and clocks.
    if (state.eventQueue?.length) {
      const event = state.eventQueue.shift();
      state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
      continue;
    }
    clock.tickSleep(state);
    // Jay's pause stops every model wake; a real executor event still reaches the supervisor. Resuming restarts the clocks.
    const paused = isPaused();
    if (state.pausedSeen && !paused) { state.lastRealEventAt = Date.now(); state.lastExecutorWorkAt = Date.now(); state.lastProgressReviewAt = Date.now(); state.unplanned = {}; }
    state.pausedSeen = paused;
    const audit=inspectDispatch(run,binding,state);
    // The executor learns the run from the binding message; until then, or 15 minutes, a missing snapshot is expected.
    if(!state.executorKnowsRun&&audit.newIssues.some(item=>item.kind==='snapshot_missing')&&Date.now()-(Date.parse(binding.createdAt)||0)<PROGRESS_REVIEW_MS){
      if(Date.now()-lastMentionCheck>=60000){lastMentionCheck=Date.now();state.executorKnowsRun=contains(await rpc('read_thread',{threadId:binding.executorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}),run);}
      if(!state.executorKnowsRun)audit.newIssues=audit.newIssues.filter(item=>item.kind!=='snapshot_missing');
    }
    const auditEvent=paused?null:dispatchEvent(audit);checkpoint();
    if(auditEvent){markAnnounced(state,auditEvent);state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();await sendAndRead(binding.supervisorId,reviewPrompt(auditEvent),'review-'+auditEvent.id);continue;}
    const hostIdle = Date.now() - Math.max(state.lastSupervisorActivityAt || 0, state.lastKeepaliveAt || 0, watchStartedAt);
    if (hostIdle >= KEEPALIVE_MS && !state.inflight) {
      state.lastKeepaliveAt = Date.now(); state.keepalives = (state.keepalives || 0) + 1; checkpoint();
      await sendAndRead(binding.supervisorId, KEEPALIVE_TEXT, 'keepalive-' + state.keepalives);
      continue;
    }
    const response = await waitExecutor();
    const poll = response.polls?.find(item => item.thread?.id === binding.executorId);
    need(poll,'Bound executor missing from wait result');
    const supervisorDetail=unpack(await rpc('read_thread',{threadId:binding.supervisorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
    need(supervisorDetail.thread?.id===binding.supervisorId,'Bound supervisor missing from read result');
    const supervisorPoll=supervisorPollFromThread(supervisorDetail);
    checkedWait.observeSupervisorInput(state,supervisorDetail);
    state.reads++; state.lastReadAt = now();
    observeActivity(state,poll,binding);
    observeActivity(state,supervisorPoll,binding,Date.now(),'supervisor');
    const nextCursor = poll.cursor || state.cursor;
    const turn = poll.latestTurn;
    if (turn?.status === 'completed' && !state.seen.includes(turn.id) && !(state.eventQueue || []).some(item => item.id === turn.id)) {
      await queueSkipped(turn.id);
      state.lastRealEventAt=Date.now();
      if(state.progressWait)state.progressWait=null;
      const event = extractEvent(turn,await exactFinal(turn.id));
      if(['waiting','progress'].includes(event.kind)&&asksSupervisor(event.text))event.kind='question';
      if(event.kind==='waiting'){
        if(waitingHasBlocker(event.text))event.kind='blocked';
        else if(!(event.waitMinutes>=1&&event.waitMinutes<=120))event.kind='protocol_error';
        else{
          state.progressWait={event,deadline:Date.now()+event.waitMinutes*WAIT_MINUTE_MS};
          state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
        }
      }
      if (event.kind === 'progress') {
        const repeated = state.lastProgressAction === event.nextAction ? (state.repeatedProgress || 0) + 1 : 1;
        state.lastProgressAction = event.nextAction;
        state.repeatedProgress = repeated;
        if (repeated < 2 && event.waitMinutes!==null) {
          if(!(event.waitMinutes>=1&&event.waitMinutes<=120))event.kind='protocol_error';
          else{
            state.progressWait={event,deadline:Date.now()+event.waitMinutes*WAIT_MINUTE_MS};
            state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
          }
        } else if (repeated < 2) {
          await sendAndRead(binding.executorId,
            `長任務續接 ${event.id}：執行你剛才明列的下一步「${event.nextAction}」。沿用原契約及已完成工作；只在下一個真實事件送驗或回報，不重述整份 prompt。`,
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
      if(state.progressWait&&Date.now()>=state.progressWait.deadline){
        const event={...state.progressWait.event,kind:'continue',declaredAt:state.progressWait.event.at,
          dueAt:new Date(state.progressWait.deadline).toISOString(),at:now()};
        state.progressWait=null;state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;
        state.pending=event;state.phase='awaiting_decision';checkpoint();
        await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
        continue;
      }
      // An executor's own pace no longer silences the supervisor (Jay 2026-10-07): silence, an overdue or
      // unbaselined package, a stalled test process, a blocked command and repeated failures each start a check.
      const hadCheckedWait=Boolean(state.checkedWait),found=paused?null:clock.check(run,binding,state),silent=paused?false:progressDue(state);
      const allLimited=state.rateLimitedAll&&!state.rateLimitedAll.announced?state.rateLimitedAll:null;
      if(allLimited)allLimited.announced=now();
      if(silent||found||allLimited){
        const reasons=[...(silent?[hadCheckedWait?'wait_changed':'silence']:[]),...(found?.reasons||[]),...(allLimited?['rate_limited_all']:[])];
        const {reasons:_r,pace:_p,...extra}=found||{};
        const event=progressEvent(state,Date.now(),{reasons,pace:found?.pace||clock.paceNow(run,binding,state),overdue:found?.overdue||[],
          baselineMissing:found?.baselineMissing||[],processStalled:found?.processStalled||[],executorBlocked:found?.executorBlocked||[],
          machineSlept:found?.machineSlept||[],resourceUnderused:found?.resourceUnderused||[],failedCommands:found?.failedCommands||[],
          ...extra,...(allLimited?{rateLimitedAll:allLimited}:{})});
        state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
        await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
        continue;
      }
      checkpoint();
      await idle(WATCH_IDLE_SLEEP_MS);
    }
  }
  if (state.phase !== 'accepted') {state.phase = 'stopped';state.stoppedAt = now();checkpoint();}
}
(async () => {
  try {await watch();}
  catch (error) {
    if(fs.existsSync(path.join(run,'STOP'))){
      state.phase='stopped';state.stoppedAt=now();delete state.error;checkpoint();
    }else{
      // A second watcher on the same run means the run is watched; anything else means it is not.
      if(!/Another watcher owns this executor/.test(error.message))
        appFailing(error.rpcError||/timed out|MCP child|Codex app/.test(error.message)?'read':'error',error.message);
      await warnSupervisor().catch(()=>{});
      state.phase = error.message.startsWith('Delivery uncertain:') ? 'needs_reconcile' : 'error';
      state.error = {message:error.message,at:now()};checkpoint();
      console.error(error.stack || error);process.exitCode = 1;
    }
  } finally {
    state.endedAt = now();checkpoint();
    if (ownsLock) {
      try {
        if (read(lockPath).pid === process.pid) fs.unlinkSync(lockPath);
      } catch {}
    }
    await client.close();
  }
})();
