// A real shell call can identify the start of a full test, but cannot prove that parallel work exists.
// Keep only a hash and a transcript locator; never copy the shell command or its output to the review.
const fs=require('node:fs'),path=require('node:path');
const {commandKey}=require('./clock-safety.cjs');

function recognized(command){
  if(typeof command!=='string')return false;
  const lines=command.split(/\r?\n/),first=lines.findIndex(line=>line.trim());
  if(first>=0 && /^\s*#\s*LONG_TASK_LONG_TEST\s*$/.test(lines[first]))
    return lines.slice(first+1).some(line=>line.trim()&&!/^\s*#/.test(line));
  // Split simple shell commands only outside quotes. Complex syntax is left unknown, never guessed from an argument.
  const segments=[];let words=[],word='',quote=null,escaped=false,comment=false;
  const addWord=()=>{if(word){words.push(word);word='';}};
  const addSegment=()=>{addWord();if(words.length)segments.push(words);words=[];};
  for(const char of command){
    if(comment){if(char==='\n'){comment=false;addSegment();}continue;}
    if(escaped){word+=char;escaped=false;continue;}
    if(char==='\\'&&quote!=="'"){escaped=true;continue;}
    if(quote){if(char===quote)quote=null;else word+=char;continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='#'&&!word){comment=true;continue;}
    if(char==='`'||char==='$'||char==='('||char===')'||char==='<')return false;
    if(char===';'||char==='&'||char==='|'||char==='\n'){addSegment();continue;}
    if(/\s/.test(char)){addWord();continue;}
    word+=char;
  }
  if(quote||escaped)return false;addSegment();
  // Recognize a script actually invoked as a gate, not a file merely mentioned by cat, grep or an argument.
  for(const words of segments){
    while(words.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))words.shift();
    if(['sh','bash','zsh'].includes(path.basename(words[0]||'')))words.shift();
    const program=path.basename((words[0]||'').replace(/^['"]|['"]$/g,''));
    if(/^(?:[A-Za-z0-9_.-]+[-_])?gate\.(?:sh|bash|zsh)$/i.test(program))return true;
  }
  return false;
}
function observe(state,block,{file,offset,at}){
  if(block?.type!=='tool_use'||block.name!=='Bash'||typeof block.id!=='string'||!recognized(block.input?.command))return;
  const candidates=state.parallelTestCandidates||=[];
  if(candidates.some(item=>item.source.callId===block.id)||(state.parallelTestAnnounced||[]).includes(block.id))return;
  candidates.push({source:{path:file,offset,callId:block.id},startedAt:at,commandHash:commandKey(block.input.command),status:'unknown'});
}
function result(state,block,row){
  if(block?.type!=='tool_result'||!Array.isArray(state.parallelTestCandidates))return;
  const platform=row?.toolUseResult;
  state.parallelTestCandidates=state.parallelTestCandidates.filter(item=>{
    if(item.source.callId===block.tool_use_id){
      if(block.is_error||platform?.interrupted)return false;
      // Only a structured platform task ID ties the started process to this exact Bash call. A bare tool_use or
      // same-named OS process is not proof; no ID means an already completed call or an unverified start.
      if(typeof platform?.backgroundTaskId==='string'&&/^[A-Za-z0-9_-]+$/.test(platform.backgroundTaskId)){
        item.taskId=platform.backgroundTaskId;item.confirmedAt=row.timestamp||null;item.status='started';return true;
      }
      return false;
    }
    const task=platform?.task;
    if(item.taskId&&task?.task_id===item.taskId&&task?.task_type==='local_bash'&&['completed','failed','stopped'].includes(task.status))return false;
    return true;
  });
}
function fullAfterStart(observations,snapshot,item,agentSource,watchStartedAt){
  const capacity=snapshot?.capacity?.verified,flight=snapshot?.packages?.inFlight;
  if(!Number.isInteger(capacity)||capacity<=0||!Array.isArray(flight)||agentSource?.available!==true||!Array.isArray(agentSource.runs))return false;
  const started=Date.parse(item.confirmedAt),seen=observations||{};
  if(!Number.isFinite(started)||!Number.isFinite(watchStartedAt))return false;
  const handles=new Set();
  for(const work of flight){
    const id=/^agent:([A-Za-z0-9_-]+)$/.exec(work?.handle||'')?.[1],record=id&&seen[id];
    const source=agentSource.runs.find(run=>run.id===id&&!run.workflow);
    if(record?.status==='running'&&source&&!source.done&&Date.parse(record.at)>=Math.max(started,watchStartedAt))handles.add(id);
  }
  return handles.size>=capacity;
}
function observeAgentStatus(state,row,observations){
  const blocks=Array.isArray(row?.message?.content)?row.message.content:[];
  if(row?.type==='assistant')for(const block of blocks){
    if(block?.type==='tool_use'&&block.name==='TaskOutput'&&typeof block.id==='string'&&/^[A-Za-z0-9_-]+$/.test(block.input?.task_id||''))
      (state.parallelAgentPolls||={})[block.id]=block.input.task_id;
  }
  if(row?.type!=='user'||!Number.isFinite(Date.parse(row.timestamp))||!observations)return;
  for(const block of blocks){
    if(block?.type!=='tool_result')continue;
    const expected=state.parallelAgentPolls?.[block.tool_use_id],task=row.toolUseResult?.task;
    if(state.parallelAgentPolls)delete state.parallelAgentPolls[block.tool_use_id];
    if(block.is_error||!expected||task?.task_type!=='local_agent'||task.task_id!==expected||!['running','completed','failed','stopped'].includes(task.status))continue;
    const previous=observations[expected];
    if(!previous||Date.parse(row.timestamp)>=Date.parse(previous.at))observations[expected]={status:task.status,at:row.timestamp};
  }
}
function notification(state,row,observations){
  if(row?.type!=='user'||row.turnOrigin!=='task_notification'||typeof row.message?.content!=='string')return;
  const text=row.message.content,id=/<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(text)?.[1],
    status=/<status>(completed|failed|stopped)<\/status>/.exec(text)?.[1];
  if(!id||!status)return;
  if(Array.isArray(state.parallelTestCandidates))state.parallelTestCandidates=state.parallelTestCandidates.filter(item=>item.taskId!==id);
  if(observations?.[id]&&Number.isFinite(Date.parse(row.timestamp))&&Date.parse(row.timestamp)>=Date.parse(observations[id].at))observations[id]={status,at:row.timestamp};
}
// Re-read only the exact executor source from this call onward. Do not change the executor cursor, event or decisions.
// A missing/truncated/unparseable source stays unknown; output and commands never leave this function.
function recheck(binding,state,snapshot,event,agentSource){
  if(!(event?.reasons||[]).includes('parallel_test_review'))return null;
  const tests=event.parallelTestReview?.tests;
  if(!Array.isArray(tests)||!tests.length)return {status:'unknown',tests:[]};
  const checked=tests.map(item=>{
    const source=item.source;
    if(source?.path!==binding.executorLog||!Number.isInteger(source.offset)||source.offset<0||typeof source.callId!=='string')
      return {callId:source?.callId||null,status:'unknown'};
    let fd,taskId=null,ended=false,bad=false,sawCall=false,pos=source.offset,carry=Buffer.alloc(0);
    try{
      const end=fs.statSync(source.path).size;if(pos>=end)return {callId:source.callId,status:'unknown'};
      fd=fs.openSync(source.path,'r');
      const inspect=row=>{
        if(row?.type==='user'&&row.turnOrigin==='task_notification'&&typeof row.message?.content==='string'){
          const id=/<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(row.message.content)?.[1],status=/<status>(completed|failed|stopped)<\/status>/.exec(row.message.content)?.[1];
          if(id&&status&&id===taskId)ended=true;
        }
        const blocks=Array.isArray(row?.message?.content)?row.message.content:[];
        if(row?.type==='assistant')for(const block of blocks)if(block?.type==='tool_use'&&block.id===source.callId&&block.name==='Bash'&&recognized(block.input?.command)&&commandKey(block.input.command)===item.commandHash)sawCall=true;
        for(const block of blocks)if(row.type==='user'&&block?.type==='tool_result'){
          const platform=row.toolUseResult;
          if(block.tool_use_id===source.callId){
            if(block.is_error||platform?.interrupted)ended=true;
            else if(typeof platform?.backgroundTaskId==='string'&&/^[A-Za-z0-9_-]+$/.test(platform.backgroundTaskId))taskId=platform.backgroundTaskId;
            else ended=true;
          }
          if(taskId&&platform?.task?.task_id===taskId&&platform.task.task_type==='local_bash'&&['completed','failed','stopped'].includes(platform.task.status))ended=true;
        }
      };
      while(pos<end){
        const chunk=Buffer.alloc(Math.min(65536,end-pos)),n=fs.readSync(fd,chunk,0,chunk.length,pos);if(!n){bad=true;break;}pos+=n;
        const bytes=Buffer.concat([carry,chunk.subarray(0,n)]);let start=0,newline;
        while((newline=bytes.indexOf(10,start))!==-1){try{inspect(JSON.parse(bytes.subarray(start,newline).toString('utf8')));}catch{bad=true;}start=newline+1;}
        carry=bytes.subarray(start);
      }
      if(carry.length)bad=true;
    }catch{bad=true;}finally{if(fd!==undefined)fs.closeSync(fd);}
    if(!sawCall)return {callId:source.callId,status:'unknown'};
    if(ended)return {callId:source.callId,status:'ended'};
    if(bad||!taskId)return {callId:source.callId,status:'unknown'};
    return {callId:source.callId,status:'unknown'};
  });
  return {status:checked.every(item=>item.status==='ended')?'cleared':'unknown',tests:checked};
}
function take(state,snapshot,agentSource,observations,watchStartedAt){
  const tests=state.parallelTestCandidates||[];
  if(!tests.length)return null;
  const full=tests.filter(item=>item.status==='started'&&fullAfterStart(observations,snapshot,item,agentSource,watchStartedAt));
  // Keep a full-at-this-instant lead for the next check. A later scan without current status is unknown, not full.
  const actionable=tests.filter(item=>item.status==='started'&&!full.includes(item));
  if(!actionable.length)return null;
  const announced=state.parallelTestAnnounced||=[];
  for(const item of actionable)if(!announced.includes(item.source.callId))announced.push(item.source.callId);
  state.parallelTestCandidates=(state.parallelTestCandidates||[]).filter(item=>!actionable.includes(item));
  return {tests:actionable.map(({taskId,...item})=>({...item,status:'unknown'}))};
}
module.exports={recognized,observe,result,observeAgentStatus,notification,fullAfterStart,take,recheck};
