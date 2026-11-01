// An explicit, atomic submission of the exact decision and the event/contract it was reviewed against.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need } = require('./guard.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const eventHash = event => digest(JSON.stringify(event));
function file(run, id) {
  need(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Invalid event id');
  return path.join(run, 'committed-decision-' + id + '.json');
}
function draft(run, id) {
  need(typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id), 'Invalid event id');
  return path.join(run, 'draft-decision-' + id + '.json');
}
function live(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw Error('Cannot verify watcher process: ' + error.message);
  }
}
function assertNoLegacyWatcher(run) {
  for (const name of ['watcher.lock', 'runtime-state.json']) {
    const target = path.join(run, name);
    if (!fs.existsSync(target)) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch { throw Error('Cannot verify watcher version; stop and reconcile it before migration: ' + target); }
    need(Number.isInteger(info.pid) && info.pid > 0, 'Cannot verify watcher PID; stop and reconcile it before migration: ' + target);
    if (live(info.pid)) need(info.decisionProtocol === 'explicit-decision-v1',
      'Legacy watcher or parent is still running; stop it and reconcile legacy drafts and receipts before using new submission: ' + target);
  }
}
function submit(run, binding, contract, event, state, decision, bytes) {
  assertNoLegacyWatcher(run);
  const target = file(run, event.id);
  const lock = target + '.lock';
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw Error('Another submission is in progress or its lock needs reconciliation: ' + lock);
    throw error;
  }
  try {
  fs.writeFileSync(lockFd, JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  // Reload under the lock so concurrent submissions cannot act on an old needs_user or rejection state.
  state = JSON.parse(fs.readFileSync(path.join(run, 'daemon-state.json'), 'utf8'));
  need(!fs.existsSync(path.join(run, 'STOP')), 'Run stopped');
  need(state.pending?.id === event.id && eventHash(state.pending) === eventHash(event), 'Pending event changed during submission');
  need(!state.inflight || state.inflight.key !== 'answer-' + event.id, 'Delivery already in flight; reconcile first');
  need(!(state.messages || []).some(item => item.key === 'answer-' + event.id), 'Delivery already recorded; reconcile first');
  const entry = {version:1, eventId:event.id, eventSha256:eventHash(event), contractSha256:binding.contractSha256,
    contractStateSha256:contract.contractStateSha256 || null, decisionSha256:digest(bytes), decisionRaw:bytes.toString('utf8'), decision};
  const serialized = JSON.stringify(entry, null, 2) + '\n';
  const snapshotSha256 = digest(serialized);
  const snapshotName = 'decision-snapshot-' + event.id + '-' + snapshotSha256 + '.json';
  const snapshot = path.join(run, snapshotName);
  const pointer = JSON.stringify({version:1,eventId:event.id,snapshotName,snapshotSha256}) + '\n';
  const temporary = path.join(run, '.decision-submit-' + process.pid + '-' + crypto.randomBytes(12).toString('hex'));
  const snapshotTemp = temporary + '-snapshot';
  try {
    if (fs.existsSync(target)) {
      const existingPointer = fs.readFileSync(target, 'utf8');
      let oldPointer;
      try { oldPointer = JSON.parse(existingPointer); } catch {}
      const pointerIdentifiesSnapshot = oldPointer?.version === 1 && oldPointer.eventId === event.id &&
        /^[a-f0-9]{64}$/.test(oldPointer.snapshotSha256) &&
        oldPointer.snapshotName === 'decision-snapshot-' + event.id + '-' + oldPointer.snapshotSha256 + '.json';
      let old;
      if (pointerIdentifiesSnapshot) {
        try { old = readSnapshot(run,event.id); }
        catch (error) { throw Error('Submitted snapshot missing or damaged; preserve the pointer and snapshot and manually reconcile before proceeding: ' + error.message); }
      }
      if (existingPointer === pointer) return {submitted:true, duplicate:true, decisionSha256:entry.decisionSha256};
      const rejected = state.decisionErrors?.[event.id]?.sha256 === digest(existingPointer);
      const waiting = state.phase === 'needs_user' && old?.decision?.disposition === 'needs_user' &&
        state.waitingDecisionSha256 === old.decisionSha256;
      need(waiting || rejected, 'Decision already submitted; reconcile before changing');
    }
    // Save each reviewed version permanently before publishing the pointer. The watcher only reads the pointer.
    fs.writeFileSync(snapshotTemp, serialized, {flag:'wx'});
    try { fs.linkSync(snapshotTemp, snapshot); }
    catch (error) {
      if (error.code !== 'EEXIST' || digest(fs.readFileSync(snapshot)) !== snapshotSha256) throw error;
    }
    fs.writeFileSync(temporary, pointer, {flag:'wx'});
    if (fs.existsSync(target)) fs.renameSync(temporary, target);
    else fs.linkSync(temporary, target);
    return {submitted:true, duplicate:false, decisionSha256:entry.decisionSha256};
  } finally { for (const name of [temporary,snapshotTemp]) try { fs.unlinkSync(name); } catch {} }
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}
function readSnapshot(run, id) {
  const target = file(run,id);
  if (!fs.existsSync(target)) return null;
  const pointer = JSON.parse(fs.readFileSync(target,'utf8'));
  need(pointer.version === 1 && pointer.eventId === id && /^[a-f0-9]{64}$/.test(pointer.snapshotSha256) &&
    pointer.snapshotName === 'decision-snapshot-' + id + '-' + pointer.snapshotSha256 + '.json', 'Invalid submission pointer');
  const bytes = fs.readFileSync(path.join(run,pointer.snapshotName));
  need(digest(bytes) === pointer.snapshotSha256, 'Submitted snapshot changed');
  return JSON.parse(bytes);
}
function load(run, binding, contract, event) {
  const entry = readSnapshot(run,event.id);
  if (!entry) return null;
  need(entry.version === 1 && entry.eventId === event.id && entry.eventSha256 === eventHash(event), 'Submitted event changed');
  need(entry.contractSha256 === binding.contractSha256 && entry.contractStateSha256 === (contract.contractStateSha256 || null), 'Submitted authorization or contract changed');
  need(typeof entry.decisionRaw === 'string' && digest(Buffer.from(entry.decisionRaw, 'utf8')) === entry.decisionSha256 &&
    JSON.stringify(JSON.parse(entry.decisionRaw)) === JSON.stringify(entry.decision) && entry.decision?.eventId === event.id, 'Invalid submitted decision');
  return entry;
}
module.exports = {file, draft, assertNoLegacyWatcher, submit, load};
