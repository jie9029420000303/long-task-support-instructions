#!/usr/bin/env node
// A resident, model-free bridge for one bound executor and one supervisor.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createClient } = require('./mcp-client.cjs');
const { hash, read, need, validateContract, validateDecision } = require('./guard.cjs');
const run = path.resolve(process.argv[2] || '');
const binding = read(path.join(run, 'binding.json'));
const statePath = path.join(run, 'daemon-state.json');
const contractPath = path.join(run, 'contract.json');
const lockPath = path.join(run, 'watcher.lock');
let state = read(statePath), ownsLock = false;
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
  return validateContract(read(contractPath));
}
function lock() {
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
  return '長任務監督事件。這是已綁定的原執行對話；背景程式負責等待與傳訊，你這一回合只處理此事件，完成後正常結束即可。'
    + '\n驗收契約：' + contractPath + '；工作紀錄：' + run + '；事件：' + JSON.stringify(event)
    + '\n請依原始條件自行核對候選版與真實證據，不採信執行者的 PASS 自述。'
    + '以 ' + path.join(run,'decision-' + event.id + '.json') + ' 寫入 eventId、disposition（accept/reject/reply/needs_user）、revision（accept 時）、results（accept 時每條含 id,status,method,expected,actual,evidence[{path,sha256}]）、reply（reject/reply 時）。'
    + '寫完執行 node ' + path.join(__dirname,'supervise.cjs') + ' decision ' + run + ' ' + path.join(run,'decision-' + event.id + '.json')
    + '；只有檢查成功才可宣稱全部驗收通過。未通過要給具體退件。新商業取捨才向使用者確認。不要自行傳訊給執行對話，背景程式會精確送達並讀回。';
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
    const poll = setInterval(()=>{if (alreadyChanged()) done();},1000);
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
  if (decision.disposition === 'needs_user') {
    state.phase = 'needs_user'; checkpoint();
    const previousDecision = hash(file);
    await changed(run,()=>!fs.existsSync(file) || hash(file)!==previousDecision);
    return;
  }
  if (decision.disposition === 'accept') {
    (state.resolved ||= {})[event.id] = {event,decisionSha256:hash(file)};
    state.seen.push(event.id); state.pending = null;
    state.phase = 'accepted'; state.acceptedAt = now(); checkpoint(); return;
  }
  await sendAndRead(binding.executorId,decision.reply,'answer-' + event.id);
  (state.resolved ||= {})[event.id] = {event,decisionSha256:hash(file)};
  state.seen.push(event.id); state.pending = null;
  state.phase = 'watching'; checkpoint();
}
async function watch() {
  lock();
  checkSources();
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
    const started = Date.now();
    const response = unpack(await rpc('wait_threads',{
      targets:[{threadId:binding.executorId,...(state.cursor ? {afterCursor:state.cursor} : {})}],
      timeoutMs:45000
    }));
    const poll = response.polls?.find(item => item.thread?.id === binding.executorId);
    need(poll,'Bound executor missing from wait result');
    state.reads++; state.lastReadAt = now();
    const nextCursor = poll.cursor || state.cursor;
    const turn = poll.latestTurn;
    if (turn?.status === 'completed' && !state.seen.includes(turn.id)) {
      const event = extractEvent(turn,await exactFinal(turn.id));
      if (event.kind === 'progress') {
        const repeated = state.lastProgressAction === event.nextAction ? (state.repeatedProgress || 0) + 1 : 1;
        state.lastProgressAction = event.nextAction;
        state.repeatedProgress = repeated;
        if (repeated < 3) {
          await sendAndRead(binding.executorId,
            `長任務續接 ${event.id}：執行你剛才明列的下一步「${event.nextAction}」。沿用原契約及已完成工作；只在下一個真實事件送驗或回報，不重述整份 prompt。`,
            'continue-' + event.id);
          state.seen.push(turn.id);state.cursor=nextCursor;checkpoint();continue;
        }
        event.kind = 'stalled';
      }
      state.pending = event;
      state.cursor=nextCursor;state.phase = 'awaiting_decision';checkpoint();
      await sendAndRead(binding.supervisorId,reviewPrompt(event),'review-' + event.id);
    } else {
      state.cursor=nextCursor;
      checkpoint();
      if (Date.now() - started < 1000) await sleep(15000);
    }
  }
  if (state.phase !== 'accepted') {state.phase = 'stopped';state.stoppedAt = now();checkpoint();}
}
(async () => {
  try {await watch();}
  catch (error) {
    state.phase = error.message.startsWith('Delivery uncertain:') ? 'needs_reconcile' : 'error';
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
