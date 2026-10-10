#!/usr/bin/env node
// A resident, model-free bridge for one bound executor and one supervisor.
const fs = require('node:fs');
const checkedWait = require('./checked-wait.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('./mcp-client.cjs');
const { hash, read, need, validateContract, validateDecision, quietReview, PROGRESS_REVIEW_MS } = require('./guard.cjs');
const clock = require('./supervisor-clock.cjs');
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
const WATCH_IDLE_SLEEP_MS = Number(process.env.CODEX_WATCH_IDLE_SLEEP_MS) || 15000;
const WAIT_MINUTE_MS = Number(process.env.CODEX_WAIT_MINUTE_MS) || 60000;
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
const TRANSIENT_APP_ERROR='MCP error -32000: Codex app tool request failed';
// A read is safe to repeat; one transient bridge failure stopped a live run for 35 minutes (2026-10-11 equity
// re-review). Sends are never retried here: a repeated send needs receipt reconciliation, not a blind resend.
const READ_RETRY_MS=[2000,5000,15000];
async function rpc(name, args, timeout = 75000) {
  for(let attempt=0;;attempt++){
    const response = await client.request('tools/call',{name,arguments:args,_meta:meta},timeout);
    if (!(response.error || response.result?.isError)) return response.result;
    const transient=name==='read_thread'&&response.error?.code===-32000&&response.error.message===TRANSIENT_APP_ERROR;
    if(transient&&attempt<READ_RETRY_MS.length){
      (state.readRetries||=[]).push({tool:name,attempt:attempt+1,at:now()});if(state.readRetries.length>20)state.readRetries.splice(0,state.readRetries.length-20);
      await sleep(Number(process.env.LONG_TASK_READ_RETRY_MS)||READ_RETRY_MS[attempt]);continue;
    }
    const error=Error(name + ': ' + JSON.stringify(response.error || response.result));
    error.rpcError=response.error;throw error;
  }
}
// A bridge-internal wait failure must not strand the run in a reconnect loop.
// Read the same bound thread through its working read API; keep decisions and receipts unchanged.
let readPolling=false;
async function waitExecutor(timeoutMs) {
  if(!readPolling){
    try{return unpack(await rpc('wait_threads',{
      targets:[{threadId:binding.executorId,...(state.cursor?{afterCursor:state.cursor}:{})}],timeoutMs}));}
    catch(error){
      if(error.rpcError?.code!==-32000 || error.rpcError.message!=='MCP error -32000: Codex app tool request failed')throw error;
      readPolling=true;
      state.waitFallback={tool:'wait_threads',error:error.message,at:now()};checkpoint();
    }
  }
  const detail=unpack(await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500}));
  need(detail.thread?.id===binding.executorId,'Bound executor missing from fallback read');
  return {polls:[{thread:detail.thread,...supervisorPollFromThread(detail)}]};
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
function localReceipt(target, key) {
  const sessions=path.join(process.env.CODEX_HOME || path.join(process.env.HOME,'.codex'),'sessions');
  let files=[];
  try {files=execFileSync('rg',['--files','--hidden','--glob','*'+target+'.jsonl',sessions],{encoding:'utf8',timeout:10000}).trim().split('\n').filter(Boolean);} catch {return false;}
  if (files.length!==1) return false;
  try {execFileSync('rg',['--quiet','--fixed-strings',deliveryMarker(key),files[0]],{timeout:10000});return true;} catch {return false;}
}
async function reconcile(delivery) {
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
    await sleep(2000);
  }
  throw Error('Delivery uncertain: ' + delivery.key);
}
async function sendAndRead(target, prompt, key) {
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
  const sent = await rpc('send_message_to_thread',{threadId:target,prompt:deliveryMarker(key)+'\n'+prompt});
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
    try { item = JSON.parse(text.slice(markerAt + marker.length).trim()); }
    catch { item = {kind:'protocol_error'}; }
  } else item = {kind:'unmarked_final'};
  if (!item || !['submission','question','blocked','progress','waiting','unmarked_final'].includes(item.kind)) item = {kind:'protocol_error'};
  if (item.kind === 'submission' && (!/^sha256:[a-f0-9]{64}$/.test(item.revision) || typeof item.manifest !== 'string')) item = {kind:'protocol_error'};
  if (['progress','waiting'].includes(item.kind) && !(typeof item.nextAction === 'string' && item.nextAction.trim())) item = {kind:'protocol_error'};
  return {id:turn.id,kind:item.kind,revision:item.revision || null,manifest:item.manifest || null,nextAction:item.nextAction || null,
    waitMinutes:Number.isFinite(item.waitMinutes)?item.waitMinutes:null,text,at:now()};
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
  const decision = validateDecision(binding,checkSources(),event,read(file));
  if(event.kind==='dispatch_review'){
    const preflight=stillCurrent(run,binding,state,event);checkpoint();
    if(!preflight.current){releaseAnnounced(state,event);(state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:hash(file)};state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;}
  }
  if(event.kind==='progress_review'){
    const fresh=await waitExecutor(0);
    const poll=fresh.polls?.find(item=>item.thread?.id===binding.executorId);
    need(poll,'Bound executor missing from progress preflight');
    // Silence ends with new activity; overdue, blocked and the other clock reasons are meant for a busy executor.
    const recoveredOverdue=event.reasons?.length===1 && event.reasons[0]==='overdue' &&
      !clock.paceNow(run,binding,state).packages.some(item=>event.overdue?.includes(item.id)&&clock.overdueNeedsReview(item));
    if(fs.existsSync(path.join(run,'STOP'))||recoveredOverdue||quietReview(event)&&activityMarker(poll)!==event.activityMarker){
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
    state.lastProgressReviewAt=Date.now();
    if(event.kind==='progress_review')state.failedCommands={};
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'watching'; checkpoint(); return;
  }
  if (decision.disposition === 'accept') {
    (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'accepted'; state.acceptedAt = now(); checkpoint(); return;
  }
  await sendAndRead(binding.executorId,decision.reply,'answer-' + event.id);
  if(event.kind==='progress_review'){state.lastProgressReviewAt=Date.now();state.failedCommands={};}
  (state.resolved ||= {})[event.id] = {event,decision,decisionSha256:hash(file)};
  state.seen.push(event.id); state.pending = null;
  state.phase = 'watching'; checkpoint();
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
  for (const name of ['wait_threads','read_thread','send_message_to_thread']) need(available.has(name),'Missing Codex App tool ' + name);
  const proof = await rpc('read_thread',{threadId:binding.executorId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:500});
  need(contains(proof,binding.executorId),'Cannot read bound executor conversation');
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
    if (state.pending) {
      await pendingDecision();
      if (state.phase === 'accepted') break;
      continue;
    }
    clock.tickSleep(state);
    const audit=inspectDispatch(run,binding,state);
    // The executor learns the run from the binding message; until then, or 15 minutes, a missing snapshot is expected.
    if(!state.executorKnowsRun&&audit.newIssues.some(item=>item.kind==='snapshot_missing')&&Date.now()-(Date.parse(binding.createdAt)||0)<PROGRESS_REVIEW_MS){
      if(Date.now()-lastMentionCheck>=60000){lastMentionCheck=Date.now();state.executorKnowsRun=contains(await rpc('read_thread',{threadId:binding.executorId,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000}),run);}
      if(!state.executorKnowsRun)audit.newIssues=audit.newIssues.filter(item=>item.kind!=='snapshot_missing');
    }
    const auditEvent=dispatchEvent(audit);checkpoint();
    if(auditEvent){markAnnounced(state,auditEvent);state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();await sendAndRead(binding.supervisorId,reviewPrompt(auditEvent),'review-'+auditEvent.id);continue;}
    const started = Date.now();
    const response = await waitExecutor(45000);
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
    if (turn?.status === 'completed' && !state.seen.includes(turn.id)) {
      state.lastRealEventAt=Date.now();
      if(state.progressWait)state.progressWait=null;
      const event = extractEvent(turn,await exactFinal(turn.id));
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
      state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;
      state.pending = event;
      state.cursor=nextCursor;state.phase = 'awaiting_decision';checkpoint();
      await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-' + event.id);
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
      const hadCheckedWait=Boolean(state.checkedWait),found=clock.check(run,binding,state),silent=progressDue(state);
      if(silent||found){
        const reasons=[...(silent?[hadCheckedWait?'wait_changed':'silence']:[]),...(found?.reasons||[])];
        const event=progressEvent(state,Date.now(),{reasons,pace:found?.pace||clock.paceNow(run,binding,state),overdue:found?.overdue||[],
          baselineMissing:found?.baselineMissing||[],processStalled:found?.processStalled||[],executorBlocked:found?.executorBlocked||[],
          machineSlept:found?.machineSlept||[],resourceUnderused:found?.resourceUnderused||[],failedCommands:found?.failedCommands||[],
          ...(found?.noEventHour?{noEventHour:found.noEventHour}:{}),...(found?.idleWithWork?{idleWithWork:found.idleWithWork}:{})});
        state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
        await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
        continue;
      }
      checkpoint();
      if (readPolling || Date.now() - started < 1000) await sleep(WATCH_IDLE_SLEEP_MS);
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
