#!/usr/bin/env node
const fs = require('node:fs');
const contractState = require('./contract-state.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash, read, need, validateContract, validateDecision } = require('./guard.cjs');
const { stillCurrent } = require('./dispatch-audit.cjs');
const pace = require('./pace.cjs');
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
  return { binding, contract: validateContract(contractState.effective(run,binding)) };
}
function currentTurn(threadId) {
  if (process.env.CODEX_TURN_ID) return process.env.CODEX_TURN_ID;
  const sessions = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'sessions');
  const files = execFileSync('rg', ['--files', '--hidden', '--glob', '*' + threadId + '.jsonl', sessions], {encoding:'utf8', timeout:10000}).trim().split('\n').filter(Boolean);
  need(files.length === 1, 'Cannot identify exact supervisor session log');
  const starts = fs.readFileSync(files[0], 'utf8').split('\n').filter(Boolean).map(line => {
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
  validateContract(input.contract);
  fs.mkdirSync(path.dirname(run), { recursive: true });
  fs.mkdirSync(run, { recursive: false });
  write(path.join(run, 'contract.json'), input.contract);
  const binding = {
    platform: 'codex', projectRoot: input.projectRoot, allowedRoots: input.allowedRoots.concat(run),
    executorId: input.executorId, supervisorId: input.supervisorId,
    callerTurnId: currentTurn(input.supervisorId),
    contractSha256: hash(path.join(run, 'contract.json')), dispatchAudit:{enabled:input.dispatchAudit!==false,snapshot:'dispatch.json',acceptance:true}, createdAt: now()
  };
  write(path.join(run, 'binding.json'), binding);
  write(path.join(run, 'daemon-state.json'), {
    phase: 'starting', cursor: input.executorCursor || null, seen: input.executorBaselineTurnId ? [input.executorBaselineTurnId] : [], messages: [], pending: null,
    inflight: null, reads: 0, starts: 0
  });
  return { run, executorId: binding.executorId, supervisorId: binding.supervisorId, criteria: input.contract.criteria.length };
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
    disposition:item.obsolete ? 'obsolete' : item.decision?.disposition, at:item.event?.at}));
  return {status:status(), pending:state.pending || null, pace:paced, sleeps:(state.sleeps || []).slice(-5),
    executor:{lastActivityAt:iso(state.lastExecutorActivityAt), lastSubagentActivityAt:iso(Math.max(state.lastSubagentActivityAt || 0, paced.subagentActivityAt || 0)),
      lastProcessActivityAt:iso(state.lastProcessActivityAt), tail:executorTail(state.executorLog || pace.sessionFile(binding.executorId))},
    dispatch:snapshot ? {activity:snapshot.activity, planningRevision:snapshot.planningRevision, ready:(snapshot.packages?.ready || []).map(item => item.id),
      inFlight:(snapshot.packages?.inFlight || []).map(item => item.id), blocked:(snapshot.packages?.blocked || []).map(item => ({id:item.id, kind:item.kind}))} : null,
    recentDecisions:resolved};
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
  const proposed = validateDecision(binding, contract, event, input);
  return { eventId: proposed.eventId, disposition: proposed.disposition, valid: true, processed: Boolean(resolved) };
}
function stop() {
  load();
  fs.writeFileSync(path.join(run, 'STOP'), now() + '\n');
  return { run, stopRequested: true };
}
function attachDispatch() {
  const {binding}=load();
  binding.dispatchAudit={enabled:true,snapshot:'dispatch.json',attachedAt:now()};
  write(path.join(run,'binding.json'),binding);
  fs.writeFileSync(path.join(run,'DISPATCH_AUDIT'),now()+'\n');
  return {run,dispatchAudit:true,snapshot:path.join(run,'dispatch.json')};
}
function dispatchPreflight() {
  const {binding}=load(),state=read(path.join(run,'daemon-state.json'));
  need(state.pending?.id===other&&state.pending.kind==='dispatch_review','No matching pending dispatch review');
  const copy=JSON.parse(JSON.stringify(state)),result=stillCurrent(run,binding,copy,state.pending);
  return {eventId:other,current:Boolean(result.current),snapshot:path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')};
}
try {
  const result = command === 'attach-acceptance' ? contractState.attachAcceptance(run,load().binding,read(other))
    : command === 'amend' ? contractState.append(run,load().binding,read(other))
    : command === 'effective-contract' ? contractState.effective(run,load().binding)
    : command === 'init' ? init()
    : command === 'status' ? status()
    : command === 'brief' ? brief()
    : command === 'decision' ? decision()
    : command === 'attach-dispatch' ? attachDispatch()
    : command === 'dispatch-preflight' ? dispatchPreflight()
    : command === 'stop' ? stop()
    : (() => { throw Error('Commands: init RUN INPUT, status RUN, brief RUN, decision RUN FILE, attach-dispatch RUN, dispatch-preflight RUN EVENT_ID, stop RUN'); })();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
