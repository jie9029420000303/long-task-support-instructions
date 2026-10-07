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
async function rpc(name, args, timeout = 75000) {
  const response = await client.request('tools/call',{name,arguments:args,_meta:meta},timeout);
  if (response.error || response.result?.isError) throw Error(JSON.stringify(response.error || response.result));
  return response.result;
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
  return validateContract(require('./contract-state.cjs').effective(run,binding));
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
    const readback = await rpc('read_thread',{threadId:delivery.target,turnLimit:8,includeOutputs:false,maxOutputCharsPerItem:20000});
    const confirmed = contains(readback, deliveryMarker(delivery.key)) || localReceipt(delivery.target,delivery.key);
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
  if (!item || !['submission','question','blocked','progress','unmarked_final'].includes(item.kind)) item = {kind:'protocol_error'};
  if (item.kind === 'submission' && (!/^sha256:[a-f0-9]{64}$/.test(item.revision) || typeof item.manifest !== 'string')) item = {kind:'protocol_error'};
  if (item.kind === 'progress' && !(typeof item.nextAction === 'string' && item.nextAction.trim())) item = {kind:'protocol_error'};
  return {id:turn.id,kind:item.kind,revision:item.revision || null,manifest:item.manifest || null,nextAction:item.nextAction || null,text:text.slice(0,8000),at:now()};
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
  const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
  const dispatch=event.kind==='dispatch_review'
    ? '\n這是派工快照檢查，只是要求人工判斷，不代表應增加代理。先重讀目前快照，並核對平台代理 handle/狀態、依賴與可行性、工作區/瀏覽器/帳號/資料庫/測試環境衝突、實際驗收進度。執行對話仍是唯一 dispatcher；若問題已消失，不得送出舊指示。'
    : '';
  const progress=event.kind==='progress_review'
    ? '\n這是監督自己的進度時鐘發出的查核，reasons 列原因，不代表工作必然異常。先執行 '+[process.execPath,path.join(__dirname,'supervise.cjs'),'brief',run].map(shellQuote).join(' ')+' 一次取得在途包速度、執行端最後幾段話、派工現況與最近決策，不逐檔探查；需要時再讀相關原始證據。'
      +'overdue＝在途包扣掉電腦睡眠後達 AI 時程基準 1.5 倍；baseline_missing＝在途包沒有基準；process_stalled＝測試程序 15 分鐘沒產出且查不到還活著；repeat＝同一指令連續失敗 3 次；resource_underused＝派工快照宣告的真實資源有空位，卻有工作在等同一資源。這幾類若確有落後或重複，用 reply 給已授權範圍內的具體加速建議（拆包並行、只跑受影響測試、停止重試改換做法、先收回整合已完成成果、補基準或更新快照）；pace 裡執行端與監督算的基準差超過一半（mismatch）先請執行端說明依據；核對後進度正常就 observe，不傳訊、不打斷執行端。'
      +'executor_blocked＝執行端指令 5 分鐘沒有結果、也沒有程序在跑，多半停在權限確認；machine_slept＝電腦睡眠 5 分鐘以上，整場停住。這兩類只有使用者能處理：用 observe，不傳訊給執行端，在本回合直接請使用者到執行對話處理，或接電源、不闔蓋，並把停擺時長記入決策帳。'
      +'silence＝兩個對話、執行端子代理與在跑的測試程序全部靜止 15 分鐘；wait_changed＝已核對的等待條件變了。這兩類若進度證據不足，向執行端提出可回答的具體進度／阻塞問題；已有可行工作就直接指引推進，用 reply；只剩已核對且未變的等待才可 observe，附 wait:{kind:user_approval/external_result,conditions:[{path,sha256}],resumeAt:僅有既定期限才填}。'
      +'每次都填 progressCheck:{evidence:[具定位的實際查核來源],finding:進度判斷與不確定性,guidance:給執行端的具體下一步}；reply 時 guidance 原文須出現在 reply。不得重問已提出的授權題或照貼上次催促，不要停止事件監看。'
    : '';
  return '長任務監督事件。這是已綁定的原執行對話；背景程式負責等待與傳訊，你這一回合只處理此事件，完成後正常結束即可。'
    + '\n驗收契約：' + contractPath + '；工作紀錄：' + run + '；事件：' + JSON.stringify(event)
    + '\n先以 supervise.cjs effective-contract RUN 讀有效契約、使用者授權更新與排除項；有 contractStateSha256 時必須原樣填入接受決策。\n請依原始條件自行核對候選版與真實證據，不採信執行者的 PASS 自述。'
    + '以 ' + path.join(run,'decision-' + event.id + '.json') + ' 寫入 eventId、disposition（accept/reject/reply/needs_user/observe）、revision（accept 時）、results（accept 時每條含 id,status,method,expected,actual,evidence[{path,sha256}]）、reply（reject/reply 時）、reason（observe 時非空，可另列 pendingApprovals 字串陣列；observe 不送訊也不代表核准）。'
    + '寫完執行 ' + [process.execPath,path.join(__dirname,'supervise.cjs'),'decision',run,path.join(run,'decision-' + event.id + '.json')].map(shellQuote).join(' ')
    + '；只有檢查成功才可宣稱全部驗收通過。未通過要給具體退件。新商業取捨才向使用者確認。不要自行傳訊給執行對話，背景程式會精確送達並讀回。'+dispatch+progress;
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
    const timer = setTimeout(done,15000);
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
  await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-' + event.id);
  const file = path.join(run,'decision-' + event.id + '.json');
  if (!fs.existsSync(file)) {await changed(run,()=>fs.existsSync(file));return;}
  const decision = validateDecision(binding,checkSources(),event,read(file));
  if(event.kind==='dispatch_review'){
    const preflight=stillCurrent(run,binding,state,event);checkpoint();
    if(!preflight.current){releaseAnnounced(state,event);(state.resolved||={})[event.id]={event,obsolete:true,decisionSha256:hash(file)};state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();return;}
  }
  if(event.kind==='progress_review'){
    const fresh=unpack(await rpc('wait_threads',{targets:[{threadId:binding.executorId,...(state.cursor?{afterCursor:state.cursor}:{})}],timeoutMs:0}));
    const poll=fresh.polls?.find(item=>item.thread?.id===binding.executorId);
    need(poll,'Bound executor missing from progress preflight');
    // Silence ends with new activity; overdue, blocked and the other clock reasons are meant for a busy executor.
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
  const listed = await client.request('tools/list',{});
  if (listed.error) throw Error(JSON.stringify(listed.error));
  const available = new Set(listed.result.tools.map(tool => tool.name));
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
    const response = unpack(await rpc('wait_threads',{
      targets:[{threadId:binding.executorId,...(state.cursor ? {afterCursor:state.cursor} : {})}],
      timeoutMs:45000
    }));
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
      const event = extractEvent(turn,await exactFinal(turn.id));
      if (event.kind === 'progress') {
        const repeated = state.lastProgressAction === event.nextAction ? (state.repeatedProgress || 0) + 1 : 1;
        state.lastProgressAction = event.nextAction;
        state.repeatedProgress = repeated;
        if (repeated < 2) {
          await sendAndRead(binding.executorId,
            `長任務續接 ${event.id}：執行你剛才明列的下一步「${event.nextAction}」。沿用原契約及已完成工作；只在下一個真實事件送驗或回報，不重述整份 prompt。`,
            'continue-' + event.id);
          state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
        }
        event.kind = 'stalled';
      }
      state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;
      state.pending = event;
      state.cursor=nextCursor;state.phase = 'awaiting_decision';checkpoint();
      await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-' + event.id);
    } else {
      state.cursor=nextCursor;
      // An executor's own pace no longer silences the supervisor (Jay 2026-10-07): silence, an overdue or
      // unbaselined package, a stalled test process, a blocked command and repeated failures each start a check.
      const hadCheckedWait=Boolean(state.checkedWait),found=clock.check(run,binding,state),silent=progressDue(state);
      if(silent||found){
        const reasons=[...(silent?[hadCheckedWait?'wait_changed':'silence']:[]),...(found?.reasons||[])];
        const event=progressEvent(state,Date.now(),{reasons,pace:found?.pace||clock.paceNow(run,binding,state),overdue:found?.overdue||[],
          baselineMissing:found?.baselineMissing||[],processStalled:found?.processStalled||[],executorBlocked:found?.executorBlocked||[],
          machineSlept:found?.machineSlept||[],resourceUnderused:found?.resourceUnderused||[],failedCommands:found?.failedCommands||[]});
        state.pendingSupervisorInputMarker=state.lastSupervisorInputMarker||null;state.pending=event;state.phase='awaiting_decision';checkpoint();
        await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-'+event.id);
        continue;
      }
      checkpoint();
      if (Date.now() - started < 1000) await sleep(15000);
    }
  }
  if (state.phase !== 'accepted') {state.phase = 'stopped';state.stoppedAt = now();checkpoint();}
}
(async () => {
  try {await watch();}
  catch (error) {
    state.phase = fs.existsSync(path.join(run,'STOP')) ? 'stopped' : error.message.startsWith('Delivery uncertain:') ? 'needs_reconcile' : 'error';
    state.error = {message:error.message,at:now()};
    checkpoint();
    console.error(error.stack || error);
    process.exitCode = 1;
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
