// v1.12.1: the watcher reads a long executor rollout in chunks. 2026-11-21 03:03 WebRPA: a new run bound at offset 0
// to the executor's 1.11GB rollout; the watcher turned everything since the offset into one string and crashed with
// "Cannot create a string longer than 0x1fffffe8 characters", so nothing woke the supervisor until it was restarted.
// Any new run bound to a long-lived executor starts there, so the read must survive a rollout past that limit and
// still see every row with its exact position (the parallel-test review re-reads a call from its saved offset).
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const clockPath=path.join(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts/supervisor-clock.cjs');

test('a new run reads an executor rollout larger than one string can hold and keeps exact row positions',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'large-rollout-')),oldHome=process.env.CODEX_HOME,stamp=new Date();
  const dir=path.join(root,'sessions',String(stamp.getFullYear()),String(stamp.getMonth()+1).padStart(2,'0'),String(stamp.getDate()).padStart(2,'0'));
  const id='large-rollout-executor',file=path.join(dir,'rollout-big-'+id+'.jsonl');
  const at=new Date().toISOString(),binding={executorId:id,createdAt:new Date(Date.now()-60000).toISOString()};
  const LIMIT=0x1fffffe8,CHUNK=8*1024*1024;
  const line=row=>Buffer.from(JSON.stringify(row)+'\n');
  const filler=bytes=>{const empty=line({type:'event_msg',payload:{type:'filler',text:''}}).length;
    return line({type:'event_msg',payload:{type:'filler',text:'x'.repeat(bytes-empty)}});};
  let fd;
  try{
    process.env.CODEX_HOME=root;fs.mkdirSync(dir,{recursive:true});
    fd=fs.openSync(file,'w');let size=0;const write=bytes=>{fs.writeSync(fd,bytes);size+=bytes.length;};
    write(line({type:'session_meta',payload:{id}}));
    // A refusal whose Chinese reason straddles the first read boundary, one byte into a three-byte character.
    const denial=line({timestamp:at,type:'response_item',payload:{type:'function_call_output',call_id:'boundary-denial',
      output:'Auto-review denied. Reason: 中文理由跨越讀取邊界'}});
    const cut=denial.indexOf(Buffer.from('中'))+1;
    write(filler(CHUNK-cut-size));assert.equal(size+cut,CHUNK);
    write(denial);
    // A long test call right after it: the position it records must be its own first byte.
    const callAt=size;
    write(line({timestamp:at,type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'after-boundary',
      arguments:JSON.stringify({cmd:'# LONG_TASK_LONG_TEST\nnode --test tests/all.cjs'})}}));
    const block=filler(1024*1024);while(size<LIMIT+CHUNK)write(block);
    write(line({timestamp:at,type:'turn_context',payload:{turn_id:'last',model:'gpt-6.2-sol',effort:'high',approval_policy:'never'}}));
    fs.closeSync(fd);fd=undefined;
    assert.ok(size>LIMIT,'the rollout is past the length one string can hold');
    const state={},result=require(clockPath).readExecutor(state,binding);
    assert.deepEqual(result,{readable:true,reason:null});
    assert.equal(state.executorOffset,size,'the whole rollout was consumed');
    assert.equal(state.executorSettings.model,'gpt-6.2-sol','the last row of the file was handled');
    assert.equal(state.reviewRejections?.[0]?.callId,'boundary-denial','a row split mid-character between reads was parsed');
    const source=state.parallelTestCalls?.['after-boundary']?.source;
    assert.equal(source?.offset,callAt,'a row after a read boundary keeps its exact byte position');
    const probe=Buffer.alloc(14),check=fs.openSync(file,'r');try{fs.readSync(check,probe,0,14,source.offset);}finally{fs.closeSync(check);}
    assert.equal(probe.toString('utf8'),'{"timestamp":"');
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
