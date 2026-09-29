// Hold the native watcher in an App-owned exec session; no model or scheduler.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const statusPath = path.join(directory, 'runtime-state.json');
const statePath = path.join(directory, 'daemon-state.json');
const record = { pid: process.pid, startedAt: new Date().toISOString(), launches: [] };
let child, stopping = false, delay = 1000;
function save() {
  fs.writeFileSync(statusPath + '.tmp', JSON.stringify(record, null, 2));
  fs.renameSync(statusPath + '.tmp', statusPath);
}
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
    if (stopping || ['accepted', 'stopped', 'needs_reconcile'].includes(state.phase)) {
      record.phase = stopping ? 'stopped' : state.phase; record.endedAt = new Date().toISOString(); save(); return;
    }
    if (Date.now() - began >= 30000) delay = 1000;
    record.phase = 'reconnecting'; record.retryInMs = delay; save();
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30000);
  });
}
function stop() { stopping = true; child?.kill('SIGTERM'); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
start();
