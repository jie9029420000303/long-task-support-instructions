#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { hash, read, need, validateContract, validateDecision } = require('./guard.cjs');
const [command, runArgument, inputArgument] = process.argv.slice(2);
const run = runArgument && path.resolve(runArgument);
const now = () => new Date().toISOString();
function save(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}
function transcript(id) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects');
  const found = [];
  for (const project of fs.readdirSync(root, {withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    const file = path.join(root, project.name, id + '.jsonl');
    if (fs.existsSync(file)) found.push(file);
  }
  need(found.length === 1, 'Cannot identify one exact Claude Code session transcript for ' + id);
  return found[0];
}
function sessionCwd(file, fallback) {
  const fd=fs.openSync(file,'r'), buffer=Buffer.alloc(65536);
  try {
    const count=fs.readSync(fd,buffer,0,buffer.length,0);
    for (const line of buffer.subarray(0,count).toString('utf8').split('\n')) {
      try {const row=JSON.parse(line);if (row.cwd && fs.existsSync(row.cwd)) return row.cwd;} catch {}
    }
  } finally {fs.closeSync(fd);}
  return fallback;
}
function visibleSupervisor(toolSessionId, projectRoot) {
  const toolLog=transcript(toolSessionId);
  const projects=path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME,'.claude'),'projects');
  const born=fs.statSync(toolLog).birthtimeMs;
  const matches=[];
  for (const project of fs.readdirSync(projects,{withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(projects,project.name),{withFileTypes:true})) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.jsonl$/.test(entry.name)) continue;
      const file=path.join(projects,project.name,entry.name);
      if (file===toolLog || fs.statSync(file).mtimeMs<born) continue;
      let found=false;
      try {execFileSync('rg',['--quiet','--fixed-strings',toolSessionId,file],{timeout:10000});found=true;} catch {}
      if (found) {
        const cwd=sessionCwd(file,projectRoot);
        const relative=path.relative(cwd,projectRoot);
        if (relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))) matches.push(file);
      }
    }
  }
  need(matches.length<=1,'Multiple visible Claude sessions refer to the tool session; choose the exact conversation');
  const log=matches[0] || toolLog;
  return {id:path.basename(log,'.jsonl'),log,toolSessionId};
}
function load() {
  need(run && fs.existsSync(path.join(run, 'binding.json')), 'Run not initialized');
  const binding = read(path.join(run, 'binding.json'));
  const contractFile = path.join(run, 'contract.json');
  need(hash(contractFile) === binding.contractSha256, 'Locked contract changed');
  return {binding, contract:validateContract(read(contractFile))};
}
function init() {
  need(run && inputArgument && path.isAbsolute(runArgument) && path.isAbsolute(inputArgument), 'Use absolute run and input paths');
  need(!fs.existsSync(run), 'Run already exists; resume it');
  const input = read(inputArgument);
  need(path.isAbsolute(input.projectRoot) && fs.existsSync(input.projectRoot), 'Missing project root');
  need(typeof input.supervisorId === 'string' && /^[a-f0-9-]{36}$/.test(input.supervisorId), 'Missing supervisor session ID');
  if (process.env.CLAUDE_SESSION_ID) need(process.env.CLAUDE_SESSION_ID === input.supervisorId, 'Must initialize in the supervisor session');
  need(typeof input.executorPrompt === 'string' && input.executorPrompt.trim(), 'Missing executor prompt');
  need(!input.permissionMode || ['auto','default','acceptEdits'].includes(input.permissionMode), 'Unsupported permission mode');
  need(Array.isArray(input.allowedRoots) && input.allowedRoots.includes(input.projectRoot) && input.allowedRoots.every(root => path.isAbsolute(root) && fs.existsSync(root)), 'Invalid allowed roots');
  validateContract(input.contract);
  const visible = visibleSupervisor(input.supervisorId,input.projectRoot);
  const supervisorLog = visible.log;
  const executorId = input.executorId || crypto.randomUUID();
  need(executorId !== visible.id && /^[a-f0-9-]{36}$/.test(executorId), 'Invalid executor session ID');
  const existingLog = input.executorId ? transcript(executorId) : null;
  fs.mkdirSync(path.dirname(run), {recursive:true});
  fs.mkdirSync(run);
  save(path.join(run, 'contract.json'), input.contract);
  fs.writeFileSync(path.join(run, 'executor-prompt.txt'),
    input.executorPrompt.replaceAll(input.supervisorId,visible.id).replaceAll('{{SUPERVISOR_ID}}',visible.id));
  save(path.join(run, 'binding.json'), {
    platform:'claude-code', projectRoot:input.projectRoot, allowedRoots:input.allowedRoots.concat(run),
    supervisorId:visible.id, toolSessionId:visible.toolSessionId, executorId, supervisorLog, supervisorCwd:sessionCwd(supervisorLog,input.projectRoot), supervisorStartOffset:fs.statSync(supervisorLog).size,
    permissionMode:input.permissionMode || 'auto',
    contractSha256:hash(path.join(run,'contract.json')), promptSha256:hash(path.join(run,'executor-prompt.txt')),
    createdAt:now()
  });
  save(path.join(run, 'daemon-state.json'), {phase:'waiting_for_supervisor_turn',executorStarted:Boolean(existingLog),executorOffset:existingLog?fs.statSync(existingLog).size:0,seen:[],messages:[],pending:null,reads:0});
  return {run,supervisorId:visible.id,toolSessionId:visible.toolSessionId,executorId,criteria:input.contract.criteria.length};
}
function status() {
  const {binding} = load();
  const state = read(path.join(run,'daemon-state.json'));
  const readyFile = path.join(run,'native-ready.json');
  const ready = fs.existsSync(readyFile) ? read(readyFile) : null;
  let alive = false;
  if (ready && ready.pid === state.pid) {try {process.kill(ready.pid,0);alive=true;} catch {}}
  return {run,supervisorId:binding.supervisorId,executorId:binding.executorId,
    phase:state.phase,active:alive && ready?.readVerified === true && state.executorStarted === true,
    readVerified:ready?.readVerified === true,reads:state.reads,acceptedAt:state.acceptedAt || null,error:state.error || null};
}
function decision() {
  need(inputArgument && path.isAbsolute(inputArgument), 'Use absolute decision path');
  const {binding,contract} = load();
  const state = read(path.join(run,'daemon-state.json'));
  const input=read(inputArgument),resolved=state.resolved?.[input.eventId];
  const event=state.pending?.id===input.eventId?state.pending:resolved?.event;
  need(event,'No matching pending or processed event');
  if (resolved) need(hash(inputArgument)===resolved.decisionSha256,'Processed decision changed');
  const value=validateDecision(binding,contract,event,input);
  return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:Boolean(resolved)};
}
function stop() {load();fs.writeFileSync(path.join(run,'STOP'),now()+'\n');return {run,stopRequested:true};}
async function start() {
  load();
  need(!fs.existsSync(path.join(run,'STOP')),'Run was stopped');
  const lock=path.join(run,'watcher.lock');
  if (fs.existsSync(lock)) {
    const old=read(lock);
    try {process.kill(old.pid,0);throw Error('A watcher is already running');} catch(error) {if (error.code!=='ESRCH') throw error;}
  }
  const log=fs.openSync(path.join(run,'watcher.log'),'a');
  const child=spawn(process.execPath,[path.join(__dirname,'run-watch.cjs'),run],
    {detached:true,stdio:['ignore',log,log],env:process.env});
  fs.closeSync(log);child.unref();
  for (let attempt=0;attempt<50;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,200));
    if (fs.existsSync(lock)) {
      const owner=read(lock);
      try {process.kill(owner.pid,0);return {run,armed:true,watcherPid:owner.pid,phase:read(path.join(run,'daemon-state.json')).phase};} catch {}
    }
  }
  throw Error('Watcher did not arm; inspect '+path.join(run,'watcher.log'));
}
(async()=>{
  try {
    const value=command==='init'?init():command==='start'?await start():command==='status'?status()
      :command==='decision'?decision():command==='stop'?stop()
      :(()=>{throw Error('Commands: init RUN INPUT, start RUN, status RUN, decision RUN FILE, stop RUN');})();
    console.log(JSON.stringify(value));
  } catch(error) {console.error(error.message);process.exitCode=1;}
})();
