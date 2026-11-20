const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const roots = ['claude-code/.claude','codex/.agents'].map(p=>path.resolve(__dirname,'..',p,'skills/long-task-supervisor/scripts'));
const write = (file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const read = file=>JSON.parse(fs.readFileSync(file));
const preflight = {target:'test-machine',...Object.fromEntries(['files','syntax','directories','receipt'].map(k=>[k,{ok:true,evidence:k}]))};
const pkg = {id:'P1',testKind:'formal',handle:'main',exclusiveResources:[],evidence:['test entry point'],acceptanceIds:['C1'],
  caseIds:['suite-1','suite-2'],caseMap:{'suite-1':'1','suite-2':'2'},scarceMachine:true,target:'test-machine',preflight};
const fakeTransport = [
  "const fs=require('fs'),p=JSON.parse(fs.readFileSync(process.env.LT_FORMAL_PERMIT));",
  "fs.appendFileSync(process.argv[1],p.caseId+'\\n');",
  "const now=new Date().toISOString(),result={case:p.receiptCase,start:now,stop:now,status:process.argv[2]};",
  "fs.writeFileSync(process.env.LT_FORMAL_RECEIPT,JSON.stringify({id:p.id,nonce:p.nonce,caseId:p.caseId,revision:p.revision,result}));",
  "process.exitCode=Number(process.argv[3]);"
].join('');
function fixture(t,scripts) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'formal-case-'));
  t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const p=name=>path.join(root,name);
  fs.writeFileSync(p('source'),'Isolated contract');
  fs.writeFileSync(p('executor-prompt.txt'),'Isolated executor');
  const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(p(file))).digest('hex');
  write(p('contract.json'),{goal:'fixture',authorization:'test only',sources:[{path:p('source'),sha256:sha('source')}],
    criteria:[{id:'C1',requirement:'formal result',source:'source:1',verify:'read receipt'}]});
  write(p('binding.json'),{platform:'codex',executorId:'executor',projectRoot:root,allowedRoots:[root],
    contractSha256:sha('contract.json'),promptSha256:sha('executor-prompt.txt'),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
  const snapshot={schemaVersion:1,executorId:'executor',planningRevision:'plan-1',activity:'working',capacity:{verified:0,evidence:['fixture']},
    packages:{ready:[],inFlight:[structuredClone(pkg)],returned:[],blocked:[],completed:[],recurringRework:[]},
    acceptance:{revision:'r1',items:[{id:'C1',status:'PENDING',evidence:['source:1']}]}};
  function call(script,args,want=0) {
    const result=spawnSync(process.execPath,[path.join(scripts,script),...args],{encoding:'utf8',timeout:10000});
    assert.ifError(result.error);
    assert.equal(result.status,want,result.stderr || result.stdout);
    return result;
  }
  function dispatch(value,want=0) {write(p('input.json'),value);return call('dispatch.cjs',['write',root,p('input.json')],want);}
  function request(id,caseId='suite-2',workPackage='P1') {
    const q={id,caseId,workPackage,criterionId:'C1',revision:'r1',purpose:'formal'};write(p(id+'.req'),q);return q;
  }
  function formal(command,args,want) {return call('formal-case.cjs',[command,root,...args],want);}
  function run(id,outcome,exit=0,want=exit) {
    return formal('run',[p(id+'.req'),p(id+'.permit'),p(id+'.receipt'),'--',process.execPath,'-e',fakeTransport,p('starts'),outcome,String(exit)],want);
  }
  return {root,p,snapshot,dispatch,request,formal,run,call};
}
for (const scripts of roots) {
  const platform=scripts.includes('claude-code')?'Claude':'Codex';
  test(platform+' formal launch and journal recovery preserve separate cases and the target exit status',t=>{
    const {p,snapshot,dispatch,request,formal,run}=fixture(t,scripts);
    // Initial formal dispatch must check the target before allowing the first snapshot to be written.
    const work=snapshot.packages.inFlight[0];work.preflight={target:'wrong'};
    assert.match(dispatch(snapshot,1).stderr,/target, files, syntax, directories, receipt/);
    assert.equal(fs.existsSync(p('dispatch.json')),false);
    work.preflight=preflight;dispatch(snapshot);
    request('bad');let q=read(p('bad.req'));q.receiptCase='1';write(p('bad.req'),q);
    assert.match(run('bad','FAIL',0,1).stderr,/differs from registered mapping/);
    request('a');run('a','FAIL',13);run('a','FAIL');
    const duplicateEvidence=read(p('formal-cases.json')).permits[0].evidence;
    assert.ok(fs.existsSync(duplicateEvidence));
    const saved=read(p('a.receipt'));write(p('a.receipt'),{...saved,result:{...saved.result,status:'PASS'}});
    assert.match(run('a','PASS',0,1).stderr,/Conflicting receipt/);write(p('a.receipt'),saved);
    // A new package ID and different failure reason still belong to the same case.
    const second=read(p('dispatch.json'));second.packages.inFlight[0].id='P2';dispatch(second);
    request('b','suite-2','P2');run('b','INCONCLUSIVE');
    request('c','suite-2','P2');assert.match(run('c','PASS',0,1).stderr,/external research/);
    assert.equal(fs.existsSync(p('c.permit')),false);
    const plan=JSON.parse(formal('select',[p('c.req')]).stdout);
    assert.deepEqual(plan.allowed,[{caseId:'suite-1',receiptCase:'1'}]);assert.equal(plan.held[0].reason,'research');
    const newPackage=read(p('dispatch.json'));
    Object.assign(newPackage.packages.inFlight[0],{id:'P3',caseIds:['suite-2'],caseMap:{'suite-2':'2'}});
    assert.match(dispatch(newPackage,1).stderr,/Research required/);
    Object.assign(newPackage.packages.inFlight[0],{caseIds:['alias'],caseMap:{alias:'2'}});
    assert.match(dispatch(newPackage,1).stderr,/cannot be renamed/);
    request('d','suite-1','P2');formal('reserve',[p('d.req'),p('d.permit')]);
    request('conflict','suite-1','P2');assert.match(run('conflict','PASS',0,1).stderr,/awaiting its receipt/);
    run('d','PASS');
    const experiment=p('experiment');fs.writeFileSync(experiment,'Confirmed example');
    const research={caseId:'suite-2',afterId:'b',workPackage:'P2',failure:'receipt b',excluded:'different target excluded',
      sources:[{url:'https://example.org/test',checkedAt:'2025-01-01T00:00:00Z'}],experiment,experimentPassed:true,solution:'use revised candidate'};
    write(p('research.json'),{...research,experimentPassed:false});
    assert.match(formal('research',[p('research.json')],1).stderr,/experiment/);
    write(p('research.json'),research);formal('research',[p('research.json')]);
    run('c','FAIL');request('e','suite-2','P2');assert.match(run('e','PASS',0,1).stderr,/external research/);
    assert.deepEqual(fs.readFileSync(p('starts'),'utf8').trim().split('\n'),['suite-2','suite-2','suite-1','suite-2']);
    const attempts=fs.readFileSync(p('acceptance-history.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.kind==='attempt');
    assert.equal(attempts.length,4);assert.equal(attempts[2].outcome,'PASS');
  });
  test(platform+' one case result reused for multiple criteria counts only once; a late invalidated pass cannot clear subsequent failures',()=>{
    const {failures,needsResearch}=require(path.join(scripts,'formal-case.cjs'));
    const row={kind:'attempt',criterionId:'C1',caseId:'X',id:'a',outcome:'FAIL',revision:'r1',startedAt:'2025-01-01T00:00:00Z'};
    const history=[row,{...row,criterionId:'C2'}],state={permits:[],research:[]};
    assert.equal(needsResearch(history,state,row),false);
    history.push({kind:'change',toRevision:'r2',affectedCaseIds:['X'],requiredRegressionCaseIds:[]},
      {...row,id:'b',revision:'r2'},{...row,id:'old',outcome:'PASS'});
    assert.deepEqual(failures(history,row).map(x=>x.id),['a','b']);assert.equal(needsResearch(history,state,row),true);
    history.push({...row,revision:'r2',id:'c',outcome:'PASS'});
    assert.equal(needsResearch(history,state,row),false);
  });
}
