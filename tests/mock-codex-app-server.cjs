const fs=require('node:fs');
const readline=require('node:readline');
const data=JSON.parse(fs.readFileSync(process.env.MOCK_CODEX_FIXTURE,'utf8'));
const sentFile=process.env.MOCK_CODEX_SENT;
let waitCount=0,currentTurn=0,executorPollReads=0;
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
// What wait_threads used to report as the next poll; since v0.34.0 the watcher polls with read_thread(turnLimit:1),
// so the first such read (the startup proof) leaves the turn alone and each later one advances it the same way.
function advance(){
  const gateClosed=data.secondTurnGate && !fs.existsSync(data.secondTurnGate);
  const next=data.secondTurnGate ? (waitCount++ + 1) : waitCount++;
  currentTurn=gateClosed?0:Math.min(next,Math.max(0,(data.finals?.length||1)-1));
}
function call(name,args) {
  if (sentFile) fs.appendFileSync(sentFile+'.tools',name+'\n');
  if (name==='wait_threads') {
    if(data.waitError)throw Object.assign(Error(data.waitError.message),{code:data.waitError.code});
    if(args.targets.some(target=>target.threadId===data.supervisorId)) throw Error('wait_threads cannot wait on the calling thread.');
    const gateClosed=data.secondTurnGate && !fs.existsSync(data.secondTurnGate);
    const next=data.secondTurnGate ? (waitCount++ + 1) : waitCount++;
    currentTurn=gateClosed?0:Math.min(next,Math.max(0,(data.finals?.length||1)-1));
    const turnId='executor-turn-'+(currentTurn+1);
    const activity=data.activityGate && fs.existsSync(data.activityGate);
    const executor={thread:{id:data.executorId},cursor:'cursor-'+(currentTurn+1)+(activity?'-active':''),
    ...(activity?{latestAssistantMessageId:'executor-new-activity'}:{}),
    ...(data.noTurn?{}:{latestTurn:{id:turnId,status:'completed'},
    latestAssistantMessage:{phase:'final_answer',turnId,text:'LONG_TASK_EVENT {"kind":"submission","revision":"sha256"}'}})};
    const supervisorActivity=data.supervisorActivityGate && fs.existsSync(data.supervisorActivityGate);
    const supervisor={thread:{id:data.supervisorId},cursor:supervisorActivity?'supervisor-active':'supervisor-idle',
      latestAssistantMessageId:supervisorActivity?'supervisor-new-message':'supervisor-old-message',
      latestTurn:{id:supervisorActivity?'supervisor-new-turn':'supervisor-old-turn',status:'completed',completedAt:0}};
    return reply({polls:args.targets.map(target=>target.threadId===data.executorId?executor:supervisor)});
  }
  if (name==='read_thread') {
    if(data.readErrorFile&&fs.existsSync(data.readErrorFile)){
      const left=Number(fs.readFileSync(data.readErrorFile,'utf8'));
      if(left>0){fs.writeFileSync(data.readErrorFile,String(left-1));throw Object.assign(Error(data.readErrorMessage||'MCP error -32000: Codex app tool request failed'),{code:-32000});}
    }
    if (args.maxOutputCharsPerItem>20000) return {isError:true,content:[{type:'text',text:'too big'}]};
    // The App refuses a read whose reply would be too large, every time with the same arguments.
    if (data.sizeLimitChars && args.turnLimit*args.maxOutputCharsPerItem>data.sizeLimitChars) return {isError:true,content:[{type:'text',text:'Tool response exceeds the size limit'}]};
    if (args.threadId===data.executorId) {
      if (args.turnLimit===1 && executorPollReads++>0) advance();
      const finals=data.finals||[data.final],turnId='executor-turn-'+(currentTurn+1);
      const sends=data.receiptGate&&!fs.existsSync(data.receiptGate)?[]:(fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[]);
      const activity=data.activityGate && fs.existsSync(data.activityGate);
      if (data.noTurn && args.turnLimit===1) return reply({thread:{id:data.executorId},turns:activity?[{id:'executor-active-turn',status:'inProgress',items:[{type:'agentMessage',id:'executor-new-activity',text:'working'}]}]:[]});
      return reply({thread:{id:data.executorId},turns:[{id:turnId,status:data.readTurnStatus||'completed',items:[{type:'agentMessage',phase:'final_answer',text:finals[currentTurn]},...sends.map(text=>({type:'userMessage',text})),
        ...(activity?[{type:'agentMessage',id:'executor-new-activity',text:'working'}]:[])]}]});
    }
    const sends=data.receiptGate&&!fs.existsSync(data.receiptGate)?[]:(fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[]);
    const activity=data.supervisorActivityGate && fs.existsSync(data.supervisorActivityGate);
    // supervisorIdle: the supervisor finished a turn just now and sits idle, as after a dropped queued message.
    const latest={id:activity?'supervisor-new-turn':'supervisor-old-turn',status:'completed',completedAt:data.supervisorIdle?Math.floor(Date.now()/1000):0,
      items:[...(activity?[{type:'userMessage',id:'human-user-new',text:'Approval granted'}]:[]),{type:'agentMessage',id:activity?'supervisor-new-message':'supervisor-old-message',phase:'final_answer',text:'Supervisor status'}]};
    return reply({thread:{id:data.supervisorId,...(data.supervisorIdle?{status:{type:'idle'}}:{})},turns:[latest,...(args.turnLimit===1?[]:sends.map((prompt,index)=>({id:'review-'+index,status:'inProgress',items:[{type:'userMessage',text:prompt}]})))]});
  }
  if (name==='send_message_to_thread') {
    const sends=fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[];
    sends.push(args.prompt);fs.writeFileSync(sentFile+'.tmp',JSON.stringify(sends));fs.renameSync(sentFile+'.tmp',sentFile);
    // Model overrides are recorded beside the prompts so a rate-limit switch and its restore can be checked.
    const argsFile=sentFile+'.args.json',calls=fs.existsSync(argsFile)?JSON.parse(fs.readFileSync(argsFile,'utf8')):[];
    calls.push({threadId:args.threadId,model:args.model||null,thinking:args.thinking||null,prompt:args.prompt});fs.writeFileSync(argsFile,JSON.stringify(calls));
    return reply({threadId:args.threadId});
  }
  throw Error('Unexpected tool '+name);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  let req;try {req=JSON.parse(line);} catch {return;}
  if (!req.id) return;
  let result;
  try {
    if (req.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'qa',version:'1'}};
    else if (req.method==='tools/list') result={tools:['wait_threads','read_thread','send_message_to_thread'].map(name=>({name}))};
    else if (req.method==='tools/call') result=call(req.params.name,req.params.arguments||{});
    else throw Error('Unexpected method '+req.method);
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
  } catch(error) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:error.code??-32603,message:error.message}})+'\n');}
});
