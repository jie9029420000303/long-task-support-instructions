// Structural clues only. A tool call is not proof that a write succeeded or that a rule was broken.
const path=require('node:path');
const fs=require('node:fs');
const CODE=/\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|go|rs|java|kt|swift|rb|php|cs|cpp|cc|c|h|sql)$/i;

// A snapshot describes when it was recorded, not the exact time a package started or stopped.
function readHistory(run){
  try{
    const rows=fs.readFileSync(path.join(run,'dispatch-history.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    if(rows.some(row=>!Number.isFinite(Date.parse(row?.at))||!Array.isArray(row.inFlight)||
      row.inFlight.some(item=>!item||typeof item.id!=='string'||typeof item.handle!=='string')))return null;
    return rows.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  }catch{return null;}
}
function observeMainWrite(state,row,history){
  if(row?.type!=='assistant'||row.isSidechain||!Array.isArray(row.message?.content))return;
  for(const block of row.message.content){
    if(block?.type!=='tool_use'||!['Edit','Write','MultiEdit'].includes(block.name))continue;
    const file=block.input?.file_path||block.input?.path,at=Date.parse(row.timestamp);
    if(typeof file!=='string'||!CODE.test(file)||!Number.isFinite(at)||!block.id)continue;
    const writes=(state.activityAudit||={}).mainWrites||=[];
    if(writes.some(item=>item.callId===block.id))continue;
    const previous=Array.isArray(history)?history.filter(item=>Date.parse(item.at)<=at).at(-1):null;
    // Never store file contents, command arguments, credentials, or paths in the monitoring state.
    writes.push({callId:block.id,rowId:row.uuid||null,at:row.timestamp,extension:path.extname(file).toLowerCase(),
      precedingSnapshotAt:previous?.at||null,precedingMainIds:previous?previous.inFlight.filter(item=>item.handle==='main').map(item=>item.id).sort():null});
  }
}
function correlate(snapshot,state,binding,runs){
  if(!snapshot?.packages)return [];
  const flight=snapshot.packages.inFlight||[],clues=[];
  const observations=(state.activityAudit?.mainWrites||[]).filter(item=>Date.parse(item.at)>=(Date.parse(binding.createdAt)||0));
  if(observations.length)clues.push({kind:'main_write_review',affected:[],detail:{observations,
    meaning:'Main-session code-file writes were attempted; preceding snapshots are historical clues, not proof of success, package attribution, or violation. Verify actual changes and authority.'}});
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
module.exports={readHistory,observeMainWrite,correlate,localRuns};
