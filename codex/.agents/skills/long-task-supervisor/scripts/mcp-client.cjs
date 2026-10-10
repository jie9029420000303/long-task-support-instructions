#!/usr/bin/env node
// Read-only: initialize and list tools through the installed App MCP bridge.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
function resolveServer() {
  if (process.env.CODEX_APP_TOOLS_SERVER_PATH) return process.env.CODEX_APP_TOOLS_SERVER_PATH;
  const root = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'plugins/cache/openai-bundled/codex-app-tools');
  const versions = fs.readdirSync(root).filter(v => fs.existsSync(path.join(root, v, 'server.mjs'))).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}));
  if (!versions.length) throw new Error('Codex App tools server not installed');
  return path.join(root, versions[0], 'server.mjs');
}
function createClient({ nodePath = process.execPath, serverPath = null } = {}) {
const resolvedServer = serverPath || resolveServer();
const child = spawn(nodePath, [resolvedServer], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
let stderr = '';
let terminalError = null;
child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2000); });
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const slot = pending.get(message.id);
  if (!slot) return;
  pending.delete(message.id);
  clearTimeout(slot.timer);
  slot.resolve(message);
});
function request(method, params, timeoutMs = 15000) {
  if (terminalError || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
    return Promise.reject(terminalError || new Error('MCP child is not running'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
}
function failPending(error) {
  terminalError = error;
  for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(error); }
  pending.clear();
}
child.once('error', failPending);
child.stdin.on('error', failPending);
child.once('exit', () => failPending(new Error('MCP child exited')));
async function close() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const cleanup = setTimeout(() => child.kill('SIGTERM'), 2000);
    child.once('exit', () => { clearTimeout(cleanup); resolve(); });
    child.stdin.end();
  });
}
return { request, notify, close, pid: child.pid };
}
// Follow MCP pagination and pass the calling context on discovery as well as calls.
async function listTools(client,meta={}) {
  const names=new Set(),seen=new Set();let cursor;
  do {
    const response=await client.request('tools/list',{...(cursor?{cursor}:{}),_meta:meta});
    if(response.error)throw Error(JSON.stringify(response.error));
    if(!Array.isArray(response.result?.tools))throw Error('Invalid Codex App tools/list response');
    for(const tool of response.result.tools)names.add(tool.name);
    cursor=response.result.nextCursor;
    if(cursor){if(seen.has(cursor))throw Error('Repeated Codex App tools cursor');seen.add(cursor);}
  }while(cursor);
  return names;
}
module.exports = { createClient, listTools };
