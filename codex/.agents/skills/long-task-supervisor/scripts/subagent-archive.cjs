#!/usr/bin/env node
// Which finished subagents of this conversation can be archived, and whether an archive took effect.
// The Codex App keeps two node_repl processes (about 19 MB together) for every conversation, subagents included, and
// releases them only when the conversation is archived or the App restarts (2026-11-17: 306 of them held about 2.9 GB;
// archiving two finished subagents ended their four processes within 20 seconds, and a follow-up sent to an archived
// subagent was answered while it stayed archived). Jay chose on 2026-11-17 to archive a subagent as soon as its result
// is accepted and no further follow-up is planned, and to sweep the rest when the task closes.
// This script only reads the App's local state; the dispatcher archives with the App tool set_thread_archived, because
// a fresh connection to the App tools pipe from a shell is refused (2026-11-17), then runs verify to read it back.
//   plan   [--parent <thread>] (--agent <name or path>)... | --all     -> {archive:[...], skip:[...]}
//   verify <thread>... [--parent <thread>] [--log <file.jsonl>]          -> exit 1 when any is not archived
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const LIFECYCLE=/"type":"(task_started|task_complete|turn_aborted)"/g;
const TAIL_BYTES=4*1024*1024;
function fail(message,code=2){process.stderr.write(message+'\n');process.exit(code);}
function openDb(file){
  const {DatabaseSync}=require('node:sqlite');
  if(!fs.existsSync(file))fail('Codex state database not found: '+file);
  return new DatabaseSync(file,{readOnly:true});
}
function dbPath(args){return args.db||process.env.LT_CODEX_STATE_DB||path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'state_5.sqlite');}
// Every conversation spawned under the parent, at any depth, with the path that names it.
function descendants(db,parent){
  const rows=[],queue=[parent],seen=new Set([parent]);
  const children=db.prepare('select e.child_thread_id id, t.agent_path agentPath, t.agent_nickname nickname, t.archived archived, t.rollout_path rollout from thread_spawn_edges e left join threads t on t.id=e.child_thread_id where e.parent_thread_id=?');
  while(queue.length){
    const id=queue.shift();
    for(const row of children.all(id)){
      if(seen.has(row.id))continue;
      seen.add(row.id);rows.push({...row,parentId:id});queue.push(row.id);
    }
  }
  return rows;
}
// The last turn event in the conversation's own rollout: a started turn without a completion is still running.
function turnState(rollout){
  if(!rollout||!fs.existsSync(rollout))return 'unknown';
  const size=fs.statSync(rollout).size;
  const read=bytes=>{
    const fd=fs.openSync(rollout,'r');
    try{const length=Math.min(bytes,size),buffer=Buffer.alloc(length);fs.readSync(fd,buffer,0,length,size-length);return buffer.toString('utf8');}
    finally{fs.closeSync(fd);}
  };
  let text=read(TAIL_BYTES),last=null;
  for(const match of text.matchAll(LIFECYCLE))last=match[1];
  if(!last&&size>TAIL_BYTES){text=read(size);for(const match of text.matchAll(LIFECYCLE))last=match[1];}
  if(!last)return 'unknown';
  return last==='task_started'?'running':'idle';
}
function matches(row,name){
  const agent=row.agentPath||'';
  return agent===name||agent.endsWith('/'+name)||row.nickname===name||row.id===name;
}
function parse(argv){
  const args={agents:[],ids:[]};
  for(let i=0;i<argv.length;i++){
    const value=argv[i];
    if(value==='--agent')args.agents.push(argv[++i]);
    else if(value==='--parent')args.parent=argv[++i];
    else if(value==='--log')args.log=argv[++i];
    else if(value==='--db')args.db=argv[++i];
    else if(value==='--all')args.all=true;
    else if(value.startsWith('--'))fail('Unknown option '+value);
    else args.ids.push(value);
  }
  for(const [key,value] of Object.entries(args))if(value===undefined)fail('Missing value for --'+key);
  args.parent||=process.env.CODEX_THREAD_ID;
  if(!args.parent)fail('No parent conversation: run inside a Codex conversation or pass --parent <thread id>');
  return args;
}
function plan(args){
  if(!args.all&&!args.agents.length)fail('Name the accepted subagents with --agent, or pass --all when the task closes');
  if(args.all&&args.agents.length)fail('Use either --agent or --all');
  const db=openDb(dbPath(args));
  const rows=descendants(db,args.parent).map(row=>({...row,state:row.archived?'archived':turnState(row.rollout)}));
  const under=id=>{const out=[],queue=[id];while(queue.length){const p=queue.shift();for(const row of rows)if(row.parentId===p){out.push(row);queue.push(row.id);}}return out;};
  const archive=[],skip=[],chosen=new Set();
  const consider=(row,reason)=>{
    if(chosen.has(row.id))return;chosen.add(row.id);
    const view={threadId:row.id,agentPath:row.agentPath,nickname:row.nickname};
    if(row.state==='archived')return skip.push({...view,reason:'already archived'});
    if(row.state==='running')return skip.push({...view,reason:'still running a turn'});
    if(row.state==='unknown')return skip.push({...view,reason:'no turn found in its rollout'});
    const busy=under(row.id).filter(child=>child.state==='running');
    if(busy.length)return skip.push({...view,reason:'its own subagent is still running: '+busy.map(child=>child.agentPath||child.id).join(', ')});
    archive.push({...view,...(reason?{via:reason}:{})});
  };
  if(args.all)for(const row of rows)consider(row);
  else for(const name of args.agents){
    const found=rows.filter(row=>matches(row,name));
    if(!found.length){skip.push({agent:name,reason:'no subagent of this conversation has that name'});continue;}
    for(const row of found){consider(row);for(const child of under(row.id))consider(child,'spawned by '+(row.agentPath||row.id));}
  }
  return {parent:args.parent,archive,skip};
}
function verify(args){
  if(!args.ids.length)fail('Give the thread ids that were archived');
  const db=openDb(dbPath(args));
  const get=db.prepare('select id, agent_path agentPath, archived from threads where id=?');
  const at=new Date().toISOString(),results=args.ids.map(id=>{const row=get.get(id);return {threadId:id,agentPath:row?.agentPath||null,archived:Boolean(row?.archived),...(row?{}:{missing:true})};});
  if(args.log){
    fs.mkdirSync(path.dirname(path.resolve(args.log)),{recursive:true});
    fs.appendFileSync(args.log,results.map(row=>JSON.stringify({at,parent:args.parent,...row})).join('\n')+'\n');
  }
  return {parent:args.parent,results,ok:results.every(row=>row.archived)};
}
if(require.main===module){
  const [command,...rest]=process.argv.slice(2);
  if(command!=='plan'&&command!=='verify')fail('Usage: subagent-archive.cjs plan (--agent <name>... | --all) [--parent <thread>] | verify <thread>... [--log <file>]');
  const args=parse(rest);
  const result=command==='plan'?plan(args):verify(args);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(command==='verify'&&!result.ok)process.exit(1);
}
module.exports={plan,verify,turnState};
