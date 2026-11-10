// The latest turns of a Codex thread read from its own rollout on this Mac, newest first, in the shape read_thread
// returns: id, status, startedAt, completedAt and the visible messages. native-watch reads here only when the App
// cannot return a single oversized turn (2026-11-09 OPS: one executor turn ran from 21:44 to 04:03, and read_thread
// answered "A single oversized turn cannot be returned by this tool" even for 1 turn at 500 characters per item; the
// watcher restarted 11 times, and after the turn ended the read still failed until a new turn began). Each turn keeps
// its last user message, its last agent message and its final answer, the parts the watcher reads.
const fs=require('node:fs');
const CHUNK=8*1024*1024,MAX_SCAN=64*1024*1024;
const textOf=payload=>(payload.content||[]).filter(block=>block&&typeof block.text==='string').map(block=>block.text).join('\n');
function parse(file,size,length,maxChars){
  const buffer=Buffer.alloc(length),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,buffer,0,length,size-length);}finally{fs.closeSync(fd);}
  let body=buffer.toString('utf8');
  if(length<size)body=body.slice(body.indexOf('\n')+1);
  const turns=new Map();let current=null,seq=0;
  const turn=id=>{if(!turns.has(id))turns.set(id,{id,status:'inProgress',startedAt:null,completedAt:null,started:false});return turns.get(id);};
  for(const line of body.split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    const payload=row?.payload||{};
    if(row.type==='turn_context'&&payload.turn_id){current=payload.turn_id;turn(current);}
    else if(row.type==='event_msg'&&payload.type==='task_started'&&payload.turn_id){current=payload.turn_id;Object.assign(turn(current),{started:true,startedAt:payload.started_at??null});}
    else if(row.type==='event_msg'&&payload.type==='task_complete'&&payload.turn_id){
      Object.assign(turn(payload.turn_id),{status:payload.error?'failed':'completed',completedAt:payload.completed_at??null,
        ...(typeof payload.last_agent_message==='string'?{lastAgentMessage:payload.last_agent_message}:{})});
    }else if(row.type==='event_msg'&&payload.type==='turn_aborted'){const id=payload.turn_id||current;if(id)turn(id).status='interrupted';}
    else if(row.type==='response_item'&&payload.type==='message'&&['user','assistant'].includes(payload.role)){
      const id=payload.internal_chat_message_metadata_passthrough?.turn_id||current;if(!id)continue;
      const owner=turn(id),item={type:payload.role==='user'?'userMessage':'agentMessage',id:payload.id||null,...(payload.phase?{phase:payload.phase}:{}),
        text:textOf(payload).slice(0,maxChars),seq:seq++};
      if(item.type==='userMessage')owner.user=item;else{owner.agent=item;if(item.phase==='final_answer')owner.final=item;}
    }
  }
  return [...turns.values()].reverse();
}
function shape(turn,maxChars){
  const items=[...new Set([turn.user,turn.final,turn.agent].filter(Boolean))].sort((a,b)=>a.seq-b.seq).map(({seq,...item})=>item);
  // A completed turn whose final message lies before the part read still has its text in task_complete.
  if(turn.status==='completed'&&!turn.final&&typeof turn.lastAgentMessage==='string')
    items.push({type:'agentMessage',id:null,phase:'final_answer',text:turn.lastAgentMessage.slice(0,maxChars)});
  return {id:turn.id,status:turn.status,startedAt:turn.startedAt,completedAt:turn.completedAt,items};
}
// The tail is read in growing pieces, at most 64 MB: enough once the turns asked for are in view and every one but the
// newest began inside it. The newest may have begun long before; its later records still name it.
function recent(file,{turnLimit=1,maxOutputCharsPerItem=20000}={}){
  const size=fs.statSync(file).size,limit=Math.max(1,Math.floor(Number(turnLimit))||1),maxChars=Math.max(1,Math.floor(Number(maxOutputCharsPerItem))||20000);
  for(let length=Math.min(size,CHUNK);;length=Math.min(size,length*2)){
    const turns=parse(file,size,length,maxChars),wanted=turns.slice(0,limit);
    if(length>=size||length>=MAX_SCAN||turns.length>limit||wanted.length===limit&&wanted.slice(1).every(item=>item.started))
      return wanted.map(item=>shape(item,maxChars));
  }
}
module.exports={recent};
