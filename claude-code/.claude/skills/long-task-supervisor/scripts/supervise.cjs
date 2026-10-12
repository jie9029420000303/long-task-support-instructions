#!/usr/bin/env node
const fs = require('node:fs');
const contractState = require('./contract-state.cjs');
const checkedWait = require('./checked-wait.cjs');
const path = require('node:path');
const { hash, read, need, inside, validateContract, validateDecision, PROGRESS_REVIEW_MS, ONLINE_MS, INSTRUCTION_DEADLINE_MS, quietReview, deliveryRecorded,
  deliveredText, inputSource, replayed, overdueNeedsReview, subagentActivityAt } = require('./guard.cjs');
const review = require('./review-context.cjs');
const { releaseAnnounced, stillCurrent } = require('./dispatch-audit.cjs');
const pace = require('./pace.cjs');
const [command, runArgument, inputArgument] = process.argv.slice(2);
const run = runArgument && path.resolve(runArgument);
const now = () => new Date().toISOString();
function save(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function transcript(id) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects');
  const found = [];
  for (const project of fs.readdirSync(root, {withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    const file = path.join(root, project.name, id + '.jsonl');
    if (fs.existsSync(file)) found.push(file);
  }
  need(found.length === 1, 'Cannot identify one exact Claude Code session transcript for ' + id);
  return found[0];
}
function sessionCwd(file, fallback) {
  const fd=fs.openSync(file,'r'), buffer=Buffer.alloc(65536);
  try {
    const count=fs.readSync(fd,buffer,0,buffer.length,0);
    for (const line of buffer.subarray(0,count).toString('utf8').split('\n')) {
      try {const row=JSON.parse(line);if (row.cwd && fs.existsSync(row.cwd)) return row.cwd;} catch {}
    }
  } finally {fs.closeSync(fd);}
  return fallback;
}
function visibleSupervisor(toolSessionId, projectRoot) {
  const toolLog=transcript(toolSessionId);
  const projects=path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME,'.claude'),'projects');
  const born=fs.statSync(toolLog).birthtimeMs;
  const matches=[];
  for (const project of fs.readdirSync(projects,{withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(projects,project.name),{withFileTypes:true})) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.jsonl$/.test(entry.name)) continue;
      const file=path.join(projects,project.name,entry.name);
      if (file===toolLog || fs.statSync(file).mtimeMs<born) continue;
      const found=fs.readFileSync(file,'utf8').includes(toolSessionId);
      if (found) {
        const cwd=sessionCwd(file,projectRoot);
        const relative=path.relative(cwd,projectRoot);
        if (relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))) matches.push(file);
      }
    }
  }
  need(matches.length<=1,'Multiple visible Claude sessions refer to the tool session; choose the exact conversation');
  const log=matches[0] || toolLog;
  return {id:path.basename(log,'.jsonl'),log,toolSessionId};
}
function load() {
  need(run && fs.existsSync(path.join(run, 'binding.json')), 'Run not initialized');
  const binding = read(path.join(run, 'binding.json'));
  const contractFile = path.join(run, 'contract.json');
  need(hash(contractFile) === binding.contractSha256, 'Locked contract changed');
  return {binding, contract:validateContract(contractState.effective(run,binding), {run, binding})};
}
function init() {
  need(run && inputArgument && path.isAbsolute(runArgument) && path.isAbsolute(inputArgument), 'Use absolute run and input paths');
  need(!fs.existsSync(run), 'Run already exists; resume it');
  const input = read(inputArgument);
  need(path.isAbsolute(input.projectRoot) && fs.existsSync(input.projectRoot), 'Missing project root');
  need(typeof input.supervisorId === 'string' && /^[a-f0-9-]{36}$/.test(input.supervisorId), 'Missing supervisor session ID');
  if (process.env.CLAUDE_SESSION_ID) need(process.env.CLAUDE_SESSION_ID === input.supervisorId, 'Must initialize in the supervisor session');
  need(typeof input.executorPrompt === 'string' && input.executorPrompt.trim(), 'Missing executor prompt');
  need(typeof input.executorId === 'string' && /^[a-f0-9-]{36}$/.test(input.executorId), 'A visible desktop executor session is required');
  need(typeof input.executorDesktopId === 'string' && /^local_[a-f0-9-]{36}$/.test(input.executorDesktopId), 'Missing desktop executor ID');
  need(typeof input.supervisorDesktopId === 'string' && /^local_[a-f0-9-]{36}$/.test(input.supervisorDesktopId), 'Missing desktop supervisor ID');
  need(input.supervisorDesktopId!==input.executorDesktopId,'Supervisor and executor desktop chats must differ');
  need(typeof input.executorMarker === 'string' && /^LONG_TASK_BIND:[a-f0-9-]{36}$/.test(input.executorMarker), 'Missing unique executor marker');
  need(input.executorPrompt.includes(input.executorMarker), 'Executor prompt must contain its bind marker');
  need(Array.isArray(input.allowedRoots) && input.allowedRoots.includes(input.projectRoot) && input.allowedRoots.every(root => path.isAbsolute(root) && fs.existsSync(root)), 'Invalid allowed roots');
  validateContract(input.contract);
  const visible = visibleSupervisor(input.supervisorId,input.projectRoot);
  const supervisorLog = visible.log;
  need(fs.readFileSync(supervisorLog,'utf8').split('\n').some(line=>{
    try{const row=JSON.parse(line);return row.type==='user'&&row.entrypoint==='claude-desktop';}catch{return false;}
  }),'Supervisor is not a Claude Desktop conversation');
  const executorId = input.executorId;
  need(executorId !== visible.id && /^[a-f0-9-]{36}$/.test(executorId), 'Invalid executor session ID');
  const existingLog = transcript(executorId);
  const executorBytes=fs.readFileSync(existingLog);
  let markerOffset=-1,position=0;
  for(const line of executorBytes.toString('utf8').split('\n')){
    try {const row=JSON.parse(line);if(row.type==='user' && row.entrypoint==='claude-desktop' &&
      JSON.stringify(row.message?.content||'').includes(input.executorMarker)) markerOffset=position+Buffer.byteLength(line)+1;} catch {}
    position+=Buffer.byteLength(line)+1;
  }
  need(markerOffset>=0,'Executor prompt was not sent from Claude Desktop');
  fs.mkdirSync(path.dirname(run), {recursive:true});
  fs.mkdirSync(run);
  save(path.join(run, 'contract.json'), input.contract);
  fs.writeFileSync(path.join(run, 'executor-prompt.txt'),
    input.executorPrompt.replaceAll(input.supervisorId,visible.id).replaceAll('{{SUPERVISOR_ID}}',visible.id));
  save(path.join(run, 'binding.json'), {
    platform:'claude-code', projectRoot:input.projectRoot, allowedRoots:input.allowedRoots.concat(run),
    supervisorId:visible.id, supervisorDesktopId:input.supervisorDesktopId, toolSessionId:visible.toolSessionId,
    executorId, executorDesktopId:input.executorDesktopId,
    executorMarker:input.executorMarker, executorLog:existingLog, supervisorLog,
    contractSha256:hash(path.join(run,'contract.json')), promptSha256:hash(path.join(run,'executor-prompt.txt')),
    dispatchAudit:{enabled:input.dispatchAudit!==false,snapshot:'dispatch.json',acceptance:true},
    createdAt:now()
  });
  save(path.join(run, 'daemon-state.json'), {phase:'idle',executorOffset:markerOffset,turnText:[],seen:[],pending:null,reads:0,
    lastExecutorActivityAt:Date.now()});
  return {run,supervisorId:visible.id,toolSessionId:visible.toolSessionId,executorId,executorDesktopId:input.executorDesktopId,criteria:input.contract.criteria.length};
}
function status() {
  const {binding} = load();
  const state = read(path.join(run,'daemon-state.json'));
  const readyFile = path.join(run,'native-ready.json');
  const ready = fs.existsSync(readyFile) ? read(readyFile) : null;
  let alive = false;
  if (ready && ready.pid === state.pid) {try {process.kill(ready.pid,0);alive=true;} catch {}}
  return {run,supervisorId:binding.supervisorId,executorId:binding.executorId,
    phase:state.phase,active:alive && ready?.readVerified === true && state.phase==='watching',
    readVerified:ready?.readVerified === true,reads:state.reads,acceptedAt:state.acceptedAt || null,error:state.error || null,
    unconfirmedDeliveries:Object.keys(state.unconfirmedDeliveries||{})};
}
function snapshotOf(binding) {try {return read(path.join(run, binding.dispatchAudit?.snapshot || 'dispatch.json'));} catch {return null;}}
// The last assistant texts of the executor, read from the transcript's tail only.
function executorTail(file, count = 3) {
  const size = fs.statSync(file).size, length = Math.min(size, 262144), buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
  try {fs.readSync(fd, buffer, 0, length, size - length);} finally {fs.closeSync(fd);}
  const texts = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    try {const row = JSON.parse(line); if (row.type !== 'assistant' || row.isSidechain) continue;
      const text = (row.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      if (text) texts.push({at: row.timestamp, text: text.slice(-600)});} catch {}
  }
  return texts.slice(-count);
}
// Everything one wake needs, in one call: the event, whether the watcher runs, pace against baselines, the
// executor's latest words and the dispatch picture. A wake that reads this instead of probing file by file
// re-reads its long conversation context fewer times (Jay 2026-10-07: about 3M cached tokens per check).
function brief() {
  const {binding} = load(), state = read(path.join(run, 'daemon-state.json')), snapshot = snapshotOf(binding);
  const iso = value => value ? new Date(value).toISOString() : null;
  const resolved = Object.entries(state.resolved || {}).slice(-3).map(([id, item]) => ({id, kind:item.event?.kind, reasons:item.event?.reasons,
    disposition:item.obsolete ? 'obsolete' : item.decision?.disposition, at:item.event?.at}));
  const pausedFile = path.join(run, 'PAUSED.json');
  return {status:status(), pending:review.summary(state.pending), pace:pace.inFlight(binding, snapshot, Date.now(), state.sleeps),
    sleeps:(state.sleeps || []).slice(-5),
    // Jay is online for 10 minutes after typing in the supervisor chat: then list every known and foreseeable approval at once.
    user:{online:Boolean(state.lastUserInputAt && Date.now() - state.lastUserInputAt < ONLINE_MS), lastInputAt:iso(state.lastUserInputAt)},
    paused:fs.existsSync(pausedFile) ? read(pausedFile) : null, reviewRejections:(state.reviewRejections || []).slice(-3),
    instruction:state.instruction || null, rateLimit:state.rateLimit ? {...state.rateLimit, since:iso(state.rateLimit.since), until:iso(state.rateLimit.until)} : null,
    automations:(state.automations || []).slice(-3), dashboard:path.join(run, require('./dashboard.cjs').FILE),
    executor:{lastActivityAt:iso(state.lastExecutorActivityAt), lastSubagentActivityAt:iso(Math.max(state.lastSubagentActivityAt || 0, subagentActivityAt(binding))),
      lastProcessActivityAt:iso(state.lastProcessActivityAt), lastWorkAt:iso(state.lastExecutorWorkAt), lastRealEventAt:iso(state.lastRealEventAt),
      settings:state.executorSettings || null, executorDesktopId:binding.executorDesktopId, tail:executorTail(binding.executorLog)},
    dispatch:snapshot ? {activity:snapshot.activity, planningRevision:snapshot.planningRevision, ready:(snapshot.packages?.ready || []).map(item => item.id),
      inFlight:(snapshot.packages?.inFlight || []).map(item => item.id), blocked:(snapshot.packages?.blocked || []).map(item => ({id:item.id, kind:item.kind}))} : null,
    recentDecisions:resolved, unconfirmedDeliveries:state.unconfirmedDeliveries || {}};
}
// After starting the watcher in the background, wait briefly until it reports a verified read.
function waitActive(seconds) {
  const end = Date.now() + seconds * 1000;
  let value = status();
  while (!value.active && Date.now() < end) {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); value = status();}
  return value;
}
// One call per wake: the pending event, brief, authorization sources and the single-event rules. A submission also
// carries the effective contract; progress and dispatch checks point to the authorization command instead.
function context() {
  const {binding,contract} = load(), state = read(path.join(run,'daemon-state.json')), event = state.pending;
  need(event && event.id === inputArgument, 'No matching pending event; do not replay an old review');
  const saved = review.persist(run, event), operational = ['progress_review','dispatch_review','continue'].includes(event.kind);
  const node = process.execPath, script = path.join(__dirname,'supervise.cjs');
  return {eventId:event.id, stopped:fs.existsSync(path.join(run,'STOP')), event:saved, brief:brief(), ...(!operational ? {detail:event} : {}),
    authorization:operational ? {command:'supervise.cjs authorization RUN', contractSha256:binding.contractSha256, contractStateSha256:contract.contractStateSha256 || null} : review.authorization(contract,binding),
    ...(event.kind === 'submission' ? {contract} : {}),
    ...(event.kind === 'progress_review' ? {preflightArgv:[node,script,'progress-preflight',run,event.id]} : {}),
    ...(event.kind === 'dispatch_review' ? {preflightArgv:event.preflightArgv || [node,script,'dispatch-preflight',run,event.id]} : {}),
    instructions:fs.readFileSync(path.join(__dirname,'../references/event-review.md'),'utf8'),
    decisionPath:path.join(run,'decision-' + event.id + '.json'),
    watchArgv:[node,path.join(__dirname,'claude-watch.cjs'),run]};
}
function decision() {
  need(inputArgument && path.isAbsolute(inputArgument), 'Use absolute decision path');
  const {binding,contract} = load();
  const state = read(path.join(run,'daemon-state.json'));
  const input=read(inputArgument),resolved=state.resolved?.[input.eventId];
  const event=state.pending?.id===input.eventId?state.pending:resolved?.event;
  need(event,'No matching pending or processed event');
  if (resolved) need(hash(inputArgument)===resolved.decisionSha256,'Processed decision changed');
  const value=validateDecision(binding,contract,event,input);
  if (resolved) return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:true};
  if (event.kind==='progress_review') need(state.progressReviewPreflight===event.id,'Progress review requires current preflight before delivery');
  if (value.disposition==='needs_user') return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:false};
  if (value.disposition==='observe' && fs.existsSync(path.join(run,'STOP'))) {
    state.phase='stopped';save(path.join(run,'daemon-state.json'),state);
    return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:false,reason:'Run was stopped before observe could be processed'};
  }
  if (!['accept','observe'].includes(value.disposition)) {
    const marker='LONG_TASK_DELIVERY:'+event.id;
    need(input.delivery?.marker===marker && ['delivered','queued'].includes(input.delivery.status) &&
      typeof input.delivery.messageId==='string' && input.delivery.messageId, 'Missing desktop message receipt');
    const requires=event.kind==='progress_review'?[marker,value.progressCheck.guidance]:[marker];
    // The desktop host holds a message for a busy executor until its turn ends, so a queued receipt cannot
    // be in the transcript yet. Record it as unconfirmed; the watcher confirms it when the row lands.
    if (!deliveryRecorded(binding.executorLog,requires)) {
      need(input.delivery.status==='queued',event.kind==='progress_review'?'Progress guidance not recorded in executor transcript':'Desktop delivery not recorded in executor transcript');
      (state.unconfirmedDeliveries ||= {})[event.id]={requires,messageId:input.delivery.messageId,queuedAt:now()};
    }
  }
  // Every instruction is tracked against a deadline; the clock wakes the supervisor if nothing acts on it.
  if (['reply','reject'].includes(value.disposition)) {
    const given = value.instruction;
    state.instruction = {eventId:event.id, what:given?.what || value.reply.replace(/\s+/g,' ').slice(0,200), doneWhen:given?.doneWhen || null,
      sentAt:Date.now(), deadlineMs:(given?.deadlineMinutes || INSTRUCTION_DEADLINE_MS / 60000) * 60000, misses:0};
  }
  checkedWait.remember(state,value,binding);
  (state.resolved ||= {})[event.id]={event,decision:input,decisionSha256:hash(inputArgument)};
  state.seen.push(event.id);state.pending=null;
  if (event.kind==='progress_review') {state.progressReviewPreflight=null;state.lastProgressReviewAt=Date.now();state.failedCommands={};}
  state.phase=value.disposition==='accept'?'accepted':'idle';
  if (state.phase==='accepted') state.acceptedAt=now();
  save(path.join(run,'daemon-state.json'),state);
  return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:true};
}
// A pause or stop must come from words that reached the supervisor in this turn: typed by Jay (origin human) or
// forwarded by another desktop chat (origin peer). A compaction summary replays older messages with no time; on
// 2026-10-12 a Codex supervisor acted on a pause lifted the day before and stopped work for 5 hours.
function freshQuote(binding, action) {
  need(typeof inputArgument === 'string' && inputArgument.trim(), action + " needs Jay's exact words");
  const file = binding.supervisorLog;
  if (!file || !fs.existsSync(file)) return;
  const size = fs.statSync(file).size, length = Math.min(size, 32 * 1024 * 1024), buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  const rows = buffer.toString('utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const start = rows.findLastIndex(row => row.type === 'assistant' && !row.isSidechain && (row.message?.stop_reason === 'end_turn' || row.isApiErrorMessage));
  const squash = text => String(text).replace(/\s+/g, '');
  const wanted = squash(inputArgument);
  const found = rows.slice(start + 1).some(row => !replayed(row) &&
    (['human','peer'].includes(inputSource(row)) || row.type === 'attachment') && squash(deliveredText(row)).includes(wanted));
  need(found, action + ' quote did not reach the supervisor in this turn; it may be an old message replayed after ' +
    'compaction. Check the decision ledger and pause-history.jsonl before acting（這句不是本回合收到的話，可能是壓縮後重現的舊訊息；先查決策帳與暫停紀錄）');
}
function stop() {const {binding}=load();freshQuote(binding,'Stop');fs.writeFileSync(path.join(run,'STOP'),now()+'\n');return {run,stopRequested:true,quote:inputArgument};}
// Jay's pause: the watcher keeps delivering real executor events but wakes no model for clocks or dispatch checks.
function pause() {
  const {binding} = load();
  freshQuote(binding, 'Pause');
  save(path.join(run, 'PAUSED.json'), {quote:inputArgument, at:now()});
  return {run, paused:true};
}
function resume() {
  load();
  const file = path.join(run, 'PAUSED.json');
  if (!fs.existsSync(file)) return {run, paused:false};
  fs.appendFileSync(path.join(run, 'pause-history.jsonl'), JSON.stringify({...read(file), resumedAt:now(), resumeQuote:inputArgument || null}) + '\n');
  fs.unlinkSync(file);
  return {run, paused:false, resumed:true};
}
// A locked source archived to a new place: only an exact hash match at an allowed path is registered.
function relocateSources() {
  need(inputArgument && path.isAbsolute(inputArgument), 'Use absolute source relocation input path');
  need(run && fs.existsSync(path.join(run, 'binding.json')), 'Run not initialized');
  const binding = read(path.join(run, 'binding.json'));
  need(hash(path.join(run, 'contract.json')) === binding.contractSha256, 'Locked contract changed');
  const contract = contractState.effective(run, binding), input = read(inputArgument);
  need(input?.schema === 1 && Array.isArray(input.entries) && input.entries.length > 0, 'Invalid source relocation input');
  const locked = new Map(contract.sources.map(source => [source.path, source])), seen = new Set();
  for (const entry of input.entries) {
    const source = locked.get(entry?.originalPath);
    need(source && !seen.has(entry.originalPath), 'Relocation must identify one locked source exactly');
    need(entry.sha256 === source.sha256 && path.isAbsolute(entry.relocatedPath) && entry.relocatedPath !== entry.originalPath,
      'Relocation must preserve the locked source hash at another absolute path');
    need(binding.allowedRoots.some(root => inside(entry.relocatedPath, root)) && fs.existsSync(entry.relocatedPath) && hash(entry.relocatedPath) === source.sha256,
      'Relocated source missing, outside allowed roots or changed');
    seen.add(entry.originalPath);
  }
  const manifest = {schema:1, contractSha256:binding.contractSha256, entries:input.entries, registeredAt:now()};
  save(path.join(run, 'source-relocations.json'), manifest);
  validateContract(contract, {run, binding});
  return {run, relocated:manifest.entries.length, manifest:path.join(run, 'source-relocations.json')};
}
function attachDispatch(){const {binding}=load();binding.dispatchAudit={enabled:true,snapshot:'dispatch.json',attachedAt:now()};save(path.join(run,'binding.json'),binding);fs.writeFileSync(path.join(run,'DISPATCH_AUDIT'),now()+'\n');return {run,dispatchAudit:true,snapshot:path.join(run,'dispatch.json')};}
function dispatchPreflight(){const {binding}=load(),state=read(path.join(run,'daemon-state.json'));need(state.pending?.id===inputArgument&&state.pending.kind==='dispatch_review','No matching pending dispatch review');const result=stillCurrent(run,binding,state,state.pending);if(!result.current){releaseAnnounced(state,state.pending);(state.resolved||={})[state.pending.id]={event:state.pending,obsolete:true};state.seen.push(state.pending.id);state.pending=null;state.phase='watching';}save(path.join(run,'daemon-state.json'),state);return {eventId:inputArgument,current:Boolean(result.current),snapshot:path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')};}
function progressPreflight(){const {binding}=load(),state=read(path.join(run,'daemon-state.json'));need(state.pending?.id===inputArgument&&state.pending.kind==='progress_review','No matching pending progress review');const processAt=pace.inFlight(binding,snapshotOf(binding),Date.now(),state.sleeps).processActivityAt||0;const event=state.pending;
  // A pure overdue check is moot once its packages produce again or finish; other packages' activity does not end it.
  const recoveredOverdue=event.reasons?.length===1&&event.reasons[0]==='overdue'&&
    !pace.inFlight(binding,snapshotOf(binding),Date.now(),state.sleeps).packages.some(item=>event.overdue?.includes(item.id)&&overdueNeedsReview(item));
  const current=!fs.existsSync(path.join(run,'STOP'))&&!recoveredOverdue&&(!quietReview(state.pending)||fs.statSync(binding.executorLog).size===state.executorOffset&&Date.now()-Math.max(state.lastExecutorActivityAt,subagentActivityAt(binding),processAt,state.lastProgressReviewAt||0)>=PROGRESS_REVIEW_MS);if(current)state.progressReviewPreflight=state.pending.id;else{(state.resolved||={})[state.pending.id]={event:state.pending,obsolete:true};state.seen.push(state.pending.id);state.pending=null;state.progressReviewPreflight=null;state.phase='watching';}save(path.join(run,'daemon-state.json'),state);return {eventId:inputArgument,current};}
(async()=>{
  try {
    const value=command==='attach-acceptance'?contractState.attachAcceptance(run,load().binding,read(inputArgument))
      :command==='amend'?contractState.append(run,load().binding,read(inputArgument))
      :command==='effective-contract'?contractState.effective(run,load().binding)
      :command==='init'?init():command==='status'?(inputArgument==='--wait-active'?waitActive(Number(process.argv[5])||10):status())
      :command==='brief'?brief():command==='context'?context()
      :command==='authorization'?(()=>{const {binding,contract}=load();return review.authorization(contract,binding);})()
      :command==='pause'?pause():command==='resume'?resume():command==='relocate-sources'?relocateSources()
      :command==='decision'?decision():command==='stop'?stop()
      :command==='attach-dispatch'?attachDispatch():command==='dispatch-preflight'?dispatchPreflight()
      :command==='progress-preflight'?progressPreflight()
      :(()=>{throw Error('Commands: init RUN INPUT, status RUN [--wait-active SECONDS], brief RUN, context RUN EVENT_ID, authorization RUN, decision RUN FILE, relocate-sources RUN FILE, attach-dispatch RUN, dispatch-preflight RUN EVENT_ID, progress-preflight RUN EVENT_ID, pause RUN QUOTE, resume RUN [QUOTE], stop RUN QUOTE; start the desktop watcher in App background Bash');})();
    console.log(JSON.stringify(value));
  } catch(error) {console.error(error.message);process.exitCode=1;}
})();
