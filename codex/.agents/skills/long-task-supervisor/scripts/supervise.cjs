#!/usr/bin/env node
const fs = require('node:fs');
const contractState = require('./contract-state.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash, read, need, validateContract, validateDecision } = require('./guard.cjs');
const { stillCurrent } = require('./dispatch-audit.cjs');
const pace = require('./pace.cjs');
const pending = require('./pending-decisions.cjs');
const login = require('./login-check.cjs');
const [command, runArg, other] = process.argv.slice(2);
const run = runArg && path.resolve(runArg);
const now = () => new Date().toISOString();
function write(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function load() {
  need(run && fs.existsSync(path.join(run, 'binding.json')), 'Run not initialized');
  const binding = read(path.join(run, 'binding.json'));
  const contractFile = path.join(run, 'contract.json');
  need(hash(contractFile) === binding.contractSha256, 'Locked contract changed');
  return { binding, contract: validateContract(contractState.effective(run,binding), {run, binding}) };
}
function currentTurn(threadId) {
  if (process.env.CODEX_TURN_ID) return process.env.CODEX_TURN_ID;
  const file = pace.sessionFile(threadId);
  need(file, 'Cannot find the supervisor session log for ' + threadId + ' under CODEX_HOME/sessions, including compacted segments');
  const starts = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(row => row && row.type === 'event_msg' && row.payload.type === 'task_started');
  need(starts.length > 0, 'Cannot identify current supervisor turn');
  return starts[starts.length - 1].payload.turn_id;
}
function init() {
  need(run && other && path.isAbsolute(run) && path.isAbsolute(other), 'Use absolute run and input paths');
  need(!fs.existsSync(run), 'Run already exists; resume the existing monitor');
  const input = read(other);
  need(path.isAbsolute(input.projectRoot) && fs.existsSync(input.projectRoot), 'Missing project root');
  need(typeof input.executorId === 'string' && input.executorId && typeof input.supervisorId === 'string' && input.supervisorId, 'Bind exact conversations');
  need(input.executorId !== input.supervisorId, 'Executor and supervisor must be different conversations');
  need(!input.executorCursor || typeof input.executorCursor === 'string', 'Invalid executor cursor');
  need(!input.executorCursor || (typeof input.executorBaselineTurnId === 'string' && input.executorBaselineTurnId), 'Existing executor needs its latest turn ID as baseline');
  if (process.env.CODEX_THREAD_ID) need(process.env.CODEX_THREAD_ID === input.supervisorId, 'Run must be initialized from its supervisor conversation');
  need(Array.isArray(input.allowedRoots) && input.allowedRoots.includes(input.projectRoot) && input.allowedRoots.every(root => path.isAbsolute(root) && fs.existsSync(root)), 'Invalid allowed roots');
  // The same task continued from another run keeps that run's contract, every registered user grant and Jay's open
  // questions; every check runs before the run directory exists, so a refusal leaves nothing half made.
  const { contract, inherited } = contractState.startContract(input);
  validateContract(contract, inherited ? { run: inherited.run, binding: inherited.binding } : {});
  // Every login the task uses was checked before Jay was asked anything (start step 1); the same list goes into the
  // run here, so the hourly check never starts empty (the 2026-10-13 v117 run had no login list at all).
  need(Array.isArray(input.loginSites), 'loginSites is required: the login list checked at start step 1 with login-check.cjs, or [] when the task uses no login');
  login.validate(input.loginSites);
  fs.mkdirSync(path.dirname(run), { recursive: true });
  fs.mkdirSync(run, { recursive: false });
  if (inherited) for (const name of inherited.files) fs.copyFileSync(path.join(inherited.run, name), path.join(run, name));
  else write(path.join(run, 'contract.json'), input.contract);
  login.write(run, input.loginSites);
  const binding = {
    platform: 'codex', projectRoot: input.projectRoot, allowedRoots: input.allowedRoots.concat(run),
    executorId: input.executorId, supervisorId: input.supervisorId,
    callerTurnId: currentTurn(input.supervisorId),
    contractSha256: hash(path.join(run, 'contract.json')), dispatchAudit:{enabled:input.dispatchAudit!==false,snapshot:'dispatch.json',acceptance:true}, createdAt: now(),
    ...(inherited ? { contractStateSha256: inherited.contractStateSha256 || undefined, inheritedFrom: { ...inherited.summary, contractStateSha256: inherited.contractStateSha256, at: now() } } : {})
  };
  write(path.join(run, 'binding.json'), binding);
  write(path.join(run, 'daemon-state.json'), {
    phase: 'starting', cursor: input.executorCursor || null, seen: input.executorBaselineTurnId ? [input.executorBaselineTurnId] : [], messages: [], pending: null,
    inflight: null, reads: 0, starts: 0
  });
  return { run, executorId: binding.executorId, supervisorId: binding.supervisorId, criteria: contract.criteria.length, logins: input.loginSites.length, ...(inherited ? { inherited: inherited.summary } : {}) };
}
function status() {
  const { binding } = load();
  const state = read(path.join(run, 'daemon-state.json'));
  const readyPath = path.join(run, 'native-ready.json');
  const ready = fs.existsSync(readyPath) ? read(readyPath) : null;
  let alive = false;
  if (ready && ready.pid === state.pid) {
    try { process.kill(ready.pid, 0); alive = true; } catch {}
  }
  return {
    run, executorId: binding.executorId, supervisorId: binding.supervisorId,
    phase: state.phase, active: alive && ['watching', 'awaiting_decision', 'needs_user'].includes(state.phase),
    readVerified: Boolean(ready && ready.readVerified && ready.executorId === binding.executorId),
    reads: state.reads, messages: state.messages.length, acceptedAt: state.acceptedAt || null,
    // An amendment waits for both to be empty (contract-state safePoint).
    pending: state.pending?.id || null, inflight: state.inflight ? { key: state.inflight.key, phase: state.inflight.phase || null } : null,
    error: state.error || null
  };
}
function snapshotOf(binding) {try {return read(path.join(run, binding.dispatchAudit?.snapshot || 'dispatch.json'));} catch {return null;}}
// The last assistant texts of the executor, read from its rollout's tail. Tool output fills a Codex rollout
// (the 2026-10-08 executor: 5.6 MB, its last message 667 KB from the end), so the window grows until it has them.
function executorTail(file, count = 3) {
  if (!file) return [];
  const size = fs.statSync(file).size;
  let texts = [];
  for (let length = 262144; ; length *= 4) {
    length = Math.min(size, length);
    const buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
    try {fs.readSync(fd, buffer, 0, length, size - length);} finally {fs.closeSync(fd);}
    texts = [];
    for (const line of buffer.toString('utf8').split('\n')) {
      try {const row = JSON.parse(line), item = row.payload; if (row.type !== 'response_item' || item?.type !== 'message' || item.role !== 'assistant') continue;
        const text = (item.content || []).filter(block => block.type === 'output_text').map(block => block.text).join('\n').trim();
        if (text) texts.push({at: row.timestamp, text: text.slice(-600)});} catch {}
    }
    if (texts.length >= count || length === size || length >= 16777216) return texts.slice(-count);
  }
}
// Everything one review needs, in one call: the event, whether the watcher runs, pace against baselines, the
// executor's latest words and the dispatch picture, instead of probing file by file.
function brief() {
  const {binding} = load(), state = read(path.join(run, 'daemon-state.json')), snapshot = snapshotOf(binding);
  const paced = pace.inFlight(binding, snapshot, Date.now(), state.sleeps), iso = value => value ? new Date(value).toISOString() : null;
  const resolved = Object.entries(state.resolved || {}).slice(-3).map(([id, item]) => ({id, kind:item.event?.kind, reasons:item.event?.reasons,
    disposition:item.obsolete ? 'obsolete' : item.closedWithAcceptance ? 'closed_with_acceptance' : item.decision?.disposition, at:item.event?.at}));
  return {status:status(), pending:require('./review-context.cjs').summary(state.pending), pace:paced, sleeps:(state.sleeps || []).slice(-5),
    // Jay is online for 10 minutes after typing in this chat: one of the two times to ask the whole pending ledger.
    user:{online:Boolean(state.lastUserInputAt && Date.now() - state.lastUserInputAt < require('./guard.cjs').ONLINE_MS), lastInputAt:iso(state.lastUserInputAt)},
    threads:state.threadTitles || null, paused:fs.existsSync(path.join(run, 'PAUSED.json')) ? read(path.join(run, 'PAUSED.json')) : null,
    executorPermission:state.executorSettings || null, reviewRejections:(state.reviewRejections || []).slice(-3),
    instruction:state.instruction || null, modelSwitch:state.modelSwitch || null,
    rateLimits:Object.fromEntries(Object.entries(state.rateLimits || {}).filter(([, item]) => item.until > Date.now()).map(([key, item]) => [key, {until:iso(item.until), basis:item.basis}])),
    // An executor turn the platform ended and the executor has not left yet (Jay 2026-10-14): later wakes see it too.
    platformError:state.platformError ? {...state.platformError, since:iso(state.platformError.since)} : null,
    dashboard:path.join(run, require('./dashboard.cjs').FILE),
    executor:{lastActivityAt:iso(state.lastExecutorActivityAt), lastSubagentActivityAt:iso(Math.max(state.lastSubagentActivityAt || 0, paced.subagentActivityAt || 0)),
      lastProcessActivityAt:iso(state.lastProcessActivityAt), tail:executorTail(state.executorLog || pace.sessionFile(binding.executorId))},
    dispatch:snapshot ? {activity:snapshot.activity, planningRevision:snapshot.planningRevision, ready:(snapshot.packages?.ready || []).map(item => item.id),
      inFlight:(snapshot.packages?.inFlight || []).map(item => item.id), blocked:(snapshot.packages?.blocked || []).map(item => ({id:item.id, kind:item.kind}))} : null,
    // Executor events waiting behind the pending one, oldest first; native-watch hands them over one by one.
    eventQueue:(state.eventQueue || []).map(({id, kind, at}) => ({id, kind, at})),
    // A decision file for the pending event that failed its checks: the watcher kept it unapplied and keeps watching.
    decisionError:(state.pending && state.decisionErrors?.[state.pending.id]) || null,
    // Every decision waiting on Jay, in full, so compaction loses none and a new question is matched against it first.
    pendingDecisions:pending.view(run, state),
    recentDecisions:resolved};
}
function context() {
  const {binding,contract}=load(),state=read(path.join(run,'daemon-state.json'));
  const event=state.pending;
  need(event && event.id===other,'No matching pending event; do not replay an old review');
  const review=require('./review-context.cjs'),saved=review.persist(run,event);
  const operational=['progress_review','dispatch_review','continue'].includes(event.kind);
  return {eventId:event.id,stopped:fs.existsSync(path.join(run,'STOP')),event:saved,
    brief:brief(),...(!operational?{detail:event}:{}),
    authorization:operational ? {command:"supervise.cjs authorization RUN",contractSha256:binding.contractSha256,contractStateSha256:contract.contractStateSha256||null} : review.authorization(contract,binding),
    ...(event.kind==='submission'?{contract}:{}),
    // Questions and blocks queued behind a submission close with its acceptance: read them in full and list them for Jay.
    ...(event.kind==='submission'&&state.eventQueue?.length?{queued:state.eventQueue}:{}),
    instructions:fs.readFileSync(path.join(__dirname,'../references/event-review.md'),'utf8'),
    decisionPath:path.join(run,'decision-'+event.id+'.json')};
}

function decision() {
  need(other && path.isAbsolute(other), 'Use absolute decision path');
  const { binding, contract } = load();
  const state = read(path.join(run, 'daemon-state.json'));
  const input = read(other);
  const resolved = state.resolved?.[input.eventId];
  const event = state.pending?.id === input.eventId ? state.pending : resolved?.event;
  need(event, 'No matching pending or processed event');
  if (resolved) need(hash(other) === resolved.decisionSha256, 'Processed decision changed');
  // A decision processed before v0.25.1 may carry pendingApprovals; it stays valid as recorded.
  const { pendingApprovals: _legacy, ...current } = input;
  const proposed = validateDecision(binding, contract, event, resolved ? current : input, resolved ? [] : state.eventQueue);
  return { eventId: proposed.eventId, disposition: proposed.disposition, valid: true, processed: Boolean(resolved), queued: resolved ? 0 : (state.eventQueue || []).length };
}
function stop() {
  const {binding} = load();
  freshQuote(binding, 'Stop');
  fs.writeFileSync(path.join(run, 'STOP'), now() + '\n');
  return { run, stopRequested: true, quote: other };
}
// A pause or stop must come from words that reached the supervisor in this turn: typed by Jay, or forwarded to it
// by another chat. Codex compaction replays older user messages verbatim with no time and drops forwarded ones;
// on 2026-10-12 04:01 A's supervisor acted on Jay's 10/11 15:12 pause, lifted at 18:15, and stopped work for 5 hours.
function freshQuote(binding, action, quote = other) {
  need(typeof quote === 'string' && quote.trim(), action + ' needs Jay\'s exact words');
  const files = pace.sessionFiles(binding.supervisorId);
  if (!files.length) return; // no local transcript to check against
  const file = files.at(-1), size = fs.statSync(file).size, length = Math.min(size, 32 * 1024 * 1024);
  const buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n');
  const start = lines.findLastIndex(line => line.includes('"task_started"'));
  const squash = text => String(text).replace(/\\[nrt]/g, '').replace(/\s+/g, '');
  const wanted = squash(quote);
  const found = lines.slice(Math.max(0, start)).some(line => {
    if (!line.includes('"response_item"')) return false;
    try {
      const payload = JSON.parse(line).payload || {};
      const user = payload.type === 'message' && payload.role === 'user';
      const forwarded = ['function_call_output', 'custom_tool_call_output'].includes(payload.type);
      return (user || forwarded) && squash(JSON.stringify(payload.content ?? payload.output ?? '')).includes(wanted);
    } catch { return false; }
  });
  need(start >= 0 && found, action + ' quote did not reach the supervisor in this turn; it may be an old message replayed after ' +
    'compaction. Check the decision ledger and pause-history.jsonl before acting（這句不是本回合收到的話，可能是壓縮後重現的舊訊息；先查決策帳與暫停紀錄）');
}
// Jay's pause: the watcher keeps delivering real executor events but wakes no model for clocks or dispatch checks.
function pause() {
  const {binding} = load();
  freshQuote(binding, 'Pause');
  write(path.join(run, 'PAUSED.json'), {quote:other, at:now()});
  return { run, paused:true };
}
function resume() {
  load();
  const file = path.join(run, 'PAUSED.json');
  if (!fs.existsSync(file)) return { run, paused:false };
  fs.appendFileSync(path.join(run, 'pause-history.jsonl'), JSON.stringify({...read(file), resumedAt:now(), resumeQuote:other || null}) + '\n');
  fs.unlinkSync(file);
  return { run, paused:false, resumed:true };
}
// The dashboard's 待你決定 follows the ledger at once, also after acceptance when no watcher rewrites the page.
function refreshDashboard(binding) {
  try {
    const state = read(path.join(run, 'daemon-state.json')), snapshot = snapshotOf(binding);
    require('./dashboard.cjs').write(run, {binding, state, snapshot, paced:pace.inFlight(binding, snapshot, Date.now(), state.sleeps),
      alive:status().active, paused:fs.existsSync(path.join(run, 'PAUSED.json'))});
  } catch {}
}
// Decisions waiting on Jay: raise, reopen, withdraw or answer items in the run ledger. An answer is Jay's words received
// this turn (the pause rule), a saved snapshot of them, or a recorded amendment, never the supervisor's own reading.
function pendingChange() {
  need(other && path.isAbsolute(other), 'Use absolute pending change path');
  const {binding} = load();
  const result = pending.apply(run, read(other), {binding, checkQuote:quote => freshQuote(binding, 'Answer', quote)});
  refreshDashboard(binding);
  return result;
}
// After a reply listed every open item: stamp them, only when the keys are exactly all open ones.
function shown() {
  const {binding} = load();
  const result = pending.shown(run, process.argv.slice(4), {binding});
  refreshDashboard(binding);
  return result;
}
function attachDispatch() {
  const {binding}=load();
  binding.dispatchAudit={enabled:true,snapshot:'dispatch.json',attachedAt:now()};
  write(path.join(run,'binding.json'),binding);
  fs.writeFileSync(path.join(run,'DISPATCH_AUDIT'),now()+'\n');
  return {run,dispatchAudit:true,snapshot:path.join(run,'dispatch.json')};
}
function relocateSources() {
  need(other && path.isAbsolute(other), 'Use absolute source relocation input path');
  need(run && fs.existsSync(path.join(run, 'binding.json')), 'Run not initialized');
  const binding = read(path.join(run, 'binding.json'));
  const contractFile = path.join(run, 'contract.json');
  need(hash(contractFile) === binding.contractSha256, 'Locked contract changed');
  const contract = contractState.effective(run, binding), input = read(other);
  need(input?.schema === 1 && Array.isArray(input.entries) && input.entries.length > 0, 'Invalid source relocation input');
  const locked = new Map(contract.sources.map(source => [source.path, source]));
  const seen = new Set();
  for (const entry of input.entries) {
    const source = locked.get(entry?.originalPath);
    need(source && !seen.has(entry.originalPath), 'Relocation must identify one locked source exactly');
    need(entry.sha256 === source.sha256 && path.isAbsolute(entry.relocatedPath) && entry.relocatedPath !== entry.originalPath,
      'Relocation must preserve the locked source hash at another absolute path');
    need(binding.allowedRoots.some(root => require('./guard.cjs').inside(entry.relocatedPath, root)) &&
      fs.existsSync(entry.relocatedPath) && hash(entry.relocatedPath) === source.sha256,
      'Relocated source missing, outside allowed roots or changed');
    seen.add(entry.originalPath);
  }
  const manifest = {schema:1, contractSha256:binding.contractSha256, entries:input.entries, registeredAt:now()};
  write(path.join(run, 'source-relocations.json'), manifest);
  validateContract(contract, {run, binding});
  return {run, relocated:manifest.entries.length, manifest:path.join(run, 'source-relocations.json')};
}
function dispatchPreflight() {
  const {binding}=load(),state=read(path.join(run,'daemon-state.json'));
  need(state.pending?.id===other&&state.pending.kind==='dispatch_review','No matching pending dispatch review');
  const copy=JSON.parse(JSON.stringify(state)),result=stillCurrent(run,binding,copy,state.pending);
  return {eventId:other,current:Boolean(result.current),snapshot:path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')};
}
try {
  const result = command === 'attach-acceptance' ? contractState.attachAcceptance(run,load().binding,read(other))
    // An authorization that answers pending items closes them with its amendmentId in the same step (pendingKeys).
    : command === 'amend' ? (() => { const {binding} = load(); const result = pending.amend(run, binding, read(other)); refreshDashboard(binding); return result; })()
    : command === 'effective-contract' ? contractState.effective(run,load().binding)
    : command === 'init' ? init()
    : command === 'status' ? status()
    : command === 'brief' ? brief()
    : command === 'context' ? context()
    : command === 'authorization' ? (()=>{const {binding,contract}=load();return require('./review-context.cjs').authorization(contract,binding);})()
    : command === 'decision' ? decision()
    : command === 'pending' ? pendingChange()
    : command === 'ask' ? (load(), pending.ask(run))
    : command === 'shown' ? shown()
    : command === 'relocate-sources' ? relocateSources()
    : command === 'attach-dispatch' ? attachDispatch()
    : command === 'dispatch-preflight' ? dispatchPreflight()
    : command === 'stop' ? stop()
    : command === 'pause' ? pause()
    : command === 'resume' ? resume()
    : (() => { throw Error('Commands: init RUN INPUT, status RUN, brief RUN, context RUN EVENT_ID, authorization RUN, decision RUN FILE, pending RUN FILE, ask RUN, shown RUN KEY..., relocate-sources RUN FILE, attach-dispatch RUN, dispatch-preflight RUN EVENT_ID, pause RUN QUOTE, resume RUN [QUOTE], stop RUN'); })();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
