const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const PROGRESS_REVIEW_MS = 60 * 60 * 1000;
function need(ok, message) { if (!ok) throw Error(message); }
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function validateContract(contract) {
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
    need(path.isAbsolute(source.path) && fs.existsSync(source.path) && hash(source.path) === source.sha256, 'Acceptance source missing or changed');
  }
  return contract;
}
function validateDecision(config, contract, event, decision) {
  need(decision && decision.eventId === event.id, 'Decision belongs to another event');
  need(['accept', 'reject', 'reply', 'needs_user', 'observe'].includes(decision.disposition), 'Unknown disposition');
  if (event.kind === 'progress_review') need(decision.disposition === 'reply', 'Progress review requires a visible executor follow-up');
  if (decision.disposition === 'accept') {
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
  } else if (decision.disposition === 'observe') {
    need(typeof decision.reason === 'string' && decision.reason.trim(), 'Missing observe reason');
    for (const field of ['reply', 'delivery', 'revision', 'results']) {
      need(!Object.prototype.hasOwnProperty.call(decision, field), 'Observe cannot include ' + field);
    }
    if (Object.prototype.hasOwnProperty.call(decision, 'pendingApprovals')) {
      need(Array.isArray(decision.pendingApprovals) && decision.pendingApprovals.length > 0 && decision.pendingApprovals.every(item => typeof item === 'string' && item.trim()), 'Invalid pending approvals');
    }
  } else if (decision.disposition === 'needs_user') {
    need(typeof decision.wholeRunPauseSource === 'string' && decision.wholeRunPauseSource.trim(),
      'Whole-run pause requires an explicit user instruction source; use reply or observe for one blocked action');
  }
  return decision;
}
module.exports = { hash, read, inside, need, validateContract, validateDecision, PROGRESS_REVIEW_MS };
