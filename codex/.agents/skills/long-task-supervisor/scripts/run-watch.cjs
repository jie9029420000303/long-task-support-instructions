// Hold the native watcher in an App-owned exec session; no model or scheduler.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const statusPath = path.join(directory, 'runtime-state.json');
const statePath = path.join(directory, 'daemon-state.json');
const health = require('./watch-health.cjs');
// The parent writes a heartbeat and runs the outage check every minute (Jay 2026-10-29): after 10 minutes without a
// working watch Jay gets one push; the system guard reads the heartbeat to tell a gone parent from a live one.
const HEARTBEAT_MS = Number(process.env.LONG_TASK_HEARTBEAT_MS) || 60000;
// One parent per run: a second start while the first is alive and beating leaves it alone instead of fighting it for
// the watcher lock every 30 seconds. A parent from before v0.34.0 writes no heartbeat; its live PID is enough.
try {
  const previous = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  let alive = false;
  try { process.kill(previous.pid, 0); alive = previous.pid !== process.pid; } catch {}
  const fresh = !previous.heartbeatAt || Date.now() - Date.parse(previous.heartbeatAt) < 3 * HEARTBEAT_MS;
  if (alive && fresh && !['stopped', 'accepted'].includes(previous.phase)) {
    console.log(JSON.stringify({ alreadyRunning: previous.pid, run: directory }));
    process.exit(0);
  }
} catch {}
const record = { pid: process.pid, startedAt: new Date().toISOString(), launches: [] };
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
function start() {
  if (stopping) return;
  const began = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'native-watch.cjs'), directory], { stdio: 'inherit', env: process.env });
  const launch = { pid: child.pid, startedAt: new Date().toISOString() };
  record.launches.push(launch); record.phase = 'running'; save();
  child.on('error', error => { launch.error = error.message; save(); });
  child.on('exit', (code, signal) => {
    launch.endedAt = new Date().toISOString(); launch.code = code; launch.signal = signal;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (stopping || fs.existsSync(path.join(directory,'STOP')) || ['accepted', 'stopped'].includes(state.phase) || (state.phase==='needs_reconcile'&&!state.inflight)) {
      record.phase = stopping ? 'stopped' : state.phase; record.endedAt = new Date().toISOString(); save(); end(); return;
    }
    if (Date.now() - began >= 30000) delay = 1000;
    record.phase = 'reconnecting'; record.retryInMs = delay; save();
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30000);
  });
}
function stop() { stopping = true; end(); child?.kill('SIGTERM'); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try { require('./watch-guard.cjs').register(directory, { platform: 'codex', parentPid: process.pid }); } catch (error) { record.registerError = error.message; }
record.heartbeatAt = record.startedAt;
beat = setInterval(heartbeat, HEARTBEAT_MS);
start();
