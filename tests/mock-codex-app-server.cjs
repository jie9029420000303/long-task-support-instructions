const fs=require('node:fs');
const readline=require('node:readline');
const data=JSON.parse(fs.readFileSync(process.env.MOCK_CODEX_FIXTURE,'utf8'));
const sentFile=process.env.MOCK_CODEX_SENT;
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
function call(name,args) {
  if (name==='wait_threads') return reply({polls:[{thread:{id:data.executorId},cursor:'cursor-1',
    latestTurn:{id:'executor-turn-1',status:'completed'},
    latestAssistantMessage:{phase:'final_answer',turnId:'executor-turn-1',text:'LONG_TASK_EVENT {"kind":"submission","revision":"sha256"}'}}]});
  if (name==='read_thread') {
    if (args.maxOutputCharsPerItem>20000) return {isError:true,content:[{type:'text',text:'too big'}]};
    if (args.threadId===data.executorId) return reply({thread:{id:data.executorId},turns:[{id:'executor-turn-1',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:data.final}]}]});
    const sends=fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[];
    return reply({thread:{id:data.supervisorId},turns:sends.map((prompt,index)=>({id:'review-'+index,status:'inProgress',items:[{type:'agentMessage',phase:'commentary',text:prompt}]}))});
  }
  if (name==='send_message_to_thread') {
    const sends=fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[];
    sends.push(args.prompt);fs.writeFileSync(sentFile,JSON.stringify(sends));
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
  } catch(error) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32603,message:error.message}})+'\n');}
});
