// Hold the native watcher in an App-owned exec session; no model or scheduler.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { probe, runs } = require('./process-probe.cjs');
const directory = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const statusPath = path.join(directory, 'runtime-state.json');
const statePath = path.join(directory, 'daemon-state.json');
const lockPath = path.join(directory, 'watcher.lock');
const logPath = path.join(directory, 'native-watch.log');
const health = require('./watch-health.cjs');
// The parent writes a heartbeat and runs the outage check every minute (Jay 2026-10-29): after 10 minutes without a
// working watch Jay gets one push; the system guard reads the heartbeat to tell a gone parent from a live one.
const HEARTBEAT_MS = Number(process.env.LONG_TASK_HEARTBEAT_MS) || 60000;
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// A finished run stays down: STOP, acceptance, a stop, or a delivery that waits for manual receipt reconciliation.
function endedBy(state) {
  if (fs.existsSync(path.join(directory, 'STOP'))) return 'STOP';
  if (['accepted', 'stopped'].includes(state?.phase)) return state.phase;
  if (state?.phase === 'needs_reconcile' && (!state.inflight || String(state.error?.message || '').includes('requires manual receipt reconciliation'))) return 'needs_reconcile';
  return null;
}
// The supervisor runs this start at the beginning of every turn (v1.2.1, Jay 2026-11-09「修」), so it is safe to repeat:
// a finished run is left down and a live parent is left alone, however old its heartbeat, instead of fighting it for
// the watcher lock. A PID that now runs another program was reused; then the run starts. When ps cannot tell, a parent
// beating in the last three minutes counts as live; one from before v0.34.0 writes no heartbeat and its live PID is enough.
const ended = endedBy(readJson(statePath));
if (ended) { console.log(JSON.stringify({ended, run:directory})); process.exit(0); }
if (fs.existsSync(statusPath)) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
  catch { console.error('Cannot verify prior watcher status; reconcile before restart'); process.exit(1); }
  const alive = previous.pid === process.pid ? false : probe(previous.pid);
  const own = alive ? runs(previous.pid, 'run-watch.cjs') : false;
  const fresh = !previous.heartbeatAt || Date.now() - Date.parse(previous.heartbeatAt) < 3 * HEARTBEAT_MS;
  if (alive === null || ((own === true || (own === null && fresh)) && !['stopped', 'accepted'].includes(previous.phase))) {
    console.log(JSON.stringify(alive === null ? {processNotConfirmedStopped:previous.pid ?? null,run:directory} : {alreadyRunning:previous.pid,run:directory}));
    process.exit(0);
  }
}
const record = { pid: process.pid, startedAt: new Date().toISOString(), launches: [], decisionProtocol: 'explicit-decision-v1' };
let child, stopping = false, delay = 1000, beat = null;
function save() {
  fs.writeFileSync(statusPath + '.tmp', JSON.stringify(record, null, 2));
  fs.renameSync(statusPath + '.tmp', statusPath);
}
function heartbeat() {
  record.heartbeatAt = new Date().toISOString(); save();
  health.check(directory).catch(error => { record.healthError = error.message; save(); });
}
function end() { if (beat) { clearInterval(beat); beat = null; } }
function finished(launch, began, code, signal) {
  launch.endedAt = new Date().toISOString(); launch.code = code; launch.signal = signal;
  const state = readJson(statePath) || {};
  if (stopping || endedBy(state)) {
    record.phase = stopping ? 'stopped' : state.phase; record.endedAt = new Date().toISOString(); save(); end(); return;
  }
  if (Date.now() - began >= 30000) delay = 1000;
  record.phase = 'reconnecting'; record.retryInMs = delay; save();
  setTimeout(start, delay);
  delay = Math.min(delay * 2, 30000);
}
// The watcher a previous parent left: the App ended that parent's session, but the watcher runs in its own process
// group and kept watching. It cannot open a new App connection, so this parent takes it over and starts a fresh one
// only after it exits, instead of a second watcher that would only fail on the lock.
function leftover() {
  const pid = readJson(lockPath)?.pid;
  return Number.isInteger(pid) && pid !== process.pid && probe(pid) === true && runs(pid, 'native-watch.cjs') === true ? pid : null;
}
function adopt(pid) {
  const began = Date.now(), launch = { pid, adopted: true, startedAt: new Date().toISOString() };
  record.launches.push(launch); record.phase = 'running'; save();
  // Signal it only while it is the watcher: after it exits the PID may belong to another program.
  child = { kill: signal => { if (!launch.endedAt) try { process.kill(pid, signal); } catch {} } };
  const poll = setInterval(() => {
    // Gone: the PID is free, or it no longer holds the lock and no longer runs the watcher.
    if (probe(pid) !== false && (readJson(lockPath)?.pid === pid || runs(pid, 'native-watch.cjs') !== false)) return;
    clearInterval(poll); finished(launch, began, null, null);
  }, 2000);
}
function start() {
  if (stopping) return;
  const orphan = leftover();
  if (orphan) return adopt(orphan);
  const began = Date.now();
  // Its own process group and the run's log file: when the App ends this parent's session (2026-11-09 16:39, WEB: the
  // supervisor chat moved to a new log segment and the App killed its exec session, watcher included), the watcher
  // keeps its App connection and goes on until the supervisor's next turn remounts a parent. Tested 2026-11-09: a
  // process outside the App's tree keeps its connection but cannot open a new one. It runs from this directory: left
  // without a parent it belongs to launchd, and the executor's resource check counts such a process as an unregistered
  // task resource when its working directory is inside the task.
  const log = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(log, '[' + new Date().toISOString() + '] parent ' + process.pid + ' starts the watcher\n');
    child = spawn(process.execPath, [path.join(__dirname, 'native-watch.cjs'), directory], { cwd: __dirname, detached: true, stdio: ['ignore', log, log], env: process.env });
  } finally { fs.closeSync(log); }
  const launch = { pid: child.pid, startedAt: new Date().toISOString() };
  record.launches.push(launch); record.phase = 'running'; save();
  child.on('error', error => { launch.error = error.message; save(); });
  child.on('exit', (code, signal) => finished(launch, began, code, signal));
}
function stop() { stopping = true; end(); child?.kill('SIGTERM'); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try { require('./watch-guard.cjs').register(directory, { platform: 'codex', parentPid: process.pid }); } catch (error) { record.registerError = error.message; }
record.heartbeatAt = record.startedAt;
beat = setInterval(heartbeat, HEARTBEAT_MS);
start();
