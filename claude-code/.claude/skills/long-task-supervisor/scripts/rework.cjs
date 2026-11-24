#!/usr/bin/env node
// Unsuccessful deliveries counted per acceptance criterion (Jay 2026-11-23「接受你的固化方法」). The model judges
// each delivery; this file keeps the count, holds the criterion at the second failure and resets it when research
// (or a reason research is not needed) is registered. Before it the count lived in a hand-kept header column on a
// package that is renamed for every retry: of 2,792 live packages the 65 that carried the column all read 0, and
// workspace E's criterion I04 failed ten times in 21 hours without research. A supervisor's "not passed this time"
// counts toward the same criterion (Jay 2026-11-23 23:03). Rows live in acceptance-history.jsonl next to the
// criterion statuses; the readers there skip kinds they do not know.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const contract=require('./contract-state.cjs');
const HISTORY='acceptance-history.jsonl';
const LIMIT=2;
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim().length>0;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function rows(run){
  const file=path.join(run,HISTORY);
  return fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];
}
function append(run,list){if(list.length)fs.appendFileSync(path.join(run,HISTORY),list.map(row=>JSON.stringify(row)).join('\n')+'\n');}
// Per criterion: the failures since the last reset, every reset (a cycle) and every failure ever recorded.
function tally(history){
  const map=new Map(),get=id=>map.get(id)||map.set(id,{failures:[],resets:[],all:[]}).get(id);
  for(const row of history){
    if(row.kind==='verdict'&&row.outcome==='FAIL'){const t=get(row.criterionId);t.failures.push(row);t.all.push(row);}
    else if(row.kind==='reset'){const t=get(row.criterionId);t.resets.push(row);t.failures=[];}
  }
  return map;
}
const held=(history,ids=[])=>{const t=tally(history);return [...new Set(ids)].filter(id=>(t.get(id)?.failures.length||0)>=LIMIT);};
function status(run){
  return [...tally(rows(run))].map(([criterionId,t])=>({criterionId,failures:t.failures.length,held:t.failures.length>=LIMIT,cycles:t.resets.length,
    totalFailures:t.all.length,current:t.failures.map(f=>({source:f.source,packageId:f.packageId||null,reason:f.reason,at:f.at}))}));
}
// Who is calling: a Codex subagent's shell carries its own thread ID and the top conversation's session ID; in the
// mainline both are the same (codex-rs shell_environment.rs, seen on workspace E's e2049 and wp_relprep_sql). Eight
// subagents took themselves for the mainline after compaction (2026-11-21..22) and four wrote dispatch state, one
// collecting its own package after revoking a production credential; a prompt line saying "you are a subagent" was
// present in four of the five workspace E cases.
function caller(env=process.env){
  const thread=env.CODEX_THREAD_ID||env.CLAUDE_SESSION_ID||null,session=env.CODEX_SESSION_ID||null;
  return {thread,session,subagent:Boolean(env.CODEX_THREAD_ID&&env.CODEX_SESSION_ID&&env.CODEX_THREAD_ID!==env.CODEX_SESSION_ID)};
}
function mainlineOnly(action){
  need(!caller().subagent,'子代理不能'+action+'：把成果與證據交回執行主線，由主線收件與登記（本對話 '+process.env.CODEX_THREAD_ID+' 是子代理，最上層對話是 '+process.env.CODEX_SESSION_ID+'）');
}
// The criteria an unsuccessful delivery counts against: named in the verdict, or the package's acceptance tags.
function criteriaFor(run,binding,named,fallback,where){
  const ids=Array.isArray(named)&&named.length?named:fallback||[];
  const active=new Set(contract.effective(run,binding).criteria.map(item=>item.id));
  need(ids.length&&ids.every(id=>active.has(id)),where+'：品質不合格要對到現行契約的驗收條文。在判定寫 "criteria":["條文 ID"]，或在工作包加 [驗收條目]；現行條文有 '+[...active].join('、'));
  return [...new Set(ids)];
}
// 收件判定 (Jay 2026-11-23): a delivery taken back is one of three — adopt, a quality failure of the delivery, or
// not the deliverer's fault (tool, model route, permission, source, timeout, changed requirement).
const VERDICTS={adopt:'採用',fail:'品質不合格',external:'非子代理責任'};
function verdictRows(run,binding,{id,verdict,before,tagIds,handle,at=new Date().toISOString()}){
  const where='收件 '+id;
  need(verdict&&Object.hasOwn(VERDICTS,verdict.kind),where+'：收回交付要在結果檔寫 "verdict":{"kind":"adopt|fail|external",...}，三選一：'+
    Object.entries(VERDICTS).map(([k,v])=>k+'＝'+v).join('、')+'。fail 與 external 要寫 reason');
  if(verdict.kind==='adopt')return [];
  need(text(verdict.reason),where+'：'+VERDICTS[verdict.kind]+'要寫 reason（fail 寫具體指正，external 寫是哪個外部原因）');
  if(verdict.kind==='external')return [];
  // A failed formal attempt of this package already counted itself (formalFailure); judging the same delivery
  // again does not count the one failure twice.
  const counted=new Set(rows(run).filter(r=>r.kind==='verdict'&&r.source==='formal'&&r.packageId===id).map(r=>r.criterionId));
  return criteriaFor(run,binding,verdict.criteria,before.acceptanceIds||tagIds,where).filter(criterionId=>!counted.has(criterionId)).map(criterionId=>({kind:'verdict',criterionId,outcome:'FAIL',source:'executor',
    packageId:id,handle:handle||null,reason:verdict.reason.trim(),at}));
}
// A formal run on the scarce machine that reports FAIL is a measured failure of its criterion, whoever ran it; the
// mainline running the case itself has no delivery to judge. INCONCLUSIVE and BLOCKED say nothing about the work.
function formalFailure(run,permit,attempt,at=new Date().toISOString()){
  if(attempt.outcome!=='FAIL')return;
  if(rows(run).some(r=>r.kind==='verdict'&&r.source==='formal'&&r.attemptId===permit.id))return;
  append(run,[{kind:'verdict',criterionId:permit.criterionId,outcome:'FAIL',source:'formal',packageId:permit.workPackage,attemptId:permit.id,reason:attempt.reason,at}]);
}
const entries=snapshot=>Object.entries(snapshot?.packages||{}).flatMap(([list,items])=>(Array.isArray(items)?items:[]).map(item=>({list,item})));
// The submission a ruling answers covers every criterion of every submitted package, each one of three: accepted
// (採認), failed (這次未過) or remaining (還沒做完). A reject names at least one failed criterion of the current
// contract (Jay 2026-11-24, 代決原則: what the criteria already require is returned against its ID).
function scope(run,binding,event,decision){
  if(event.kind!=='submission'||!['reply','reject'].includes(decision.disposition))return;
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  const scoped=fs.existsSync(file)?entries(read(file)).filter(({item})=>item.submission?.revision===event.revision&&item.submission.manifest===event.manifest):[];
  const supplied=decision.packageRulings||[];
  const ids=scoped.map(({item})=>item.id);
  need(scoped.length||decision.disposition!=='reject','這一版沒有工作包登記，無法逐條退件：請執行端用 candidate.cjs 重送（送審指令會一併登記工作包）；這筆用 observe 記為等待重送');
  need(scoped.length===supplied.length&&scoped.every(({item})=>supplied.some(r=>r.id===item.id)),
    '逐包裁決要和這次送審登記的工作包一一對應。這一版登記在：'+(ids.join('、')||'（沒有工作包登記這一版）')+
    '；裁決附了：'+(supplied.map(r=>r.id).join('、')||'（沒附）')+'。每個登記的工作包附一筆 {id,accepted,failed,remaining}，不多不少');
  for(const {item} of scoped){
    const row=supplied.find(r=>r.id===item.id),named=new Set([...row.accepted,...(row.failed||[]),...row.remaining]);
    const missing=(item.acceptanceIds||[]).filter(id=>!named.has(id));
    need(!missing.length,item.id+' 的驗收條文要逐條分到採認、這次未過或還沒做完：還沒分的有 '+missing.join('、'));
  }
  if(decision.disposition==='reject')need(supplied.some(r=>(r.failed||[]).length),'退件要指出這次未過的驗收條文：在逐包裁決的 failed 列出條文 ID');
}
function rulingRows(event,decision,at=new Date().toISOString()){
  if(event.kind!=='submission'||!['reply','reject'].includes(decision.disposition))return [];
  return (decision.packageRulings||[]).flatMap(r=>(r.failed||[]).map(criterionId=>({kind:'verdict',criterionId,outcome:'FAIL',source:'supervisor',
    packageId:r.id,eventId:event.id,revision:event.revision||null,reason:String(decision.reply||'').slice(0,500),at})));
}
function recordRuling(run,event,decision){
  const known=new Set(rows(run).filter(r=>r.kind==='verdict'&&r.source==='supervisor').map(r=>r.eventId+'\0'+r.criterionId));
  append(run,rulingRows(event,decision).filter(r=>!known.has(r.eventId+'\0'+r.criterionId)));
}
// The gate: a package entering work (new, or under a new handle) or a new submission on a held criterion waits for
// research. The research package itself does not list that criterion, so it is never held.
function dispatchCheck(run,snapshot,previous){
  const history=rows(run);
  if(!history.some(r=>r.kind==='verdict'))return;
  const old=new Map(entries(previous).map(({list,item})=>[item.id,{list,item}]));
  for(const {list,item} of entries(snapshot)){
    const prior=old.get(item.id);
    const entering=list==='inFlight'&&!(prior?.list==='inFlight'&&prior.item.handle===item.handle);
    const submitting=item.submission&&JSON.stringify(item.submission)!==JSON.stringify(prior?.item.submission);
    if(!entering&&!submitting)continue;
    const stop=held(history,item.acceptanceIds);
    need(!stop.length,'驗收條文 '+stop.join('、')+' 已累計 '+LIMIT+' 次不合格，'+item.id+(submitting?' 先不送審':' 先不派')+
      '：另派研究子代理（研究工作包不列這條驗收條目），研究交回後用 rework.cjs research 登記；確定不需研究時用 rework.cjs waive 登記理由。登記後計數歸零，再派或送審');
  }
}
function registered(run,binding,id){
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  return fs.existsSync(file)&&entries(read(file)).some(({item})=>item.id===id);
}
// 關卡二 (Jay 2026-11-23): research lists the direct cause of each failure and their common upstream cause, besides
// the four outputs of 2026-11-19 (failure evidence, excluded causes, dated outside sources, a passing experiment).
function reset(run,binding,mode,input,at=new Date().toISOString()){
  mainlineOnly('登記研究或歸零');
  const history=rows(run),t=tally(history).get(input?.criterionId);
  need(text(input?.criterionId)&&t&&t.failures.length>=LIMIT,'只有累計 '+LIMIT+' 次不合格的驗收條文能登記：'+(input?.criterionId||'（沒寫 criterionId）')+' 目前 '+(t?.failures.length||0)+' 次');
  const causes=input.directCauses;
  need(Array.isArray(causes)&&causes.length>=t.failures.length&&causes.every(text),'directCauses 要逐次列出這 '+t.failures.length+' 次不合格的直接原因（每次一句）');
  const row={kind:'reset',criterionId:input.criterionId,mode,cycle:t.resets.length+1,failures:t.failures.map(f=>({source:f.source,packageId:f.packageId||null,at:f.at})),
    directCauses:causes.map(c=>c.trim()),at};
  if(mode==='research'){
    need(text(input.commonCause),'commonCause 要寫各次失敗共同的上游原因');
    need(['excluded','solution','workPackage','experiment'].every(k=>text(input[k]))&&input.experimentPassed===true&&fs.statSync(input.experiment,{throwIfNoEntry:false})?.isFile()&&
      Array.isArray(input.sources)&&input.sources.length&&input.sources.every(x=>/^https?:\/\//.test(x?.url)&&contract.exactTime(x.checkedAt)!==null),
      '研究登記要有：excluded（已排除原因）、sources（外部網址＋含時區的查閱時間）、experiment（通過的小實驗證據檔）與 experimentPassed:true、solution（採用的解法）、workPackage（交回原子代理的工作包）');
    need(registered(run,binding,input.workPackage),'workPackage '+input.workPackage+' 還沒登記在派工表');
    Object.assign(row,{commonCause:input.commonCause.trim(),excluded:input.excluded,sources:input.sources,experiment:input.experiment,solution:input.solution,workPackage:input.workPackage});
  }else{
    need(text(input.reason),'不需研究要寫 reason：為什麼這兩次不合格不必上網研究（例：補做實測就能佐證）');
    row.reason=input.reason.trim();
    if(text(input.commonCause))row.commonCause=input.commonCause.trim();
  }
  append(run,[row]);
  return {registered:row.criterionId,mode,cycle:row.cycle,alert:row.cycle%2===0};
}
// Every second reset of one criterion (four failures and two studies, then every two cycles more) tells Jay through
// Veda (Jay 2026-11-23「循環兩次後，請Veda通知我」; 2026-11-24: like an important mail, at once and in every summary
// until he answers). The alert is a pending item, so Veda's read-only summary lists it and Jay's answer closes it.
const keyOf=(id,cycle)=>{const slug=String(id).replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,32);
  return 'rework-'+(slug===id?slug:slug+'-'+crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,6))+'-c'+cycle;};
