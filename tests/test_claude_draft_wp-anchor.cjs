'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const scripts=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts'),audit=require(path.join(scripts,'dispatch-audit.cjs'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wp-anchor-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'wp-outside-'));
const run=path.join(root,'run'),stateDir=path.join(root,'state'),wp=path.join(stateDir,'wp');fs.mkdirSync(run);fs.mkdirSync(wp,{recursive:true});
const binding={executorId:'exec',executorLog:path.join(root,'exec.jsonl'),createdAt:new Date().toISOString(),allowedRoots:[root],dispatchAudit:{enabled:true}};
const base=path.join(root,'base.json');fs.writeFileSync(base,JSON.stringify({capacity:{verified:2,evidence:['test']}}));
fs.writeFileSync(path.join(run,'binding.json'),JSON.stringify(binding));
const command=(...args)=>spawnSync(process.execPath,[path.join(scripts,'dispatch.cjs'),...args],{encoding:'utf8'});
const save=()=>JSON.parse(fs.readFileSync(path.join(run,'dispatch.json')));
try{
  let result=command('from-wp',run,stateDir,'--base',base);assert.equal(result.status,0,result.stderr);
  assert.equal(save().workPackageDirectory,fs.realpathSync(wp));
  const pkg=path.join(wp,'B.md');fs.writeFileSync(pkg,'[工作包]\nid=B；類型:B 技術\n[狀態] {"list":"inFlight","handle":"main"}\n');
  const auditState={};let check=audit.inspect(run,binding,auditState);
  const issue=check.issues.find(item=>item.kind==='wp_mismatch');assert.equal(issue.detail.wpList,'inFlight');assert.equal(issue.detail.snapshotList,null);
  const event=audit.eventFor(check);audit.markAnnounced(auditState,event);assert.equal(audit.inspect(run,binding,auditState).newIssues.length,0);
  fs.writeFileSync(path.join(run,'dispatch-write.lock'),'held');
  assert.equal(audit.stillCurrent(run,binding,auditState,event).current,null);
  const original=fs.readFileSync(pkg,'utf8');result=command('mark',run,stateDir,'B',JSON.stringify({list:'ready'}));
  assert.notEqual(result.status,0);assert.equal(fs.readFileSync(pkg,'utf8'),original,'lock protects the package and snapshot transition');
  fs.unlinkSync(path.join(run,'dispatch-write.lock'));
  result=command('from-wp',run,stateDir);assert.equal(result.status,0,result.stderr);
  check=audit.inspect(run,binding,auditState);assert.equal(check.issues.some(item=>item.kind==='wp_mismatch'),false);
  // Old snapshots derive the same source only from a verified package evidence path.
  const old=save();delete old.workPackageDirectory;fs.writeFileSync(path.join(run,'dispatch.json'),JSON.stringify(old));
  assert.equal(audit.inspect(run,binding,{}).wpSource.available,true);
  old.packages.inFlight=[];fs.writeFileSync(path.join(run,'dispatch.json'),JSON.stringify(old));
  const legacyState={},unknown=audit.inspect(run,binding,legacyState);
  assert.equal(unknown.wpSource.reason,'SOURCE_UNKNOWN');
  assert.ok(unknown.newIssues.some(item=>item.kind==='wp_source_unknown'),'unknown source is visible to the supervisor');
  const unknownEvent=audit.eventFor(unknown);audit.markAnnounced(legacyState,unknownEvent);
  assert.equal(audit.inspect(run,binding,legacyState).newIssues.length,0,'unchanged unknown source does not repeatedly wake the supervisor');
  old.activity='working';old.capacity.verified=2;old.packages.ready=[{id:'NEXT',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:NEXT']}];
  fs.writeFileSync(path.join(run,'dispatch.json'),JSON.stringify(old));
  assert.ok(audit.inspect(run,binding,legacyState).newIssues.some(item=>item.kind==='ready_capacity'),'an old run still raises new independent work while its source is unknown');
  fs.mkdirSync(path.join(outside,'wp'));result=command('from-wp',run,outside);
  assert.notEqual(result.status,0,'outside-root directory rejected');
  // A symlink inside the trusted folder cannot redirect scans or writes outside it.
  const secret=path.join(outside,'foreign.md');fs.writeFileSync(secret,'[狀態] {"list":"ready"}\n');fs.symlinkSync(secret,path.join(wp,'escape.md'));
  const snap=save();snap.workPackageDirectory=fs.realpathSync(wp);fs.writeFileSync(path.join(run,'dispatch.json'),JSON.stringify(snap));
  assert.equal(audit.inspect(run,binding,{}).wpSource.available,false);
  result=command('from-wp',run,stateDir);assert.notEqual(result.status,0);
  console.log('PASS: empty anchored snapshot, work-package mismatch, lock, old evidence fallback, roots and symlink');
}finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
