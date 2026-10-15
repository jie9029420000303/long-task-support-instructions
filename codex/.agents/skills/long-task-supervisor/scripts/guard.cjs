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
// An unreasonably long baseline would keep a package from ever counting as overdue (Jay 2026-10-11): one
// question when an hour passes with no real executor event, counted again from each new event.
const NO_EVENT_REVIEW_MS = 60 * 60 * 1000;
// Executor and subagents quiet for 5 minutes while criteria are open or packages are ready: work waits on nobody,
// e.g. the main line sits on one background job (2026-10-07 GDB: 10.2 of 23.7 hours idle, no subagent).
const IDLE_WORK_MS = 5 * 60 * 1000;
// Every supervisor instruction carries a deadline, 30 minutes unless the decision sets one; a miss reroutes, a
// second miss is the supervisor's to handle, never Jay's (Jay 2026-10-11). An open criterion that no package
// covers for 10 minutes wakes the supervisor to plan it (A1/B1). Jay is online when he typed in the supervisor
// chat within 10 minutes. Automations aimed at the bound chats are looked for every 30 minutes.
const INSTRUCTION_DEADLINE_MS = 30 * 60 * 1000, UNPLANNED_MS = 10 * 60 * 1000, ONLINE_MS = 10 * 60 * 1000, AUTOMATION_CHECK_MS = 30 * 60 * 1000;
// A turn the platform ended with an error (Jay 2026-10-14): 2 minutes without the executor resuming wakes the
// supervisor. A rate-limit model switch or a queued message resumes it first; with nothing to resume it, two
// "stream disconnected" turns on the GDB run (2026-10-10 20:30Z, 20:38Z) waited for a 10-minute heartbeat to notice.
const PLATFORM_ERROR_MS = 2 * 60 * 1000;
// Silence and a changed checked wait keep their original meaning; clock reviews fire while the executor is busy.
const quietReview = event => (event.reasons || ['silence']).every(reason => ['silence', 'wait_changed'].includes(reason));
function need(ok, message) { if (!ok) throw Error(message); }
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
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
// queue: executor events waiting behind this one (native-watch eventQueue); empty for a decision already processed.
function validateDecision(config, contract, event, decision, queue = []) {
  need(decision && decision.eventId === event.id, 'Decision belongs to another event');
  need(['accept', 'reject', 'reply', 'needs_user', 'observe'].includes(decision.disposition), 'Unknown disposition');
  // Pending decisions moved to the run ledger (pending-decisions.cjs); a decision that still carries them would lose them.
  need(!Object.prototype.hasOwnProperty.call(decision, 'pendingApprovals'), 'pendingApprovals moved to the run ledger: register with supervise.cjs pending RUN FILE');
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
    // A later submission waiting in the queue may replace this candidate (Jay's ruling 2026-10-14); queued questions
    // and blocks do not stop acceptance and close with it.
    const newer = (queue || []).find(item => item?.kind === 'submission');
    need(!newer, 'A newer submission ' + (newer && newer.id) + ' is queued; observe this one as superseded by it, then handle the queued one');
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
  }
  return decision;
}
module.exports = { hash, read, inside, need, validateContract, validateDecision, PROGRESS_REVIEW_MS,
  REVIEW_INTERVAL_MS, OVERDUE_TIERS, OVERDUE_NEAR, REPEAT_FAILURES, BLOCKED_MS, SLEEP_NOTICE_MS, NO_EVENT_REVIEW_MS, IDLE_WORK_MS,
  INSTRUCTION_DEADLINE_MS, UNPLANNED_MS, ONLINE_MS, AUTOMATION_CHECK_MS, PLATFORM_ERROR_MS, quietReview };