function alerts(run,binding){
  const t=tally(rows(run)),out=[];
  let criteria=[];try{criteria=contract.effective(run,binding).criteria;}catch{}
  for(const [criterionId,item] of t){
    for(const r of item.resets.filter(r=>r.cycle%2===0)){
      const pair=item.resets.filter(x=>x.cycle===r.cycle-1||x.cycle===r.cycle);
      const total=item.all.filter(f=>Date.parse(f.at)<=Date.parse(r.at)).length;
      out.push({key:keyOf(criterionId,r.cycle),criterionId,cycle:r.cycle,at:r.at,total,requirement:criteria.find(c=>c.id===criterionId)?.requirement||null,
        causes:pair.flatMap(x=>x.directCauses||[]),common:pair.map(x=>x.commonCause).filter(Boolean),studies:pair.map(x=>x.mode==='research'?x.solution:'不需研究：'+x.reason)});
    }
  }
  return out;
}
function describe(alert,title){
  return ['任務：'+(title||'（監督對話）'),'驗收條文：'+alert.criterionId+(alert.requirement?'（'+alert.requirement+'）':''),
    '累計不合格 '+alert.total+' 次，已循環 '+alert.cycle+' 次（每次循環＝兩次不合格後研究一次）。',
    '各次直接原因：'+alert.causes.join('；'),'共同上游原因：'+(alert.common.join('；')||'（未寫）'),'最近兩次研究結論：'+alert.studies.join('；')].join('\n');
}
// Raised by the supervisor's watcher, which runs as the supervisor (contract-state supervisorOnly).
function raiseAlerts(run,binding,{title}={}){
  const pending=require('./pending-decisions.cjs'),ledger=pending.load(run),known=new Set(ledger.items.map(item=>item.key));
  const fresh=alerts(run,binding).filter(a=>!known.has(a.key));
  if(!fresh.length)return [];
  pending.apply(run,{raise:fresh.map(a=>({key:a.key,kind:'rework_cycle',ask:'同一驗收條文 '+a.criterionId+' 已循環 '+a.cycle+' 次仍未通過。\n'+describe(a,title),
    recommend:'執行端照常繼續循環；你看過後回覆一句即可，有方向要調整就直接說',why:'Jay 2026-11-23 定案：同一條文循環兩次（之後每再兩次）通知你；執行不等回覆',options:['知道了，照常繼續','我要調整方向（請寫明）']}))},{binding});
  return fresh.map(a=>a.key);
}
// Which open cycle items go to Veda now: each once (the sent mark is 'veda-'+key), none from 00:00 to 08:00 Taipei so a
// night alert waits for the morning; the open item stays in Veda's summaries either way.
function vedaDue(items,{sent,now=Date.now()}){
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hourCycle:'h23'}).format(new Date(now)));
  if(hour<8)return [];
  return items.filter(item=>item.kind==='rework_cycle'&&item.status==='open'&&!sent('veda-'+item.key));
}
module.exports={LIMIT,rows,tally,held,status,caller,mainlineOnly,verdictRows,formalFailure,scope,rulingRows,recordRuling,dispatchCheck,reset,alerts,describe,raiseAlerts,keyOf,vedaDue};
if(require.main===module){
  const [command,run,inputFile]=process.argv.slice(2);
  try{
    need(['status','research','waive'].includes(command)&&path.isAbsolute(run||'')&&(command==='status'||path.isAbsolute(inputFile||'')),
      'Usage: rework.cjs status ABSOLUTE_RUN | research ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | waive ABSOLUTE_RUN ABSOLUTE_INPUT_JSON');
    const binding=read(path.join(run,'binding.json'));
    console.log(JSON.stringify(command==='status'?status(run):reset(run,binding,command==='research'?'research':'waived',read(inputFile)),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
