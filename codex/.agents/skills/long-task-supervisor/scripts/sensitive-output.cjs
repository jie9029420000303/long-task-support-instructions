#!/usr/bin/env node
'use strict';

// Capture a non-interactive command's output privately; do not print child output.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
if (args.length < 4 || args[0] !== '--log-dir' || args[2] !== '--') {
  process.stderr.write('Usage: sensitive-output.cjs --log-dir DIR -- COMMAND [ARG ...]\n');
  process.exit(2);
}
let dir, fd;
try {
  dir = fs.mkdtempSync(path.join(path.resolve(args[1]), 'sensitive-output-'));
  fs.chmodSync(dir, 0o700);
  fd = fs.openSync(path.join(dir, 'output.log'), 'wx', 0o600);
} catch {
  process.stderr.write('Unable to create a private output log.\n');
  process.exit(2);
}
let child;
try {
  child = spawn(args[3], args.slice(4), { stdio: ['ignore', fd, fd], shell: false, detached: true });
} catch {
  fs.closeSync(fd);
  process.stderr.write(`Unable to start command; private log: ${path.join(dir, 'output.log')}\n`);
  process.exit(2);
}
fs.closeSync(fd);
// Forward termination to the command's process group; wait for the child to close.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* child may have exited */ }
  });
}
let started = true;
child.on('error', () => { started = false; process.stderr.write(`Unable to start command; private log: ${path.join(dir, 'output.log')}\n`); });
child.on('close', (code, signal) => {
  if (!started) { process.exitCode = 2; return; }
  const success = code === 0 && !signal;
  process.stdout.write(`${success ? 'OK' : 'FAILED'}; private log: ${path.join(dir, 'output.log')}\n`);
  process.exitCode = success ? 0 : (Number.isInteger(code) && code > 0 ? code : 1);
});
