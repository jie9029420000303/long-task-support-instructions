const fs=require('node:fs');
const readline=require('node:readline');
const log=process.env.MOCK_LOG;
readline.createInterface({input:process.stdin}).on('line',line=>{
 let m;try{m=JSON.parse(line)}catch{return} if(!m.id)return;
 let result={};
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{}};
 else if(m.method==='tools/list')result={tools:[{name:'read_thread'},{name:'send_message_to_thread'}]};
 else if(m.method==='tools/call'){
  const {name,arguments:a}=m.params;
  const messages=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  let data;
  if(name==='send_message_to_thread'){
   fs.appendFileSync(log,JSON.stringify({threadId:a.threadId,prompt:a.prompt})+'\n');
   if(process.env.MOCK_HOLD_ANSWER==='1' && a.prompt.includes('LONG_TASK_DELIVERY:answer-')) return;
   data={threadId:a.threadId};
  }else data={thread:{id:a.threadId,title:a.threadId,status:{type:'idle'}},turns:messages.filter(x=>x.threadId===a.threadId).map((x,i)=>({id:'turn-'+i,status:'completed',items:[{type:'agentMessage',text:x.prompt}]}))};
  result={content:[{type:'text',text:JSON.stringify(data)}],isError:false};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});
