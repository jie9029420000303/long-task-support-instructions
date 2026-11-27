// A research subagent's own transcript, written the way each platform writes it: a Codex subagent rollout under
// CODEX_HOME/sessions, or a Claude Code agent-<id>.jsonl beside the executor's log. rework.cjs research reads it to
// check that the subagent searched the web and that the sources it gives appear after that search (Jay 2026-11-28).
// Each step is {search:'query'} (Codex web_search_call / Claude WebSearch), {terra:'query'} (a web__run call inside a
// Codex exec command) or {text:'...'} (what the subagent read back: a tool output carrying the page or URL).
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function researchTranscript({t,root,scripts,agent='research_c1',steps,startAt=Date.now()+1000}){
  const at=index=>new Date(startAt+index*1000).toISOString();
  const bindingFile=path.join(root,'binding.json'),binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
  if(scripts.includes('claude-code')){
    if(!binding.executorLog){
      binding.executorLog=path.join(root,'executor.jsonl');fs.writeFileSync(binding.executorLog,'');
      fs.writeFileSync(bindingFile,JSON.stringify(binding));
    }
    const dir=path.join(path.dirname(binding.executorLog),binding.executorId,'subagents');
    fs.mkdirSync(dir,{recursive:true});
    const rows=steps.map((step,index)=>step.text===undefined
      ?{timestamp:at(index),type:'assistant',message:{id:'m'+index,model:'claude-sonnet-5-5',content:[{type:'tool_use',id:'t'+index,name:'WebSearch',input:{query:step.search||step.terra}}]}}
      :{timestamp:at(index),type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t'+index,content:step.text}]}});
    fs.writeFileSync(path.join(dir,'agent-'+agent+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    return agent;
  }
  const old=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
  t?.after(()=>{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;});
  const id=crypto.randomUUID(),start=new Date(startAt-1000),pad=n=>String(n).padStart(2,'0');
  const dir=path.join(root,'sessions',String(start.getFullYear()),pad(start.getMonth()+1),pad(start.getDate()));
  fs.mkdirSync(dir,{recursive:true});
  const meta={timestamp:start.toISOString(),type:'session_meta',payload:{id,thread_source:'subagent',parent_thread_id:binding.executorId,agent_path:'/root/'+agent}};
  const rows=steps.map((step,index)=>({timestamp:at(index),type:'response_item',payload:
    step.search!==undefined?{type:'web_search_call',status:'completed',action:{type:'search',query:step.search}}
    :step.terra!==undefined?{type:'custom_tool_call',name:'exec',call_id:'c'+index,input:'const r=await tools.web__run({search_query:[{q:'+JSON.stringify(step.terra)+'}]});'}
    :{type:'function_call_output',call_id:'c'+index,output:step.text}}));
  const stamp=[start.getFullYear(),pad(start.getMonth()+1),pad(start.getDate())].join('-')+'T'+[pad(start.getHours()),pad(start.getMinutes()),pad(start.getSeconds())].join('-');
  fs.writeFileSync(path.join(dir,'rollout-'+stamp+'-'+id+'.jsonl'),[meta,...rows].map(row=>JSON.stringify(row)).join('\n')+'\n');
  return '/root/'+agent;
}
module.exports={researchTranscript};
