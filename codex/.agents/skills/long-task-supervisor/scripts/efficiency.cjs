#!/usr/bin/env node
// Efficiency expectations of acceptance criteria that include real runs (Jay 2026-11-27 decisions 46-48). Before, the
// criteria said only what a result must be, and how fast it came was left to the supervisor on the spot: on workspace E
// PDS26020017 went from 14.0 minutes (11/25) to 120.1 minutes unfinished, while the package baselines were rewritten from
// the run's own time (22.2 to 224.4 minutes) and the bridge limit was raised from 7,200 to 22,200 seconds, so the slowness
// never counted. The supervisor writes each criterion's expectation when the case opens, from the previous version's
// same case, production, the requirement documents or Jay's words, and proxies one with its basis when none exists. It is
// the supervisor's plan beside the locked contract, like the segment table; raising or removing one needs Jay's words.
// A real run is an attempt row in acceptance-history.jsonl. One that took longer than its case's expectation cannot pass,
// and a run that failed, too slow or unfinished, counts once per criterion and candidate revision toward the rework count
// (rework.cjs); the supervisor cannot accept the criterion while the latest run of a case is too slow or missing.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const contract=require('./contract-state.cjs');
const FILE='efficiency.json',HISTORY='acceptance-history.jsonl';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim().length>0;
const positive=value=>Number.isFinite(value)&&value>0;
const round=minutes=>Math.round(minutes*10)/10;
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function load(run){
  const file=path.join(run,FILE);
  return fs.existsSync(file)?readJson(file):{criteria:{},log:[]};
}
const expectations=run=>load(run).criteria;
// A case's own limit, else the criterion's.
const limitOf=(expectation,caseId)=>expectation.cases?.[caseId]??expectation.maxMinutes;
function validate(criteria,known){
  need(criteria&&typeof criteria==='object'&&!Array.isArray(criteria),'criteria 要是 {"條文 ID":{"maxMinutes":分鐘,"basis":"參考值與出處","cases":{"案例 ID":分鐘}}}');
  const out={};
  for(const [id,item] of Object.entries(criteria)){
    need(known.has(id),'效率預期列了有效契約裡沒有的條文：'+id);
    need(item&&positive(item.maxMinutes),id+' 的 maxMinutes 要是正數（每個案例實跑的上限分鐘）');
    need(text(item.basis),id+' 要寫 basis：參考值與出處（前版同案例實測、正式站實測、需求文件或 Jay 原話；都沒有時寫監督代決的依據）');
    if(item.cases!==undefined)need(item.cases&&typeof item.cases==='object'&&!Array.isArray(item.cases)&&Object.entries(item.cases).every(([k,v])=>text(k)&&positive(v)),id+' 的 cases 要是 {"案例 ID":上限分鐘}');
    out[id]={maxMinutes:item.maxMinutes,basis:item.basis.trim(),...(item.cases?{cases:{...item.cases}}:{})};
  }
  return out;
}
// Raising a limit or dropping an expectation lets slower runs pass: only Jay's words do that.
function loosened(before,after){
  if(!before)return false;
  if(!after)return true;
  const cases=new Set([...Object.keys(before.cases||{}),...Object.keys(after.cases||{})]);
  return after.maxMinutes>before.maxMinutes||[...cases].some(id=>limitOf(after,id)>limitOf(before,id));
}
function write(run,binding,input,known){
  const current=load(run),set=validate(input?.criteria||{},known),remove=input?.remove||[];
  need(Array.isArray(remove)&&remove.every(text),'remove 要是條文 ID 陣列');
  need(Object.keys(set).length||remove.length,'沒有要寫入或移除的效率預期');
  const next={...current.criteria,...set};
  for(const id of remove)delete next[id];
  const looser=[...new Set([...Object.keys(set),...remove])].filter(id=>loosened(current.criteria[id],next[id]));
  const authority=input?.authority;
  if(looser.length){
    need(authority?.role==='user'&&text(authority.quote)&&text(authority.locator)&&contract.notLater(contract.exactTime(authority.at)),
      '放寬或移除效率預期（'+looser.join('、')+'）要附 Jay 的原話：authority:{role:"user",quote,locator,at,source:{path,sha256}}，格式同契約修訂。做不到效率預期時照現有機制判不合格，第 6 次研究後由 Jay 裁決');
    contract.userSource(authority.source,authority.quote,binding.allowedRoots);
  }
  const entry={at:new Date().toISOString(),set:Object.keys(set),removed:remove,...(looser.length?{loosened:looser,authority}:{})};
  const file=path.join(run,FILE),value={schemaVersion:1,updatedAt:entry.at,criteria:next,log:[...(current.log||[]),entry]};
  fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return {recorded:true,file,criteria:Object.keys(next),...(looser.length?{loosened:looser}:{})};
}
const minutesOf=row=>(Date.parse(row.finishedAt)-Date.parse(row.startedAt))/60000;
// The verdict a new attempt adds, or null. A run over its limit cannot be recorded as PASS; a FAIL, too slow or
// unfinished (decision 47), counts once per criterion and revision, and not again when the same attempt already counted
// as a formal run. BLOCKED and INCONCLUSIVE say nothing about the work, as for formal runs.
function judge(criteria,row,history,at=new Date().toISOString()){
  const expectation=criteria[row.criterionId];
  if(!expectation)return null;
  const minutes=minutesOf(row),limit=limitOf(expectation,row.caseId),slow=minutes>limit;
  const where=row.criterionId+' 的案例 '+row.caseId+' 實跑 '+round(minutes)+' 分'+(slow?'，超過效率預期 '+limit+' 分（'+expectation.basis+'）':'，沒有完成：'+row.reason);
  need(!slow||row.outcome!=='PASS',where+'：這次不能記 PASS，改記 FAIL（程式會計入這條的不合格次數）');
  if(row.outcome!=='FAIL')return null;
  if(history.some(r=>r.kind==='verdict'&&(r.attemptId===row.id||r.source==='efficiency'&&r.criterionId===row.criterionId&&r.revision===row.revision)))return null;
  return {kind:'verdict',criterionId:row.criterionId,outcome:'FAIL',source:'efficiency',attemptId:row.id,caseId:row.caseId,revision:row.revision,
    ...(row.packageId?{packageId:row.packageId}:{}),minutes:round(minutes),limit,reason:where,at};
}
// Whether a criterion with an expectation may pass: every case named in it, and every case run so far, has a latest run
// that passed within its limit. Returns the problems, empty when it may pass.
function blockers(criteria,history,criterionId){
  const expectation=criteria[criterionId];
  if(!expectation)return [];
  const latest=new Map();
  for(const row of history)if(row.kind==='attempt'&&row.criterionId===criterionId&&!(Date.parse(latest.get(row.caseId)?.finishedAt)>Date.parse(row.finishedAt)))latest.set(row.caseId,row);
  const cases=new Set([...Object.keys(expectation.cases||{}),...latest.keys()]);
  if(!cases.size)return [criterionId+' 有效率預期，但還沒有任何實跑紀錄：請執行主線用 efficiency.cjs run 登記每個案例的實跑'];
  const out=[];
  for(const caseId of cases){
    const row=latest.get(caseId),limit=limitOf(expectation,caseId);
    if(!row)out.push(criterionId+' 的案例 '+caseId+' 沒有實跑紀錄');
    else if(row.outcome!=='PASS'||minutesOf(row)>limit)out.push(criterionId+' 的案例 '+caseId+' 最近一次實跑 '+row.outcome+'、'+round(minutesOf(row))+' 分（效率預期 '+limit+' 分）');
  }
  return out;
}
function history(run){
  const file=path.join(run,HISTORY);
  return fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];
}
// A real run the mainline records directly (a run outside formal-case.cjs and outside the snapshot's lastAttempt).
function recordRun(run,binding,input){
  require('./rework.cjs').mainlineOnly('登記實跑');
  const known=new Set(contract.effective(run,binding).criteria.map(item=>item.id));
  need(input&&known.has(input.criterionId),'criterionId 要是現行契約的驗收條文');
  for(const key of ['caseId','revision','reason'])need(text(input[key]),key+' 必填（reason 寫這次結果，例如「讀完」或「7 份未讀完」）');
  need(['PASS','FAIL','BLOCKED','INCONCLUSIVE'].includes(input.outcome),'outcome 是 PASS、FAIL、BLOCKED 或 INCONCLUSIVE（沒讀完記 FAIL）');
  need(Array.isArray(input.evidence)&&input.evidence.length&&input.evidence.every(text),'evidence 要列至少一個證據檔');
  const started=contract.exactTime(input.startedAt),finished=contract.exactTime(input.finishedAt);
  need(started!==null&&contract.notLater(finished)&&finished>=started,'startedAt、finishedAt 要是實際開始與結束時間（含日期、時間與時區，不晚於現在）');
  const row={kind:'attempt',criterionId:input.criterionId,id:text(input.id)?input.id:input.caseId+'@'+input.startedAt,caseId:input.caseId,revision:input.revision,
    outcome:input.outcome,reason:input.reason,evidence:input.evidence,startedAt:input.startedAt,finishedAt:input.finishedAt,...(text(input.packageId)?{packageId:input.packageId}:{})};
  const rows=history(run),prior=rows.find(r=>r.kind==='attempt'&&r.criterionId===row.criterionId&&r.id===row.id);
  if(prior){need(JSON.stringify(prior)===JSON.stringify(row),'這筆實跑已登記過、內容不同：'+row.id);return {recorded:row.id,duplicate:true};}
  const verdict=judge(expectations(run),row,rows);
  fs.appendFileSync(path.join(run,HISTORY),[row,...(verdict?[verdict]:[])].map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {recorded:row.id,minutes:round(minutesOf(row)),...(verdict?{counted:verdict.reason}:{})};
}
// A real-run package's baseline is the expectation of its cases (decision 48), so a slow run is late by its expectation.
function baseline(run,criterionId,caseIds){
  const expectation=expectations(run)[criterionId];
  need(expectation,criterionId+' 沒有效率預期，先由監督用 supervise.cjs efficiency 寫入');
  need(caseIds.length,'--cases 要列本包要跑的案例 ID（逗號分隔）');
  const minutes=caseIds.reduce((sum,id)=>sum+limitOf(expectation,id),0);
  return {minutes,basis:'效率預期 '+criterionId+'：'+caseIds.map(id=>id+' '+limitOf(expectation,id)+' 分').join('＋')+'（'+expectation.basis+'）',startedAt:new Date().toISOString()};
}
// A package that runs real cases of a criterion with an expectation takes that expectation as its baseline, not its own
// measured time (decision 48). Agent work keeps the model-speed baseline (it names a model).
function dispatchCheck(run,snapshot,previous){
  const criteria=expectations(run);
  if(!Object.keys(criteria).length)return;
  const old=new Map((previous?.packages?.inFlight||[]).map(item=>[item.id,item]));
  for(const item of snapshot.packages?.inFlight||[]){
    const b=item.baseline;
    if(!b||b.model||JSON.stringify(b)===JSON.stringify(old.get(item.id)?.baseline))continue;
    const named=(item.acceptanceIds||[]).filter(id=>criteria[id]);
    need(!named.length||String(b.basis||'').startsWith('效率預期 '),item.id+' 跑的是有效率預期的條文 '+named.join('、')+'：時程基準改用效率預期，用 efficiency.cjs baseline RUN --criterion '+named[0]+' --cases <案例 ID,…> 產生，不用本場實測時長');
  }
}
module.exports={FILE,load,expectations,limitOf,validate,write,judge,blockers,recordRun,baseline,dispatchCheck};
if(require.main===module){
  const [command,run,...rest]=process.argv.slice(2);
  const option=name=>{const at=rest.indexOf('--'+name);return at>=0?rest[at+1]:undefined;};
  try{
    need(['run','baseline','show'].includes(command)&&path.isAbsolute(run||''),'Usage: efficiency.cjs run ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | baseline ABSOLUTE_RUN --criterion ID --cases A,B | show ABSOLUTE_RUN（寫入效率預期用 supervise.cjs efficiency）');
    const binding=readJson(path.join(run,'binding.json'));
    const result=command==='show'?load(run):command==='baseline'?baseline(run,option('criterion'),String(option('cases')||'').split(',').filter(Boolean))
      :(need(path.isAbsolute(rest[0]||''),'run 要給輸入 JSON 的絕對路徑'),recordRun(run,binding,readJson(rest[0])));
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
