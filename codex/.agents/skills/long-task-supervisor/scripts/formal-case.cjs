// An execution-mainline command. Reserve under the existing dispatch writer lock, then carry
// the single-use permit to the target. An outstanding receipt survives a disconnect or restart.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {isDeepStrictEqual} = require('node:util');
const audit = require('./acceptance-audit.cjs');
const contract = require('./contract-state.cjs');
const rework = require('./rework.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const required = (value, label) => { if (!value) throw Error(label); };
const string = v => typeof v === 'string' && v.trim().length > 0;
const checks = ['files', 'syntax', 'directories', 'receipt'];
function write(file, value) {
  const tmp = file + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {flag:'wx',mode:0o600});
  try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, {force:true}); }
}
function sameCase(a,b) { return a.caseId === b.caseId; }
// The failure stops count per acceptance criterion in rework.cjs, for every kind of package; a formal case whose
// criterion is held waits there too.
function eligible(history,criterionId) {
  const item=rework.tally(history).get(criterionId);
  required(!rework.held(history,[criterionId]).length, '驗收條文 '+criterionId+' 已累計 '+item?.failures.length+' 次不合格：'+(item&&rework.nextStep(item))+'，之後才發下一次正式實測許可');
}
function checkPreflight(pkg) {
  if (!pkg.scarceMachine && !pkg.target) return;
  const p = pkg.preflight;
  const missing = checks.filter(k => p?.[k]?.ok !== true || !string(p[k].evidence));
  if (!string(pkg.target) || pkg.target !== p?.target) missing.unshift('target');
  required(!missing.length, 'Target preflight failed for '+pkg.id+': '+missing.join(', '));
}
function nativeCase(pkg,id) {
  if (pkg.caseMap === undefined) return id;
  required(pkg.caseMap && typeof pkg.caseMap === 'object' && !Array.isArray(pkg.caseMap) &&
    Object.hasOwn(pkg.caseMap,id) && string(pkg.caseMap[id]), 'Missing native case mapping for '+id);
  return pkg.caseMap[id];
}
function checkMappings(packages, state) {
  const names = new Map(), numbers = new Map();
  function register(id, native, suite) {
    const nameKey = JSON.stringify([suite,id]), numberKey = JSON.stringify([suite,native]);
    required(!names.has(nameKey) || names.get(nameKey) === native, 'Changed native case for '+id);
    required(!numbers.has(numberKey) || numbers.get(numberKey) === id, 'Existing native case cannot be renamed: '+native);
    names.set(nameKey,native); numbers.set(numberKey,id);
  }
  for (const {permit:p} of state.permits) register(p.caseId,p.receiptCase,p.suite || 'default');
  for (const pkg of packages) for (const id of pkg.caseIds) register(id,nativeCase(pkg,id),pkg.suite || 'default');
}
function validatePackage(pkg, criteria) {
  if (pkg.testKind !== 'formal') return;
  for (const key of ['acceptanceIds','caseIds']) required(Array.isArray(pkg[key]) && pkg[key].length && pkg[key].every(string),
    'Formal work package '+pkg.id+' requires '+key);
  required(new Set(pkg.caseIds).size === pkg.caseIds.length, 'Duplicate case ID in formal package');
  if (pkg.caseMap !== undefined) {
    for (const id of pkg.caseIds) nativeCase(pkg,id);
    required(Object.keys(pkg.caseMap).length === pkg.caseIds.length, 'Unexpected cases in native case mapping');
  }
  if (pkg.suite !== undefined) required(string(pkg.suite),'Native suite must be a stable nonempty name');
  checkPreflight(pkg);
  required(pkg.acceptanceIds.every(id=>criteria.some(c=>c.id===id && c.status!=='EXCLUDED')), 'Formal package refers to an unknown or excluded criterion');
}
function loadState(run) {
  const file = path.join(run,'formal-cases.json');
  return fs.existsSync(file) ? read(file) : {permits:[]};
}
function dispatchCheck(run, snapshot, previous) {
  require('./worker-ownership.cjs').check(run,snapshot,previous);
  const current = snapshot.packages.inFlight.filter(p => p.testKind === 'formal');
  if (!current.length) return;
  for (const pkg of current) validatePackage(pkg,snapshot.acceptance?.items || []);
  checkMappings(current,loadState(run));
}
function readHistory(run) {
  return fs.readFileSync(path.join(run,'acceptance-history.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
function main(command, run, inputFile, output) {
  required(path.isAbsolute(run) && path.isAbsolute(inputFile), 'Use absolute run and input paths');
  const input=read(inputFile), lock=path.join(run,'dispatch-write.lock');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
  try {
    const binding=read(path.join(run,'binding.json')), file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
    const snapshot=read(file), progress=snapshot.acceptance;
    audit.summarize(run,progress);
    required(progress?.items,'An existing acceptance table is required');
    const stateFile=path.join(run,'formal-cases.json'), state=loadState(run), rows=readHistory(run);
    const entry=state.permits.find(r=>r.permit.id===input.id);
    if (command==='select') {
      const pkg = snapshot.packages.inFlight.find(p=>p.id===input.workPackage && p.testKind==='formal');
      required(pkg && input.revision===progress.revision,'Select an in-flight formal package at its current revision');
      validatePackage(pkg, progress.items);
      checkMappings([pkg], state);
      const allowed=[], held=[], stopped=rework.held(rows,pkg.acceptanceIds).length>0;
      for (const caseId of pkg.caseIds) {
        const awaiting=state.permits.some(r=>!r.finished && r.permit.caseId===caseId);
        const heldFor=awaiting?'awaitingReceipt':stopped?'research':null;
        const record={caseId,receiptCase:nativeCase(pkg,caseId)};
        if (heldFor) held.push({...record,reason:heldFor}); else allowed.push(record);
      }
      return {allowed,held};
    }
    if (command==='reserve') {
      required(output && path.isAbsolute(output),'Provide an absolute permit output path');
      required(input.purpose==='formal' && ['id','workPackage','criterionId','caseId','revision'].every(k=>string(input[k])), 'Formal request needs attempt, package, criterion, case and revision IDs');
      required(input.revision===progress.revision,'Candidate revision has changed');
      const pkg=snapshot.packages.inFlight.find(p=>p.id===input.workPackage);
      required(pkg?.testKind==='formal' && pkg.acceptanceIds?.includes(input.criterionId) && pkg.caseIds?.includes(input.caseId),'Register the in-flight formal package with its criterion and case first');
      validatePackage(pkg,progress.items);
      checkMappings([pkg],state);
      const receiptCase = nativeCase(pkg,input.caseId);
      required(input.receiptCase === undefined || input.receiptCase===receiptCase, 'Requested native case differs from registered mapping');
      required(input.preflight === undefined || isDeepStrictEqual(pkg.preflight,input.preflight), 'Preflight differs from the one registered with dispatch');
      if (entry) required(!entry.finished && receiptCase===entry.permit.receiptCase &&
        ['workPackage','criterionId','caseId','revision','purpose'].every(k=>input[k]===entry.permit[k]),'Attempt ID already used');
      required(!rows.some(r=>r.kind==='attempt' && r.id===input.id),'Attempt ID already recorded');
      required(!state.permits.some(r=>!r.finished && r!==entry && sameCase(r.permit,input)), 'A previous launch for this case is awaiting its receipt');
      eligible(rows,input.criterionId);
      const permit=entry?.permit || {id:input.id,workPackage:input.workPackage,criterionId:input.criterionId,caseId:input.caseId,
        revision:input.revision,receiptCase,suite:pkg.suite||'default',purpose:'formal',nonce:crypto.randomUUID(),runId:binding.executorId,
        ...(pkg.target?{target:pkg.target,preflight:pkg.preflight}:{})};
      if (fs.existsSync(output)) required(isDeepStrictEqual(read(output),permit),'Permit output already belongs to another attempt');
      if (!entry) { state.permits.push({permit}); write(stateFile,state); }
      if (!fs.existsSync(output)) preserve(output,permit);
      return {issued:permit.id};
    }
    required(command==='finish' && output && path.isAbsolute(output),'Expected select, reserve or finish RUN PERMIT RECEIPT（研究登記改用 rework.cjs research）');
    required(entry && entry.permit.nonce===input.nonce,'Unknown formal permit');
    const p=entry.permit, receipt=read(output), result=receipt.result;
    required(receipt.id===p.id && receipt.nonce===p.nonce && receipt.caseId===p.caseId && receipt.revision===p.revision &&
      result && String(result.case)===p.receiptCase,'Receipt does not match its issued case, candidate and attempt');
    const stop=contract.exactTime(result.stop), start=contract.exactTime(result.start);
    required(start!==null && stop!==null && stop>=start && contract.notLater(stop),'Receipt needs valid actual start and finish times');
    const native=result.status;
    required(['PASS','FAIL','STOPPED','BLOCKED','INCONCLUSIVE'].includes(native),'Unknown native case outcome');
    const outcome=result.interrupted || result.cleanupOk===false || native==='STOPPED' ? 'BLOCKED' : native;
    const hash=crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
    if (entry.finished) {required(entry.finished===hash,'Conflicting receipt for completed attempt');return {duplicate:true,id:p.id};}
    const directory=path.join(run,'formal-receipts');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const evidence=path.join(directory,p.nonce+'.json');
    preserve(evidence,receipt);
    const attempt={id:p.id,caseId:p.caseId,revision:p.revision,outcome,reason:String(result.error||native),evidence:[evidence],startedAt:result.start,finishedAt:result.stop};
    const item=progress.items.find(x=>x.id===p.criterionId);
    required(item,'Criterion no longer exists');
    // The runner reports one attempt. The criterion status and its independent verdict belong to the mainline.
    const prior=rows.find(r=>r.kind==='attempt' && r.id===p.id && r.criterionId===p.criterionId);
    if (prior) attempt.evidence=prior.evidence;
    const previousAttempt=item.lastAttempt;
    item.lastAttempt=attempt;
    audit.validate(progress,contract.effective(run,binding));
    audit.record(run,progress,file);
    if(previousAttempt && Date.parse(previousAttempt.finishedAt)>stop) item.lastAttempt=previousAttempt;
    write(file,snapshot);
    rework.formalFailure(run,p,attempt);
    entry.finished=hash;entry.evidence=attempt.evidence[0];write(stateFile,state);
    return {recorded:p.id,outcome};
  } finally {fs.unlinkSync(lock);}
}
function preserve(file,value) {
  const temp=file+'.tmp-'+crypto.randomUUID();
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  try {
    try {fs.linkSync(temp,file);}
    catch (error) {if (error.code!=='EEXIST') throw error; required(isDeepStrictEqual(read(file),value),'Conflicting existing file: '+file);}
  } finally {fs.unlinkSync(temp);}
}
async function runTransport(args) {
  const [run,request,permit,receipt,separator,command,...argv]=args;
  required(separator==='--' && command && [run,request,permit,receipt].every(v=>string(v)&&path.isAbsolute(v)),
    'Usage: run RUN REQUEST PERMIT RECEIPT -- COMMAND [ARGS...]');
  required(new Set([request,permit,receipt].map(v=>path.resolve(v))).size===3,'Request, permit and receipt must have distinct paths');
  if (fs.existsSync(receipt)) {
    const p=read(permit),q=read(request);
    required(['id','workPackage','criterionId','caseId','revision','purpose'].every(k=>q[k]===p[k]) &&
      (q.receiptCase===undefined || q.receiptCase===p.receiptCase),'Existing receipt belongs to another request');
    return main('finish',run,permit,receipt);
  }
  main('reserve',run,request,permit);
  const child=spawn(command,argv,{stdio:'inherit',env:{...process.env,LT_FORMAL_PERMIT:permit,LT_FORMAL_RECEIPT:receipt}});
  const result=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  // The transport owns its authorized time window. A signal or failed transfer leaves the same permit outstanding.
  process.exitCode=result.code ?? (128+(require('node:os').constants.signals[result.signal]||0));
  required(fs.existsSync(receipt),'No per-case receipt returned; reconcile the same attempt before retrying this case');
  return main('finish',run,permit,receipt);
}
module.exports={eligible,loadState,validatePackage,dispatchCheck};
if (require.main===module) {
  const [command,...args]=process.argv.slice(2);
  Promise.resolve().then(()=>command==='run'?runTransport(args):main(command,...args))
    .then(value=>console.log(JSON.stringify(value)))
    .catch(error=>{console.error(error.message);process.exitCode=process.exitCode||1;});
}
