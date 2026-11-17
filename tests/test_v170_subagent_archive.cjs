// v1.7.0 (Jay 2026-11-17: "A 驗收後立刻封存，結案時再清一次（推薦）").
// The Codex App keeps two node_repl processes (about 19 MB) for every conversation, subagents included, until the
// conversation is archived or the App restarts: on 2026-11-17 306 of them held about 2.9 GB, and a day of long tasks
// started 165-194 subagents. Archiving two finished subagents ended their processes within 20 seconds, and a follow-up
// sent to an archived subagent was still answered. Every test here guards one of: a subagent that is still working is
// never offered for archiving (it would lose its tools mid-turn); an accepted subagent takes its finished children with
// it; the closing sweep leaves nothing idle behind; a wrong name is reported, not silently dropped; an archive that did
// not take effect fails loudly and every archive is recorded so it can be undone; both orchestration skills say when.
// Claude Code subagents run inside the session and keep no conversation behind, so only the Codex skills carry this.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const repo=path.resolve(__dirname,'..');
const script=path.join(repo,'codex/.agents/skills/long-task-supervisor/scripts/subagent-archive.cjs');
const PARENT='parent-thread';
// A copy of the App's local state with only what the script reads: conversations, who spawned whom, their rollouts.
function app(agents){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v170-')),file=path.join(root,'state_5.sqlite'),db=new DatabaseSync(file);
  db.exec('create table threads (id text primary key, rollout_path text, archived integer default 0, agent_path text, agent_nickname text); create table thread_spawn_edges (parent_thread_id text not null, child_thread_id text not null primary key, status text not null)');
  const thread=db.prepare('insert into threads values (?,?,?,?,?)'),edge=db.prepare("insert into thread_spawn_edges values (?,?,'open')");
  for(const agent of agents){
    const rollout=path.join(root,agent.id+'.jsonl');
    const events=(agent.turns||[]).map(type=>JSON.stringify({type:'event_msg',payload:{type}}));
    fs.writeFileSync(rollout,[JSON.stringify({type:'session_meta',payload:{id:agent.id}}),...(agent.padding?['x'.repeat(agent.padding)]:[]),...events].join('\n')+'\n');
    if(agent.trailing)fs.appendFileSync(rollout,'y'.repeat(agent.trailing)+'\n');
    thread.run(agent.id,rollout,agent.archived?1:0,agent.path,agent.nickname||null);
    edge.run(agent.parent||PARENT,agent.id);
  }
  db.close();
  return {file,root,archive:id=>{const w=new DatabaseSync(file);w.prepare('update threads set archived=1 where id=?').run(id);w.close();}};
}
const done=['task_started','task_complete'],working=['task_started','task_complete','task_started'];
function run(state,args,extra={}){
  const result=spawnSync(process.execPath,[script,...args],{env:{...process.env,LT_CODEX_STATE_DB:state.file,CODEX_THREAD_ID:PARENT,...extra},encoding:'utf8'});
  return {code:result.status,out:result.stdout?JSON.parse(result.stdout):null,err:result.stderr};
}
const ids=list=>list.map(row=>row.threadId).sort();
test('a subagent still in a turn is never offered for archiving, even when named',()=>{
  const state=app([{id:'busy',path:'/root/busy',turns:working},{id:'aborted',path:'/root/aborted',turns:['task_started','turn_aborted']}]);
  const result=run(state,['plan','--agent','busy','--agent','aborted']);
  assert.equal(result.code,0);
  assert.deepEqual(ids(result.out.archive),['aborted'],'an interrupted turn is over; a started one is not');
  assert.equal(result.out.skip[0].reason,'still running a turn');
});
test('an accepted subagent takes its finished children with it, but not while one of them still works',()=>{
  const state=app([
    {id:'lead',path:'/root/lead',turns:done},{id:'helper',path:'/root/lead/helper',parent:'lead',turns:done},
    {id:'owner',path:'/root/owner',turns:done},{id:'grandchild',path:'/root/owner/grandchild',parent:'owner',turns:working}]);
  assert.deepEqual(ids(run(state,['plan','--agent','lead']).out.archive),['helper','lead']);
  const owner=run(state,['plan','--agent','owner']).out;
  assert.deepEqual(owner.archive,[],'archiving the owner while its own subagent works would leave that work without a parent to report to');
  assert.match(owner.skip.find(row=>row.threadId==='owner').reason,/still running: \/root\/owner\/grandchild/);
});
test('the closing sweep lists every idle subagent at any depth and nothing already archived or other conversations\' subagents',()=>{
  const state=app([
    {id:'a',path:'/root/a',turns:done},{id:'b',path:'/root/b',turns:done,archived:true},
    {id:'c',path:'/root/a/c',parent:'a',turns:done},{id:'other',path:'/root/x',parent:'someone-else',turns:done}]);
  const result=run(state,['plan','--all']).out;
  assert.deepEqual(ids(result.archive),['a','c']);
  assert.deepEqual(result.skip.map(row=>[row.threadId,row.reason]),[['b','already archived']]);
});
test('names match the agent path, its last part or the nickname; a name that matches nothing is reported',()=>{
  const state=app([{id:'n1',path:'/root/adv_quality',nickname:'Noether',turns:done},{id:'n2',path:'/root/adv_factcheck',nickname:'Bohr',turns:done}]);
  assert.deepEqual(ids(run(state,['plan','--agent','/root/adv_quality','--agent','Bohr']).out.archive),['n1','n2']);
  const missing=run(state,['plan','--agent','adv_typo']).out;
  assert.deepEqual(missing.archive,[]);assert.deepEqual(missing.skip,[{agent:'adv_typo',reason:'no subagent of this conversation has that name'}]);
});
test('the turn state is found even when the last turn event sits far from the end of a long rollout',()=>{
  const state=app([{id:'long',path:'/root/long',turns:working,trailing:5*1024*1024}]);
  assert.equal(run(state,['plan','--all']).out.skip[0].reason,'still running a turn','4 MB of output after the turn started must not hide it');
  const early=app([{id:'early',path:'/root/early',turns:['task_started'],trailing:5*1024*1024}]);
  assert.equal(run(early,['plan','--all']).out.skip[0].reason,'still running a turn');
});
test('verify fails when an archive did not take effect and records every result for undoing later',()=>{
  const state=app([{id:'x',path:'/root/x',turns:done},{id:'y',path:'/root/y',turns:done}]);
  const log=path.join(state.root,'sidecar','archived-agents.jsonl');
  state.archive('x');
  const partial=run(state,['verify','x','y','--log',log]);
  assert.equal(partial.code,1,'a dispatcher that thinks it archived y must not move on');
  state.archive('y');
  assert.equal(run(state,['verify','y','--log',log]).code,0);
  const lines=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(lines.map(row=>[row.threadId,row.agentPath,row.archived,row.parent]),[['x','/root/x',true,PARENT],['y','/root/y',false,PARENT],['y','/root/y',true,PARENT]]);
  assert.ok(lines.every(row=>!Number.isNaN(Date.parse(row.at))));
});
test('it refuses to guess: no parent conversation, no names, or both a name and --all',()=>{
  const state=app([{id:'a',path:'/root/a',turns:done}]);
  assert.equal(run(state,['plan','--all'],{CODEX_THREAD_ID:''}).code,2);
  assert.equal(run(state,['plan']).code,2);
  assert.equal(run(state,['plan','--all','--agent','a']).code,2);
  assert.deepEqual(ids(run(state,['plan','--all','--parent',PARENT],{CODEX_THREAD_ID:''}).out.archive),['a']);
});
test('both Codex orchestration skills and the shared spec say when to archive and how to check it',()=>{
  const read=file=>fs.readFileSync(path.join(repo,file),'utf8');
  const orchestrator=read('codex/.agents/skills/goal-orchestrator/SKILL.md')+read('codex/.agents/skills/goal-orchestrator/references/execution.md');
  for(const marker of ['子代理用完即封存','subagent-archive.cjs plan --agent','set_thread_archived','subagent-archive.cjs verify','plan --all','archived-agents.jsonl','不必先解除'])
    assert.ok(orchestrator.includes(marker),'goal-orchestrator: '+marker);
  const supervisor=read('codex/.agents/skills/long-task-supervisor/SKILL.md');
  for(const marker of ['子代理用完即封存','subagent-archive.cjs plan --all --parent'])assert.ok(supervisor.includes(marker),'long-task-supervisor: '+marker);
  assert.ok(read('SPEC.md').includes('派工方在工作包判定且不再追問該子代理後封存'),'shared spec invariant 27');
});
