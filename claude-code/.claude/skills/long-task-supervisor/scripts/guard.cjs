const fs = require('node:fs');
const { validateWait } = require('./checked-wait.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const PROGRESS_REVIEW_MS = 15 * 60 * 1000;
// The supervisor's own clock (Jay 2026-10-07): a progress check at least every 30 minutes, and at once when a
// package runs past its AI-speed baseline or the same failing command repeats three times. Rule A (Jay 2026-10-13):
// each baseline wakes the supervisor at 1.5x and once more at 3x, whether or not the package still produces. An
// overdue wake also brings the other in-flight packages already at 1.2x, and their 1.5x counts as announced (Jay
// 2026-10-15, D3: one IA batch reached 1.5x within 7 minutes and woke the supervisor 3 times).
const REVIEW_INTERVAL_MS = 30 * 60 * 1000, OVERDUE_TIERS = [1.5, 3], OVERDUE_NEAR = 1.2, REPEAT_FAILURES = 3;
// A command with no result after 5 minutes and no process running it waits on a person (a permission prompt);
// a machine asleep for 5 minutes or more stopped the whole run (2026-10-07 GDB run: 93 and 38+40 minutes).
const BLOCKED_MS = 5 * 60 * 1000, SLEEP_NOTICE_MS = 5 * 60 * 1000;
// The executor and every subagent quiet for 5 minutes while acceptance work remains: dispatch what can run in parallel
// instead of waiting on one background job (2026-10-07 GDB: 10.2 of 23.7 hours had the executor idle, no subagent).
const IDLE_WORK_MS = 5 * 60 * 1000;
// An unreasonably long baseline would keep a package from ever counting as overdue (Jay 2026-10-11): one
// question when an hour passes with no real executor event, counted again from each new event.
const NO_EVENT_REVIEW_MS = 60 * 60 * 1000;
// Every supervisor instruction carries a deadline, 30 minutes unless the decision sets one; a miss reroutes, a
// second miss is the supervisor's to handle, never Jay's (Jay 2026-10-11). An open criterion no package covers for
// 10 minutes wakes the supervisor to plan it. Jay is online when he typed in the supervisor chat within 10 minutes.
// An open criterion no package names gets 30 minutes before a check (Jay 2026-10-29; was 10): planning the next package
// often takes longer, and the check only asks while the executor is idle.
const INSTRUCTION_DEADLINE_MS = 30 * 60 * 1000, UNPLANNED_MS = 30 * 60 * 1000, ONLINE_MS = 10 * 60 * 1000;
// The executor is not idle while one of its commands is still running or it registered an external wait (Jay 2026-10-29):
// silence, idle-with-work and unplanned-criteria checks then stay quiet. Overdue tiers, a blocked command, a stalled
// process and the hourly no-event check still wake the supervisor.
function executorBusy(state) {
  // A call that only polls a background job or sleeps is waiting, not work: ready packages still count as idle capacity.
  return Object.values(state?.openTools || {}).some(item => item && typeof item === 'object' && !item.poll && !item.background) ||
    Boolean(state?.progressWait) || state?.checkedWait?.kind === 'external_result';
}
// A turn the platform ended with an error that is not a rate limit naming its reset (Jay 2026-10-14): 2 minutes
// without the executor resuming wakes the supervisor. A background job's notice or a queued message often resumes it
// first (2026-10-02 GDB: 0 minutes); with nothing to resume it, a 401 sat 62 minutes (IA 2026-10-12) and a failed
// DNS lookup 190 (GDB 2026-10-02).
const PLATFORM_ERROR_MS = 2 * 60 * 1000;
// Silence and a changed checked wait keep their original meaning; clock reviews fire while the executor is busy.
const quietReview = event => (event.reasons || ['silence']).every(reason => ['silence', 'wait_changed'].includes(reason));
function need(ok, message) { if (!ok) throw Error(message); }
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
// An archived locked source may move only with its exact hash, registered by relocate-sources.
function relocatedSource(run, binding, source) {
  if (!run || !binding) return false;
  const file = path.join(run, 'source-relocations.json');
  if (!fs.existsSync(file)) return false;
  const manifest = read(file);
  need(manifest?.schema === 1 && manifest.contractSha256 === binding.contractSha256 && Array.isArray(manifest.entries), 'Invalid source relocation manifest');
  const matches = manifest.entries.filter(entry => entry?.originalPath === source.path);
  need(matches.length <= 1, 'Duplicate source relocation');
  if (!matches.length) return false;
  const entry = matches[0];
  need(entry.sha256 === source.sha256 && path.isAbsolute(entry.relocatedPath) &&
    binding.allowedRoots.some(root => inside(entry.relocatedPath, root)) &&
    fs.existsSync(entry.relocatedPath) && hash(entry.relocatedPath) === source.sha256,
    'Relocated acceptance source missing, outside allowed roots or changed');
  return true;
}
function validateContract(contract, context = {}) {
  need(contract && typeof contract === 'object', 'Missing acceptance contract');
  need(typeof contract.goal === 'string' && contract.goal.trim(), 'Missing original goal');
  need(typeof contract.authorization === 'string' && contract.authorization.trim(), 'Missing original authorization');
  need(Array.isArray(contract.criteria) && contract.criteria.length > 0, 'No acceptance criteria');
  const seen = new Set();
  for (const item of contract.criteria) {
    need(item && typeof item.id === 'string' && /^[A-Za-z0-9_-]+$/.test(item.id) && !seen.has(item.id), 'Invalid or duplicate criterion ID');
    need(typeof item.requirement === 'string' && item.requirement.trim(), 'Missing criterion requirement');
    need(typeof item.source === 'string' && item.source.trim(), 'Missing criterion source');
    need(typeof item.verify === 'string' && item.verify.trim(), 'Missing criterion verification');
    seen.add(item.id);
  }
  need(Array.isArray(contract.sources) && contract.sources.length > 0, 'Missing locked source');
  for (const source of contract.sources) {
    need(path.isAbsolute(source.path), 'Acceptance source path must be absolute');
    const originalMatches = fs.existsSync(source.path) && hash(source.path) === source.sha256;
    need(originalMatches || relocatedSource(context.run, context.binding, source), 'Acceptance source missing or changed');
  }
  return contract;
}
function validateDecision(config, contract, event, decision) {
  need(decision && decision.eventId === event.id, 'Decision belongs to another event');
  need(['accept', 'reject', 'reply', 'needs_user', 'observe'].includes(decision.disposition), 'Unknown disposition');
  // What waits on Jay lives in the run's pending-decision ledger (pending-decisions.cjs); a decision carrying the old
  // free-text list would lose it, as the 2026-10-13 GDB status pane kept 2 decided items for 22 more decisions.
  need(!Object.prototype.hasOwnProperty.call(decision, 'pendingApprovals'), 'pendingApprovals moved to the pending-decision ledger: register them with supervise.cjs pending RUN CHANGE.json');
  if (event.kind === 'progress_review') {
    need(['reply','observe'].includes(decision.disposition), 'Progress review requires reply or checked observe');
    const check = decision.progressCheck;
    need(check && Array.isArray(check.evidence) && check.evidence.length > 0 &&
      check.evidence.every(item => typeof item === 'string' && item.trim()), 'Progress review requires checked evidence');
    need(typeof check.finding === 'string' && check.finding.trim(), 'Progress review requires a progress finding');
    if(decision.disposition==='reply') {
    need(typeof check.guidance === 'string' && check.guidance.trim() &&
      typeof decision.reply === 'string' && decision.reply.includes(check.guidance),
      'Progress review requires guidance in the visible executor reply');
    } else if (quietReview(event)) need(decision.wait, 'Progress observe requires a checked wait');
  }
  if(decision.wait){need(decision.disposition==='observe','Only observe can establish a checked wait');validateWait(config,decision.wait);}
  if (decision.disposition === 'accept') {
    if(contract.contractStateSha256)need(decision.contractStateSha256===contract.contractStateSha256,'Acceptance must bind the current effective contract');
    need(event.kind === 'submission', 'Only a submitted candidate can be accepted');
    need(typeof event.revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(event.revision) && decision.revision === event.revision, 'Decision version differs from submission');
    need(typeof event.manifest === 'string' && path.isAbsolute(event.manifest) && config.allowedRoots.some(root => inside(event.manifest, root)), 'Candidate manifest outside allowed roots');
    need(fs.existsSync(event.manifest) && hash(event.manifest) === event.revision.slice(7), 'Candidate manifest missing or changed');
    const manifest = read(event.manifest);
    need(Array.isArray(manifest.files) && manifest.files.length > 0, 'Candidate manifest has no files');
    const candidatePaths = new Set();
    for (const file of manifest.files) {
      need(file && typeof file.path === 'string' && path.isAbsolute(file.path) && config.allowedRoots.some(root => inside(file.path, root)), 'Candidate file outside allowed roots');
      need(!candidatePaths.has(file.path), 'Duplicate candidate file');
      need(fs.existsSync(file.path) && /^[a-f0-9]{64}$/.test(file.sha256) && hash(file.path) === file.sha256, 'Candidate file missing or changed');
      candidatePaths.add(file.path);
    }
    need(Array.isArray(decision.results) && decision.results.length === contract.criteria.length, 'Incomplete acceptance table');
    const rows = new Map();
    for (const row of decision.results) {
      need(row && typeof row.id === 'string' && !rows.has(row.id), 'Duplicate criterion result');
      rows.set(row.id, row);
    }
    for (const criterion of contract.criteria) {
      const row = rows.get(criterion.id);
      need(row && row.status === 'PASS', 'Criterion not independently passed: ' + criterion.id);
      need(typeof row.method === 'string' && row.method.trim(), 'Missing verification method: ' + criterion.id);
      need(Object.prototype.hasOwnProperty.call(row, 'expected') && Object.prototype.hasOwnProperty.call(row, 'actual'), 'Missing expected or actual: ' + criterion.id);
      need(Array.isArray(row.evidence) && row.evidence.length > 0, 'Missing evidence: ' + criterion.id);
      for (const proof of row.evidence) {
        need(proof && path.isAbsolute(proof.path) && config.allowedRoots.some(root => inside(proof.path, root)), 'Evidence outside allowed roots');
        need(fs.existsSync(proof.path) && /^[a-f0-9]{64}$/.test(proof.sha256) && hash(proof.path) === proof.sha256, 'Evidence missing or changed: ' + criterion.id);
      }
    }
    need(rows.size === contract.criteria.length, 'Unknown acceptance criterion');
  } else if (decision.disposition === 'reject' || decision.disposition === 'reply') {
    need(typeof decision.reply === 'string' && decision.reply.trim(), 'Missing specific reply');
    if (decision.instruction !== undefined) {
      const item = decision.instruction;
      need(item && typeof item.what === 'string' && item.what.trim() && typeof item.doneWhen === 'string' && item.doneWhen.trim(),
        'Instruction needs what and doneWhen');
      need(item.deadlineMinutes === undefined || (Number.isFinite(item.deadlineMinutes) && item.deadlineMinutes >= 1 && item.deadlineMinutes <= 240),
        'Instruction deadlineMinutes must be 1-240');
    }
  } else if (decision.disposition === 'observe') {
    need(typeof decision.reason === 'string' && decision.reason.trim(), 'Missing observe reason');
    for (const field of ['reply', 'delivery', 'revision', 'results']) {
      need(!Object.prototype.hasOwnProperty.call(decision, field), 'Observe cannot include ' + field);
    }
  } else if (decision.disposition === 'needs_user') {
    need(typeof decision.wholeRunPauseSource === 'string' && decision.wholeRunPauseSource.trim(),
      'Whole-run pause requires an explicit user instruction source; use reply or observe for one blocked action');
  }
  return decision;
}
// A cross-session message lands as a user turn, or as a queued_command attachment or queue row when it
// arrives mid-turn. The model's own replies are never delivery evidence.
// A compaction summary replays older conversation, delivery markers included: it is history, never a receipt or
// new input (2026-10-12: 8 Claude summaries carried LONG_TASK_DELIVERY markers).
const replayed = row => Boolean(row?.isCompactSummary || row?.isVisibleInTranscriptOnly);
function deliveredText(row) {
  if (!row || row.type === 'assistant' || replayed(row)) return '';
  const content = row.message?.content, parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) for (const block of content) if (block?.type === 'text') parts.push(block.text);
  if (typeof row.attachment?.prompt === 'string') parts.push(row.attachment.prompt);
  if (typeof row.content === 'string') parts.push(row.content);
  return parts.join('\n');
}
function deliveryRecorded(file, requires) {
  return fs.readFileSync(file, 'utf8').split('\n').some(line => {
    try { const text = deliveredText(JSON.parse(line)); return requires.every(item => text.includes(item)); } catch { return false; }
  });
}
// Who wrote a user row: 'human' typed in this chat, 'peer' forwarded by another desktop chat, 'scheduled' sent by an
// automation; null for tool results, notifications and replayed summaries. Older transcripts carry no origin, so a
// plain text row without one is the person.
function inputSource(row) {
  if (!row || row.type !== 'user' || row.isSidechain || replayed(row)) return null;
  if (row.turnOrigin === 'scheduled') return 'scheduled';
  const kind = row.origin?.kind, content = row.message?.content;
  if (kind === 'human' || kind === 'peer') return kind;
  if (kind || row.isMeta) return null;
  return typeof content === 'string' || (Array.isArray(content) && content.some(block => block?.type === 'text')) ? 'human' : null;
}
// The highest overdue tier a package has reached, or null. Whether it still produces or runs a process does not
// matter (rule A, Jay 2026-10-13); a finished package has no ratio and never counts.
function overdueTier(item) { return [...OVERDUE_TIERS].reverse().find(tier => item.ratio >= tier) ?? null; }
// Machine sleep does not count toward an awake-time window, as it does not count toward a package's elapsed time.
function awakeSince(sleeps, from, nowMs = Date.now()) {
  const slept = (sleeps || []).reduce((sum, item) => sum + Math.max(0, Math.min(nowMs, Date.parse(item.to)) - Math.max(from, Date.parse(item.from))), 0);
  return nowMs - from - slept;
}
// Background subagents write their own transcripts beside the executor's; their growth is executor work.
// Subagents of the executor, including the agents its dynamic workflows start one level down in workflows/<runId>/.
function subagentActivityAt(binding) {
  const dir = path.join(path.dirname(binding.executorLog), binding.executorId, 'subagents');
  let latest = 0;
  const scan = folder => { try { for (const name of fs.readdirSync(folder)) if (name.endsWith('.jsonl')) latest = Math.max(latest, fs.statSync(path.join(folder, name)).mtimeMs); } catch {} };
  scan(dir);
  try { for (const entry of fs.readdirSync(path.join(dir, 'workflows'), { withFileTypes: true })) if (entry.isDirectory()) scan(path.join(dir, 'workflows', entry.name)); } catch {}
  return Math.min(latest, Date.now());
}
module.exports = { hash, read, inside, need, validateContract, validateDecision, PROGRESS_REVIEW_MS,
  REVIEW_INTERVAL_MS, OVERDUE_TIERS, OVERDUE_NEAR, REPEAT_FAILURES, BLOCKED_MS, SLEEP_NOTICE_MS, IDLE_WORK_MS, NO_EVENT_REVIEW_MS,
  INSTRUCTION_DEADLINE_MS, UNPLANNED_MS, ONLINE_MS, PLATFORM_ERROR_MS, quietReview, replayed, inputSource,
  overdueTier, awakeSince, deliveredText, deliveryRecorded, subagentActivityAt, executorBusy };
