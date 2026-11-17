// v1.7.1. Archiving a conversation moves its rollout from sessions/YYYY/MM/DD to archived_sessions/, one flat folder,
// and a follow-up sent to an archived subagent keeps writing there. v1.7.0 archived finished subagents but every lookup
// still read sessions/ only, so the watcher lost sight of a subagent that was archived and then sent more work: no
// activity, no completion, a possible false overdue or silence alarm, and an executor waiting for a completion signal
// it would never get (reported by the workspace E supervisor on 2026-11-17, which then stopped re-dispatching archived
// subagents). Every test here guards one of: an archived rollout is found by thread id and for receipts; a follow-up
// turn written after archiving is seen as activity and completion; a rollout seen in both places counts once; old
// compressed archives and archives from before the run are not read.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const pace=()=>require(path.join(scripts,'pace.cjs'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const pad=n=>String(n).padStart(2,'0');
const stamp=date=>date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+'-'+pad(date.getMinutes())+'-'+pad(date.getSeconds());
function home(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v171-')),old=process.env.CODEX_HOME;
  process.env.CODEX_HOME=root;
  t.after(()=>{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;fs.rmSync(root,{recursive:true,force:true});});
  const archived=path.join(root,'archived_sessions');fs.mkdirSync(archived,{recursive:true});
  const live=date=>{const dir=path.join(root,'sessions',String(date.getFullYear()),pad(date.getMonth()+1),pad(date.getDate()));fs.mkdirSync(dir,{recursive:true});return dir;};
  // A rollout file named the way Codex names it, with the local start time, holding a subagent's session_meta.
  const rollout=(dir,date,id,owner='executor',suffix='.jsonl')=>{
    const file=path.join(dir,'rollout-'+stamp(date)+'-'+id+suffix);
    line(file,{type:'session_meta',timestamp:date.toISOString(),payload:{id,thread_source:'subagent',session_id:owner,parent_thread_id:owner,agent_path:'/root/'+id}});
    return file;
  };
  return {root,archived,live,rollout};
}
const turn=(file,at,id)=>{
  line(file,{type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type:'task_started',turn_id:id}});
  line(file,{type:'event_msg',timestamp:new Date(at+90000).toISOString(),payload:{type:'task_complete',turn_id:id}});
};
const binding=()=>({executorId:'executor',createdAt:new Date(Date.now()-3600000).toISOString()});

test('an archived subagent is found by thread id and its delivery receipt is found too',t=>{
  const h=home(t),start=new Date(Date.now()-1800000);
  const file=h.rollout(h.archived,start,'v171-found');
  line(file,{type:'response_item',payload:{type:'message',content:[{type:'input_text',text:'LONG_TASK_DELIVERY:after-archive'}]}});
  assert.equal(pace().sessionFile('v171-found'),file,'the watcher reads this thread\'s turns from the file it finds here');
  assert.deepEqual(pace().markerIn('v171-found','LONG_TASK_DELIVERY:after-archive'),{files:1,found:true},'files:0 would send it to read_thread as if no rollout existed');
});

test('a follow-up turn written after archiving is seen as new activity and a new completion',t=>{
  const h=home(t),start=new Date(Date.now()-1800000),b=binding();
  const file=h.rollout(h.archived,start,'v171-followup');
  turn(file,start.getTime()+1000,'first');
  const before=pace().agentRuns(b).find(run=>run.id==='v171-followup');
  assert.ok(before,'an archived subagent of this executor must still be listed');
  assert.equal(before.completedTurnId,'first');
  // The dispatcher sends one more question to the archived subagent; Codex keeps appending to the archived file.
  turn(file,start.getTime()+600000,'follow-up');
  const after=pace().agentRuns(b).find(run=>run.id==='v171-followup');
  assert.equal(after.completedTurnId,'follow-up','the executor waits for exactly this completion');
  assert.ok(after.lastAt>before.lastAt,'without new activity the watcher would call the subagent silent');
  assert.equal(after.done,true);
});

test('a subagent seen in both places counts once and the file written last wins',t=>{
  const h=home(t),start=new Date(Date.now()-1800000),b=binding();
  const stale=h.rollout(h.live(start),start,'v171-twice');turn(stale,start.getTime()+1000,'first');
  const moved=h.rollout(h.archived,start,'v171-twice');turn(moved,start.getTime()+1000,'first');turn(moved,start.getTime()+600000,'follow-up');
  const runs=pace().agentRuns(b).filter(run=>run.id==='v171-twice');
  assert.equal(runs.length,1,'two entries would double this subagent in speed samples and in-flight counts');
  assert.equal(runs[0].completedTurnId,'follow-up');
  assert.equal(runs[0].sourceFile,moved);
});

test('old compressed archives, archives from before the run and other conversations\' subagents are not read',t=>{
  const h=home(t),start=new Date(Date.now()-1800000),b=binding();
  turn(h.rollout(h.archived,start,'v171-zst','executor','.jsonl.zst'),start.getTime()+1000,'x');
  const old=new Date(Date.now()-5*86400000);turn(h.rollout(h.archived,old,'v171-old'),old.getTime()+1000,'x');
  turn(h.rollout(h.archived,start,'v171-other','someone-else'),start.getTime()+1000,'x');
  turn(h.rollout(h.archived,start,'v171-mine'),start.getTime()+1000,'x');
  assert.deepEqual(pace().agentRuns(b).map(run=>run.id),['v171-mine']);
});

test('both Codex orchestration skills tell the dispatcher an archived subagent stays watched after a follow-up',()=>{
  const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
  assert.ok(read('codex/.agents/skills/goal-orchestrator/SKILL.md').includes('監看與完成喚醒連同這裡一起讀'),'goal-orchestrator');
  assert.ok(read('codex/.agents/skills/long-task-supervisor/SKILL.md').includes('不必為此限制封存或續派'),'long-task-supervisor');
});
