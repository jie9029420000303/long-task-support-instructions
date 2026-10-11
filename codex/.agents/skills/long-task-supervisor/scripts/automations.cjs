// Scheduled automations aimed at a supervised conversation replay long prompts on their own clock and fight the
// watcher (Jay 2026-10-10: "我還是看到了落落長的監督排程prompt"). The watcher looks for active ones at start and
// every 30 minutes; the supervisor pauses them, never deletes them, and tells Jay their name and why.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=()=>path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'automations');
function field(text,name){
  const match=new RegExp('^'+name+'\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"','m').exec(text);
  return match?JSON.parse('"'+match[1]+'"'):null;
}
function list(){
  let names=[];try{names=fs.readdirSync(root());}catch{return [];}
  const items=[];
  for(const name of names){
    try{const text=fs.readFileSync(path.join(root(),name,'automation.toml'),'utf8');
      items.push({id:field(text,'id')||name,name:field(text,'name'),kind:field(text,'kind'),status:field(text,'status'),
        target:field(text,'target_thread_id'),prompt:field(text,'prompt')||'',updatedAt:/^updated_at\s*=\s*(\d+)/m.exec(text)?.[1]||null});}catch{}
  }
  return items;
}
function aimedAt(threadIds){
  return list().filter(item=>item.status==='ACTIVE'&&threadIds.some(id=>item.target===id||item.prompt.includes(id)))
    .map(({id,name,kind,status,target,updatedAt})=>({id,name,kind,status,target,updatedAt}));
}
module.exports={list,aimedAt};
