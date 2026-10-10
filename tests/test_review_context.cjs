const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const review=require(path.join(scripts,'review-context.cjs'));
const {listTools}=require(path.join(scripts,'mcp-client.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
test('short wake preserves the entire event on disk without sending its business text',()=>{
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'lean-review-'));
  try{
    const event={id:'event-1',kind:'question',text:'private-business-detail'.repeat(10000)};
    const prompt=review.prompt(run,event);
    assert.equal(prompt.includes('private-business-detail'),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(review.eventFile(run,event.id))),event);
    assert.ok(prompt.length<event.text.length/100);
    assert.equal(review.prompt(run,event),prompt,'restart keeps identical delivery content');
    assert.throws(()=>review.prompt(run,{...event,text:'changed'}),/changed/);
    assert.throws(()=>review.eventFile(run,'../../escape'),/Invalid/);
  }finally{fs.rmSync(run,{recursive:true,force:true});}
});
test('event context keeps operational reviews small and retains source-backed authorization updates',()=>{
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'context-cli-'));
  try{
    const source=path.join(run,'source.txt');fs.writeFileSync(source,'Original human instruction');
    const contract={goal:'QA',authorization:'Original human instruction',criteria:[{id:'A1',requirement:'UNIQUE_FULL_CRITERION',source:'source.txt:1',verify:'Read'}],sources:[{path:source,sha256:sha(source)}]};
    save(path.join(run,'contract.json'),contract);
    const binding={supervisorId:'supervisor',executorId:'executor',allowedRoots:[run],createdAt:new Date().toISOString(),contractSha256:sha(path.join(run,'contract.json'))};save(path.join(run,'binding.json'),binding);
    const event={id:'progress-1',kind:'progress_review',reasons:['overdue'],text:'large old text'.repeat(5000)};
    save(path.join(run,'daemon-state.json'),{pending:event,messages:[],phase:'awaiting_decision'});
    const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),...args],{encoding:'utf8',env:{...process.env,CODEX_HOME:path.join(run,'empty-home')}}));
    const context=cli('context',run,event.id);
    assert.equal(context.authorization.command,'supervise.cjs authorization RUN');
    const authority=cli('authorization',run);
    assert.equal(authority.original,contract.authorization);
    assert.deepEqual(authority.sources,contract.sources);
    assert.equal(JSON.stringify(context).includes('UNIQUE_FULL_CRITERION'),false);
    assert.equal(context.detail,undefined);assert.equal(context.brief.pending.text,undefined);
    assert.throws(()=>cli('context',run,'stale-1'));
    const submission={id:'submit-1',kind:'submission',revision:'sha256:'+sha(source),manifest:source};save(path.join(run,'daemon-state.json'),{pending:submission,messages:[],phase:'awaiting_decision'});
    assert.deepEqual(cli('context',run,submission.id).contract,contract,'submission still loads all acceptance criteria');
    fs.writeFileSync(source,'changed human instruction');assert.throws(()=>cli('authorization',run));
  }finally{fs.rmSync(run,{recursive:true,force:true});}
});
test('tool discovery follows pages with caller metadata and preserves actual errors',async()=>{
  const calls=[],meta={thread:'original'};
  const client={request:async(method,args)=>{calls.push(args);return args.cursor?{result:{tools:[{name:'wait_threads'}]}}:{result:{tools:[{name:'read_thread'}],nextCursor:'page2'}};}};
  assert.deepEqual([...await listTools(client,meta)],['read_thread','wait_threads']);
  assert.deepEqual(calls,[{_meta:meta},{cursor:'page2',_meta:meta}]);
  await assert.rejects(listTools({request:async()=>({error:{message:'pipe closed'}})}),/pipe closed/);
  await assert.rejects(listTools({request:async()=>({result:{tools:[],nextCursor:'repeat'}})}),/Repeated/);
});

test('overdue activity filter uses the existing window and never hides missing activity',()=>{
  const {overdueNeedsReview}=require(path.join(scripts,'supervisor-clock.cjs'));
  const now=Date.now(),base={ratio:2};
  assert.equal(overdueNeedsReview({...base,lastActivityAt:new Date(now-60000).toISOString()},now),false);
  assert.equal(overdueNeedsReview({...base,lastActivityAt:new Date(now-16*60000).toISOString()},now),true);
  assert.equal(overdueNeedsReview(base,now),true);
  assert.equal(overdueNeedsReview({...base,lastActivityAt:'invalid'},now),true);
  assert.equal(overdueNeedsReview({...base,lastActivityAt:new Date(now+60000).toISOString()},now),true);
  assert.equal(overdueNeedsReview({...base,ratio:null},now),false,'completed package remains exempt');
});
