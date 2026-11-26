// Structural clues only. A tool call is not proof that a write succeeded or that a rule was broken.
const path=require('node:path');
const fs=require('node:fs');
const {inputSource}=require('./guard.cjs');

// The mainline splits, dispatches, judges deliveries and submits; Git merges and commits, deployments and the dispatch
// tools are its own. Editing code or configuration (a merge conflict included), running any test and sleeping to wait
// belong to subagents (Jay 2026-11-26 decisions 31 and 35, no allowance). The same rules as the Codex supervisor clock.
// What the shell runs is judged, command word first: quoted text, here-document bodies and another command's arguments
// are data (2026-11-26 工區 E: ps aux | grep -E 'buildx|vitest|playwright' was taken for a test run). A shell's -c
// string is a command line of its own and is read as one.
const TEST_COMMAND=/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:jest|vitest|playwright\s+test|mocha)\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|node\s+--test\b|(?:go|cargo|dotnet|swift|mix)\s+test\b|(?:jest|vitest|mocha|phpunit|rspec)\b|playwright\s+test\b|make\s+(?:test|check)\b|(?:mvn|gradle|\.\/gradlew)\b.*\btest\b|(?:python3?\s+)?\S*test-run\.py\b)/;
const EDIT_COMMAND=/^(?:sed\s+(?:-[a-zA-Z]*\s+)*-i|perl\s+-[a-zA-Z]*i|git\s+apply\b|git\s+checkout\s+--(?:ours|theirs)\b|git\s+mergetool\b)/;
function shellCommands(command){
  const text=String(command)
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g,'')
    .replace(/\b(?:ba|z)?sh\s+-[a-z]*c\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")/g,(match,single,double)=>';'+(single??double)+';')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g,"''");
  return text.split(/\$\(|[;&|()\x60{}\n]|\b(?:do|then|else)\b/)
    .map(part=>part.trim().replace(/^(?:\w+=\S*\s+|(?:env|time|nohup|exec|sudo|command)\s+|timeout\s+\S+\s+)*/,'')).filter(Boolean);
}
// A wait the mainline sets itself: a command that is a sleep (after any cd), or a loop that sleeps between polls. A
// deployment script's own waiting is not in the command line and is not counted.
function commandKind(command){
  const parts=shellCommands(command);
  if(parts.some(part=>TEST_COMMAND.test(part)))return 'test';
  const first=parts.find(part=>!/^cd\b/.test(part))||'';
  if(parts.some(part=>/^sleep\s+\d/.test(part))&&(/^sleep\b/.test(first)||parts.some(part=>/^(?:while|until)\b/.test(part))))return 'sleep';
  return parts.some(part=>EDIT_COMMAND.test(part))?'edit':null;
}
const EDIT_TOOLS=['Edit','Write','MultiEdit','NotebookEdit'];
// Not code or configuration: documents, status and work package files, evidence and the task's own state folders.
const NOT_CODE=/\.(?:md|markdown|txt|log|png|jpe?g|gif|webp|pdf|csv)$/i;
const OWN_FILES=/(?:^|\/)(?:wp|evidence|證據)[^/]*\/|\/\.(?:claude|codex)\/long-task\//i;
// A supervisor run folder (event, research and decision inputs live there) holds binding.json and contract.json.
function inRun(file){
  for(let dir=path.dirname(file),depth=0;depth<8&&dir!==path.dirname(dir);dir=path.dirname(dir),depth++)
    if(fs.existsSync(path.join(dir,'binding.json'))&&fs.existsSync(path.join(dir,'contract.json')))return true;
  return false;
}
function selfWorkOf(block){
  if(block?.type!=='tool_use')return null;
  const input=block.input||{};
  if(EDIT_TOOLS.includes(block.name)){
    const file=input.file_path||input.notebook_path||input.path;
    return typeof file==='string'&&!NOT_CODE.test(file)&&!OWN_FILES.test(file)&&!(path.isAbsolute(file)&&inRun(file))?{kind:'edit',item:file}:null;
  }
  if(block.name!=='Bash'||typeof input.command!=='string')return null;
  const kind=commandKind(input.command);
  return kind?{kind,item:input.command.replace(/\s+/g,' ').trim().slice(0,160)}:null;
}
function selfWorkPrompt(hits){
  const name={edit:'改程式或設定',test:'跑測試',sleep:'自己等待'};
  return 'LONG_TASK_SELF_WORK：本回合主線自己動手：\n'+hits.slice(0,6).map(hit=>'- '+name[hit.kind]+'：'+hit.item).join('\n')+'\n'+
    '主線只做 Git 合併與提交、部署、派工、收件判定、狀態與送驗。改程式或設定（含解 Git 衝突）、跑測試都派子代理；子代理交回靠原生完成通知，'+
    '等外部結果用 execution-watch.cjs 登記。這一則不叫醒監督；本回合再自己動手，背景程式會請監督處理。';
}
// A turn starts at a real input (Jay, the supervisor, a scheduled task or the execution watch). The first hand-done
// edit, test or sleep of a turn gets the note above from the executor's own hook; the watcher keeps the turn's hits so
// a second one wakes the supervisor (Jay 2026-11-26 decision 35). The state keeps the kind, call id and time only, never
// file paths, contents or commands; the supervisor reads the call itself in the executor transcript.
function observeSelfWork(state,row){
  if(!row||row.isSidechain)return;
  if(inputSource(row)){state.selfWork={turn:row.uuid||row.timestamp||'turn',hits:[]};return;}
  if(row.type!=='assistant'||!state.selfWork||!Array.isArray(row.message?.content))return;
  for(const block of row.message.content){
    const hit=selfWorkOf(block);
    if(hit&&state.selfWork.hits.length<20&&!state.selfWork.hits.some(item=>item.callId===block.id))
      state.selfWork.hits.push({kind:hit.kind,callId:block.id,at:row.timestamp||null});
  }
}

function correlate(snapshot,state,binding,runs){
  if(!snapshot?.packages)return [];
  const flight=snapshot.packages.inFlight||[],clues=[];
  // Work by hand again in the turn that already got the hook's note: one review per turn.
  const own=state.selfWork;
  if(own?.hits?.length>1)clues.push({kind:'self_work',affected:['turn:'+own.turn],detail:{turn:own.turn,hits:own.hits.slice(0,10)}});
  // A transcript without an end marker is only a possible active agent; missing transcripts do not prove absence.
  const handles=new Set(flight.map(item=>item.handle));
  for(const item of runs||[]){
    if(!item.id||!item.startedAt||item.startedAt<(Date.parse(binding.createdAt)||0))continue;
    const handle=item.workflow&&item.label?'workflow:'+item.workflow+':'+item.label:'agent:'+item.id;
    if(item.workflow&&!item.label)continue;
    if(!item.done&&!handles.has(handle))clues.push({kind:'agent_untracked',affected:[handle],detail:{handle,lastAt:item.lastAt||null,
      meaning:'A local agent transcript lacks an end marker and is not in the snapshot; verify its actual status.'}});
    if(item.done&&handles.has(handle))clues.push({kind:'agent_finished_inflight',affected:[handle],detail:{handle,lastAt:item.lastAt||null,
      meaning:'A local agent transcript has an end marker while the snapshot lists it in flight; verify and collect if applicable.'}});
  }
  return clues;
}
// Only new complete lines are read per file. A read error is unknown, not an empty set of agents.
const fileCache=new Map();
function incremental(file,kind){
  const stat=fs.statSync(file),old=fileCache.get(file);
  const same=old&&old.kind===kind&&old.dev===stat.dev&&old.ino===stat.ino&&stat.size>=old.offset&&
    (stat.size!==old.size||stat.mtimeMs===old.mtimeMs);
  const entry=same?{...old,value:kind==='journal'?new Map([...old.value].map(([id,item])=>[id,{...item}])):{...old.value}}:
    {kind,dev:stat.dev,ino:stat.ino,offset:0,value:kind==='journal'?new Map():{startedAt:null,lastAt:null,done:false}};
  const fd=fs.openSync(file,'r');let pos=entry.offset,carry=Buffer.alloc(0);
  try{while(pos<stat.size){
    const chunk=Buffer.alloc(Math.min(65536,stat.size-pos)),n=fs.readSync(fd,chunk,0,chunk.length,pos);
    if(!n)throw Object.assign(Error('short read'),{code:'READ_ERROR'});
    pos+=n;const buffer=Buffer.concat([carry,chunk.subarray(0,n)]);let start=0,end;
    while((end=buffer.indexOf(10,start))!==-1){
      let row;try{row=JSON.parse(buffer.subarray(start,end).toString('utf8'));}catch{throw Object.assign(Error('invalid source row'),{code:'INVALID_SOURCE'});}
      if(kind==='agent'){
        const at=Date.parse(row.timestamp);if(Number.isFinite(at)){entry.value.startedAt??=at;entry.value.lastAt=at;}
        if(row.type==='assistant'&&row.message&&!row.isApiErrorMessage)entry.value.done=row.message.stop_reason==='end_turn';
      }else if(row.agentId){const value=entry.value.get(row.agentId)||{};
        if(row.type==='started')value.label=row.label??null;else if(row.type==='result')value.result=true;else if(row.type==='failed')value.failed=true;
        entry.value.set(row.agentId,value);}
      start=end+1;
    }
    entry.offset=pos-(buffer.length-start);carry=buffer.subarray(start);
  }}finally{fs.closeSync(fd);}
  entry.size=stat.size;entry.mtimeMs=stat.mtimeMs;fileCache.set(file,entry);return entry.value;
}
function localRuns(binding){
  try{
    const root=path.join(path.dirname(binding.executorLog),binding.executorId,'subagents');
    const entries=dir=>fs.readdirSync(dir,{withFileTypes:true});
    const roots=entries(root),runs=[],present=new Set();
    const agents=(folder,items,workflow=null,journal=null)=>{
      for(const item of items)if(item.isFile()&&/^agent-.+\.jsonl$/.test(item.name)){
        const file=path.join(folder,item.name),id=item.name.slice(6,-6);present.add(file);
        const record={...incremental(file,'agent'),id};
        if(workflow){const meta=journal.get(id)||{};Object.assign(record,{workflow,label:meta.label??null,done:Boolean(meta.result||meta.failed),failed:Boolean(meta.failed)});}
        runs.push(record);
      }
    };
    agents(root,roots);
    const workflowDir=roots.find(item=>item.isDirectory()&&item.name==='workflows');
    if(workflowDir){const workflows=path.join(root,'workflows');
      for(const dir of entries(workflows).filter(item=>item.isDirectory())){
        const folder=path.join(workflows,dir.name),items=entries(folder),journalFile=path.join(folder,'journal.jsonl');
        const journal=incremental(journalFile,'journal');present.add(journalFile);agents(folder,items,dir.name,journal);
      }
    }
    for(const file of fileCache.keys())if(file.startsWith(root+path.sep)&&!present.has(file))fileCache.delete(file);
    return {available:true,runs};
  }catch(error){return {available:false,runs:[],error:['ENOENT','EACCES','EPERM','INVALID_SOURCE'].includes(error.code)?error.code:'READ_ERROR'};}
}
// The hook reads only the current turn, from the end of the transcript; a turn past 32 MB counts from where it stops.
function currentTurn(file){
  const rows=[],size=fs.statSync(file).size,fd=fs.openSync(file,'r');let end=size,carry=Buffer.alloc(0);
  try{
    while(end>0&&size-end<32*1024*1024){
      const start=Math.max(0,end-1024*1024),chunk=Buffer.alloc(end-start);fs.readSync(fd,chunk,0,chunk.length,start);end=start;
      // Lines are cut on bytes, so a chunk edge inside a multi-byte character never breaks a row.
      const buffer=Buffer.concat([chunk,carry]),lines=[];let at=buffer.length;
      for(let cut;at>0&&(cut=buffer.lastIndexOf(10,at-1))>=0;at=cut)lines.push(buffer.subarray(cut+1,at));
      if(end>0)carry=buffer.subarray(0,at);else lines.push(buffer.subarray(0,at));
      for(const line of lines){
        let row;try{row=JSON.parse(line.toString('utf8'));}catch{continue;}
        if(inputSource(row))return rows;
        rows.push(row);
      }
    }
  }finally{fs.closeSync(fd);}
  return rows;
}
// The bind marker is in the executor's first message, near the start of its transcript.
function bound(file){
  const fd=fs.openSync(file,'r');
  try{const head=Buffer.alloc(Math.min(fs.statSync(file).size,1024*1024));fs.readSync(fd,head,0,head.length,0);return head.toString('utf8').includes('LONG_TASK_BIND:');}
  finally{fs.closeSync(fd);}
}
// PreToolUse hook for the supervised executor's own Bash and edit calls; a subagent's call carries agent_id. It never
// blocks: the first hand-done work of a turn gets the note, a later one is left for the watcher to raise.
function hook(input){
  if(input?.hook_event_name!=='PreToolUse'||input.agent_id||!input.transcript_path)return null;
  const current=selfWorkOf({type:'tool_use',name:input.tool_name,input:input.tool_input,id:input.tool_use_id});
  if(!current||!bound(input.transcript_path))return null;
  const earlier=currentTurn(input.transcript_path).filter(row=>row.type==='assistant'&&!row.isSidechain&&Array.isArray(row.message?.content))
    .flatMap(row=>row.message.content.filter(block=>block?.id!==input.tool_use_id).map(selfWorkOf)).filter(Boolean);
  return earlier.length?null:{hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:selfWorkPrompt([current])}};
}

module.exports={selfWorkOf,selfWorkPrompt,observeSelfWork,correlate,localRuns,hook};
if(require.main===module&&process.argv[2]==='hook'){
  let text='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',part=>{text+=part;});
  process.stdin.on('end',()=>{try{const out=hook(JSON.parse(text));if(out)console.log(JSON.stringify(out));}catch{}});
}
