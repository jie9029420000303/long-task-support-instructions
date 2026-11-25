// v1.15.1 (Jay 2026-11-25 Q1 A): after prolite ran out, OpenCodex served gpt-6.2-sol through the free account, which
// answers HTTP 400 model_unavailable. Counted as an ordinary failure, it took three failures over a minute before the
// chat moved, and 清票's executor failed twice before its supervisor moved it by hand. What each test pins: the first
// model_unavailable answer moves the chat to its next route on either side, an ordinary 400 still waits for a run of
// failures, and the notice names the real cause instead of a quota limit.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const sol='gpt-6.2-sol';
function withUsage(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-unavailable-')),usage=path.join(root,'usage.jsonl'),old=process.env.OPENCODEX_USAGE_FILE;
  fs.writeFileSync(usage,'');process.env.OPENCODEX_USAGE_FILE=usage;
  try{return fn(usage);}finally{if(old===undefined)delete process.env.OPENCODEX_USAGE_FILE;else process.env.OPENCODEX_USAGE_FILE=old;fs.rmSync(root,{recursive:true,force:true});}
}
// The 2026-11-25 11:00:16 row of 清票's executor, trimmed to the fields the watcher reads.
const refusal=(threadId,at,extra={})=>({conversationId:fallback.hashId(threadId),timestamp:at,provider:'openai-p23897d',model:sol,requestedModel:sol,
  status:400,errorCode:'invalid_request_error',upstreamCondition:'model_unavailable',...extra});

test('the first model_unavailable answer moves the supervisor and the executor to their next route',()=>withUsage(usage=>{
  const threads=[{role:'supervisor',threadId:'supervisor-qa'},{role:'executor',threadId:'executor-qa'}],state={},now=Date.now();
  fallback.scan(state,threads);
  line(usage,refusal('supervisor-qa',now-2000));line(usage,refusal('executor-qa',now-1000));
  const hits=fallback.scan(state,threads);
  assert.deepEqual(hits.map(hit=>[hit.role,hit.model,hit.unsupported,hit.failure]),[['supervisor',sol,true,undefined],['executor',sol,true,undefined]]);
  assert.equal(state.routeRefused[sol],now-1000,'the route counts as refused, so a later success ends the pause the usual way');
  assert.equal(state.routeFailures,undefined,'it is not added to the run of ordinary failures');
  assert.equal(fallback.switchReason(hits[1],'openai-apikey/gpt-6.2-sol',15*60000),'目前的帳號不支援 gpt-6.2-sol（OpenCodex 回 model_unavailable）：');
  assert.equal(fallback.restoreReason({basis:'同一路線之後已有成功請求',cooldown:'unsupported'}),'原模型已可再用。','it is not reported as quota coming back');
}));

test('an ordinary HTTP 400 without model_unavailable still waits for a run of failures',()=>withUsage(usage=>{
  const threads=[{role:'executor',threadId:'executor-qa'}],state={},now=Date.now();
  fallback.scan(state,threads);
  line(usage,refusal('executor-qa',now-1000,{upstreamCondition:undefined}));
  assert.deepEqual(fallback.scan(state,threads),[]);
  assert.equal(state.routeFailures['executor-qa'].count,1);
}));

test('the watcher pauses a route the account cannot run for five hours with its own reason',()=>{
  const watch=fs.readFileSync(path.join(scripts,'native-watch.cjs'),'utf8');
  assert.ok(watch.includes("hit.unsupported?{until:hit.at+fallback.FALLBACK_MS,basis:fallback.UNSUPPORTED_BASIS,cooldown:'unsupported'}"));
  assert.equal(fallback.FALLBACK_MS,5*60*60*1000);
});

