const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

function titleOf(file){
  let title;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.includes('custom-title'))continue;
    try{const row=JSON.parse(line);if(row.type==='custom-title'&&row.customTitle)title=row.customTitle;}catch{}
  }
  return title;
}
function delivered(file,marker){
  if(!fs.existsSync(file))return false;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.includes(marker))continue;
    try{
      const row=JSON.parse(line);
      const value=typeof row.content==='string'?row.content:'';
      if(row.type==='queue-operation'&&value.startsWith('<cross-session-message')&&value.includes('\n'+marker+'\n'))return true;
    }catch{}
  }
  return false;
}
function call(run,tools,prompt){
  const dir=path.join(run,'relay');fs.mkdirSync(dir,{recursive:true});
  const env={...process.env};delete env.CLAUDECODE;
  const result=spawnSync(process.env.CLAUDE_CLI_PATH||'claude',
    ['-p','--model','haiku','--safe-mode','--strict-mcp-config','--no-session-persistence',
      '--tools',tools,'--permission-mode','auto','--output-format','json',prompt],
    {cwd:dir,env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error('Desktop wake relay failed: '+(result.error?.message||result.stderr||result.stdout).slice(0,300));
  let output;try{output=JSON.parse(result.stdout);}catch{throw Error('Desktop wake relay returned invalid JSON');}
  if(output.is_error)throw Error('Desktop wake relay error: '+String(output.result).slice(0,300));
  return String(output.result||'');
}
async function wake(run,binding,state,event,checkpoint){
  const marker='LONG_TASK_WAKE:'+event.id;
  if(delivered(binding.supervisorLog,marker)){
    state.wake={eventId:event.id,marker,confirmedAt:new Date().toISOString()};checkpoint();return;
  }
  if(state.wake?.eventId===event.id&&state.wake.attemptedAt)throw Error('Desktop wake delivery uncertain; reconcile '+marker+' before retry');
  const title=titleOf(binding.supervisorLog);
  if(!title)throw Error('Supervisor desktop title is missing');
  const list=call(run,'ListAgents','Call ListAgents once and reply with its complete output verbatim, nothing else.');
  const peers=[...list.matchAll(/^\s+(.+?) \[([0-9a-f]+)\]\s+·/gm)].filter(match=>match[1].trim()===title);
  if(peers.length!==1)throw Error('Expected one supervisor desktop peer titled '+title+'; found '+peers.length);
  const to=title+' ['+peers[0][2]+']';
  const message=marker+'\n長任務執行對話有待處理事件。請讀 '+path.join(run,'daemon-state.json')+' 的 pending，依鎖定契約處理事件 '+event.id+'，完成判定後重新掛上監看。同一事件只處理一次。';
  state.wake={eventId:event.id,marker,attemptedAt:new Date().toISOString()};checkpoint();
  const response=call(run,'SendMessage',[
    'Call SendMessage exactly once. Set to and message to the exact text between the delimiters. Reply with the tool result only.',
    '<<<TO',to,'TO>>>','<<<MESSAGE',message,'MESSAGE>>>'
  ].join('\n'));
  const addressed=response.match(/→ (.+?) \(/);
  if(addressed&&addressed[1].trim()!==title)throw Error('Desktop wake relay addressed the wrong session');
  state.wake.sentAt=new Date().toISOString();checkpoint();
  const deadline=Date.now()+Number(process.env.CLAUDE_WAKE_CONFIRM_MS||300000);
  while(Date.now()<deadline&&!delivered(binding.supervisorLog,marker))await new Promise(resolve=>setTimeout(resolve,1000));
  if(!delivered(binding.supervisorLog,marker))throw Error('Desktop wake delivery not confirmed for '+marker);
  state.wake.confirmedAt=new Date().toISOString();checkpoint();
}
module.exports={wake,delivered,titleOf};
