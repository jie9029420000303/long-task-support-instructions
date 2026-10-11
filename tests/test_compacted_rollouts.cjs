// After compaction Codex continues a thread in rollout-<time>-<thread id>_<segment id>.jsonl. On 2026-10-11 the equity
// re-review supervisor moved to such a file; receipt reconciliation only matched names ending in the thread id, found
// nothing, and the delivery stayed uncertain. These tests pin how a thread's segments are found and used.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const THREAD='01a1268f-8d6e-7540-b74e-805eccbc37c1';
function home(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-segments-'));
  const day=(d)=>{const dir=path.join(root,'sessions','2026','10',d);fs.mkdirSync(dir,{recursive:true});return dir;};
  const rollout=(d,time,id,suffix='')=>{const file=path.join(day(d),'rollout-2026-10-'+d+'T'+time+'-'+THREAD+suffix+'.jsonl');line(file,{type:'session_meta',payload:{id}});return file;};
  return {root,day,rollout};
}
function withHome(root,fn){const old=process.env.CODEX_HOME;process.env.CODEX_HOME=root;try{return fn();}finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}}
const pace=()=>require(path.join(scripts,'pace.cjs'));

test('a compacted thread is every file whose session_meta names it, oldest first, and only those',()=>{
  const h=home();
  try{
    const original=h.rollout('10','23-50-00',THREAD);
    const second=h.rollout('11','01-27-38',THREAD,'_01a126db-24ca-7bf2-a7c3-1176cecf6535');
    const third=h.rollout('11','01-28-08',THREAD,'_01a126db-98c5-7c43-9985-e9da1556b0bd');
    // A file that carries the id in its name but belongs to another thread must not be read as this one.
    const stranger=path.join(h.day('11'),'rollout-2026-10-11T02-00-00-'+THREAD+'_other.jsonl');line(stranger,{type:'session_meta',payload:{id:'someone-else'}});
    withHome(h.root,()=>{
      assert.deepEqual(pace().sessionFiles(THREAD),[original,second,third]);
      assert.equal(pace().sessionFile(THREAD),third,'current turns live in the newest segment');
    });
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
});

test('a delivery receipt is found in whichever segment holds it, and a missing rollout is reported',()=>{
  const h=home();
  try{
    const original=h.rollout('11','00-05-04',THREAD);
    const latest=h.rollout('11','01-28-08',THREAD,'_01a126db-98c5-7c43-9985-e9da1556b0bd');
    line(latest,{type:'response_item',payload:{type:'message',content:[{type:'input_text',text:'LONG_TASK_DELIVERY:after-compaction'}]}});
    line(original,{type:'response_item',payload:{type:'message',content:[{type:'input_text',text:'LONG_TASK_DELIVERY:before-compaction'}]}});
    withHome(h.root,()=>{
      assert.deepEqual(pace().markerIn(THREAD,'LONG_TASK_DELIVERY:after-compaction'),{files:2,found:true});
      assert.deepEqual(pace().markerIn(THREAD,'LONG_TASK_DELIVERY:before-compaction'),{files:2,found:true});
      assert.deepEqual(pace().markerIn(THREAD,'LONG_TASK_DELIVERY:never-sent'),{files:2,found:false});
      // No rollout at all is a different answer from "not delivered": the watcher then asks read_thread instead.
      assert.deepEqual(pace().markerIn('no-such-thread','LONG_TASK_DELIVERY:x'),{files:0,found:false});
    });
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
});

test('the executor log follows the executor into its newer segment and starts reading it from the top',()=>{
  const h=home();
  try{
    const original=h.rollout('11','00-05-04',THREAD);
    const clock=require(path.join(scripts,'supervisor-clock.cjs'));
    withHome(h.root,()=>{
      const state={},binding={executorId:THREAD};
      assert.equal(clock.executorLog(state,binding),original);
      state.executorOffset=4096;
      const latest=h.rollout('11','01-28-08',THREAD,'_01a126db-98c5-7c43-9985-e9da1556b0bd');
      assert.equal(clock.executorLog(state,binding),latest,'a closed segment would never show new tool calls');
      assert.equal(state.executorOffset,0,'the old offset belongs to the old file');
      state.executorOffset=128;
      assert.equal(clock.executorLog(state,binding),latest);assert.equal(state.executorOffset,128,'staying on one file keeps the read position');
    });
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
});
