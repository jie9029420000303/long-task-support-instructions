#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { hash, read, need, validateContract, validateDecision, PROGRESS_REVIEW_MS } = require('./guard.cjs');
const { releaseAnnounced, stillCurrent } = require('./dispatch-audit.cjs');
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
      const found=fs.readFileSync(file,'utf8').includes(toolSessionId);
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
  need(typeof input.executorId === 'string' && /^[a-f0-9-]{36}$/.test(input.executorId), 'A visible desktop executor session is required');
  need(typeof input.executorDesktopId === 'string' && /^local_[a-f0-9-]{36}$/.test(input.executorDesktopId), 'Missing desktop executor ID');
  need(typeof input.supervisorDesktopId === 'string' && /^local_[a-f0-9-]{36}$/.test(input.supervisorDesktopId), 'Missing desktop supervisor ID');
  need(input.supervisorDesktopId!==input.executorDesktopId,'Supervisor and executor desktop chats must differ');
  need(typeof input.executorMarker === 'string' && /^LONG_TASK_BIND:[a-f0-9-]{36}$/.test(input.executorMarker), 'Missing unique executor marker');
  need(input.executorPrompt.includes(input.executorMarker), 'Executor prompt must contain its bind marker');
  need(Array.isArray(input.allowedRoots) && input.allowedRoots.includes(input.projectRoot) && input.allowedRoots.every(root => path.isAbsolute(root) && fs.existsSync(root)), 'Invalid allowed roots');
  validateContract(input.contract);
  const visible = visibleSupervisor(input.supervisorId,input.projectRoot);
  const supervisorLog = visible.log;
  need(fs.readFileSync(supervisorLog,'utf8').split('\n').some(line=>{
    try{const row=JSON.parse(line);return row.type==='user'&&row.entrypoint==='claude-desktop';}catch{return false;}
  }),'Supervisor is not a Claude Desktop conversation');
  const executorId = input.executorId;
  need(executorId !== visible.id && /^[a-f0-9-]{36}$/.test(executorId), 'Invalid executor session ID');
  const existingLog = transcript(executorId);
  const executorBytes=fs.readFileSync(existingLog);
  let markerOffset=-1,position=0;
  for(const line of executorBytes.toString('utf8').split('\n')){
    try {const row=JSON.parse(line);if(row.type==='user' && row.entrypoint==='claude-desktop' &&
      JSON.stringify(row.message?.content||'').includes(input.executorMarker)) markerOffset=position+Buffer.byteLength(line)+1;} catch {}
    position+=Buffer.byteLength(line)+1;
  }
  need(markerOffset>=0,'Executor prompt was not sent from Claude Desktop');
  fs.mkdirSync(path.dirname(run), {recursive:true});
  fs.mkdirSync(run);
  save(path.join(run, 'contract.json'), input.contract);
  fs.writeFileSync(path.join(run, 'executor-prompt.txt'),
    input.executorPrompt.replaceAll(input.supervisorId,visible.id).replaceAll('{{SUPERVISOR_ID}}',visible.id));
  save(path.join(run, 'binding.json'), {
    platform:'claude-code', projectRoot:input.projectRoot, allowedRoots:input.allowedRoots.concat(run),
    supervisorId:visible.id, supervisorDesktopId:input.supervisorDesktopId, toolSessionId:visible.toolSessionId,
    executorId, executorDesktopId:input.executorDesktopId,
    executorMarker:input.executorMarker, executorLog:existingLog, supervisorLog,
    contractSha256:hash(path.join(run,'contract.json')), promptSha256:hash(path.join(run,'executor-prompt.txt')),
    dispatchAudit:{enabled:input.dispatchAudit!==false,snapshot:'dispatch.json'},
    createdAt:now()
  });
  save(path.join(run, 'daemon-state.json'), {phase:'idle',executorOffset:markerOffset,turnText:[],seen:[],pending:null,reads:0,
    lastExecutorActivityAt:Date.now()});
  return {run,supervisorId:visible.id,toolSessionId:visible.toolSessionId,executorId,executorDesktopId:input.executorDesktopId,criteria:input.contract.criteria.length};
}
function status() {
  const {binding} = load();
  const state = read(path.join(run,'daemon-state.json'));
  const readyFile = path.join(run,'native-ready.json');
  const ready = fs.existsSync(readyFile) ? read(readyFile) : null;
  let alive = false;
  if (ready && ready.pid === state.pid) {try {process.kill(ready.pid,0);alive=true;} catch {}}
  return {run,supervisorId:binding.supervisorId,executorId:binding.executorId,
    phase:state.phase,active:alive && ready?.readVerified === true && state.phase==='watching',
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
  if (resolved) return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:true};
  if (event.kind==='progress_review') need(state.progressReviewPreflight===event.id,'Progress review requires current preflight before delivery');
  if (value.disposition==='needs_user') return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:false};
  if (value.disposition==='observe' && fs.existsSync(path.join(run,'STOP'))) {
    state.phase='stopped';save(path.join(run,'daemon-state.json'),state);
    return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:false,reason:'Run was stopped before observe could be processed'};
  }
  if (!['accept','observe'].includes(value.disposition)) {
    const marker='LONG_TASK_DELIVERY:'+event.id;
    need(input.delivery?.marker===marker && ['delivered','queued'].includes(input.delivery.status) &&
      typeof input.delivery.messageId==='string' && input.delivery.messageId, 'Missing desktop message receipt');
    need(fs.readFileSync(binding.executorLog,'utf8').includes(marker), 'Desktop delivery not recorded in executor transcript');
  }
  (state.resolved ||= {})[event.id]={event,decision:input,decisionSha256:hash(inputArgument)};
  state.seen.push(event.id);state.pending=null;
  if (event.kind==='progress_review') {state.progressReviewPreflight=null;state.lastProgressReviewAt=Date.now();}
  state.phase=value.disposition==='accept'?'accepted':'idle';
  if (state.phase==='accepted') state.acceptedAt=now();
  save(path.join(run,'daemon-state.json'),state);
  return {eventId:value.eventId,disposition:value.disposition,valid:true,processed:true};
}
function stop() {load();fs.writeFileSync(path.join(run,'STOP'),now()+'\n');return {run,stopRequested:true};}
function attachDispatch(){const {binding}=load();binding.dispatchAudit={enabled:true,snapshot:'dispatch.json',attachedAt:now()};save(path.join(run,'binding.json'),binding);fs.writeFileSync(path.join(run,'DISPATCH_AUDIT'),now()+'\n');return {run,dispatchAudit:true,snapshot:path.join(run,'dispatch.json')};}
function dispatchPreflight(){const {binding}=load(),state=read(path.join(run,'daemon-state.json'));need(state.pending?.id===inputArgument&&state.pending.kind==='dispatch_review','No matching pending dispatch review');const result=stillCurrent(run,binding,state,state.pending);if(!result.current){releaseAnnounced(state,state.pending);(state.resolved||={})[state.pending.id]={event:state.pending,obsolete:true};state.seen.push(state.pending.id);state.pending=null;state.phase='watching';}save(path.join(run,'daemon-state.json'),state);return {eventId:inputArgument,current:Boolean(result.current),snapshot:path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')};}
function progressPreflight(){const {binding}=load(),state=read(path.join(run,'daemon-state.json'));need(state.pending?.id===inputArgument&&state.pending.kind==='progress_review','No matching pending progress review');const current=!fs.existsSync(path.join(run,'STOP'))&&fs.statSync(binding.executorLog).size===state.executorOffset&&Date.now()-Math.max(state.lastExecutorActivityAt,state.lastProgressReviewAt||0)>=PROGRESS_REVIEW_MS;if(current)state.progressReviewPreflight=state.pending.id;else{(state.resolved||={})[state.pending.id]={event:state.pending,obsolete:true};state.seen.push(state.pending.id);state.pending=null;state.progressReviewPreflight=null;state.phase='watching';}save(path.join(run,'daemon-state.json'),state);return {eventId:inputArgument,current};}
(async()=>{
  try {
    const value=command==='init'?init():command==='status'?status()
      :command==='decision'?decision():command==='stop'?stop()
      :command==='attach-dispatch'?attachDispatch():command==='dispatch-preflight'?dispatchPreflight()
      :command==='progress-preflight'?progressPreflight()
      :(()=>{throw Error('Commands: init RUN INPUT, status RUN, decision RUN FILE, attach-dispatch RUN, dispatch-preflight RUN EVENT_ID, progress-preflight RUN EVENT_ID, stop RUN; start the desktop watcher in App background Bash');})();
    console.log(JSON.stringify(value));
  } catch(error) {console.error(error.message);process.exitCode=1;}
})();
