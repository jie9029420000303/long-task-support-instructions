#!/usr/bin/env node
// Unsuccessful deliveries counted per acceptance criterion (Jay 2026-11-23「接受你的固化方法」). The model judges
// each delivery; this file keeps the count and holds the criterion where the cycle needs a step first (Jay 2026-11-26
// decision 33): the count never resets; at the 2nd and the 4th failure the criterion waits for research (or the
// supervisor's reason research is not needed, decision 49); at the 6th it waits for research and then for Jay's ruling, registered with resume, which
// starts a new count. Before it the count lived in a hand-kept header column on a
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
// The failures at which the criterion waits for research; the last one then waits for Jay.
const STUDY_AT=[2,4,6],JAY_AT=6,LIMIT=STUDY_AT[0];
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim().length>0;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
function rows(run){
  const file=path.join(run,HISTORY);
  return fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):[];
}
function append(run,list){if(list.length)fs.appendFileSync(path.join(run,HISTORY),list.map(row=>JSON.stringify(row)).join('\n')+'\n');}
// Per criterion: the failures since Jay's last ruling (resume), the studies registered since then, every resume and
// every failure ever recorded. A study counts for the failures before it; the count itself goes on.
function tally(history){
  const map=new Map(),get=id=>map.get(id)||map.set(id,{failures:[],resets:[],resumes:[],all:[]}).get(id);
  for(const row of history){
    if(row.kind==='verdict'&&row.outcome==='FAIL'){const t=get(row.criterionId);t.failures.push(row);t.all.push(row);}
    else if(row.kind==='reset'){const t=get(row.criterionId);t.resets.push({...row,after:t.failures.length});}
    else if(row.kind==='resume'){const t=get(row.criterionId);t.resumes.push(row);t.failures=[];t.resets=[];}
  }
  return map;
}
// Waiting for research: an even count from 2 with no study since its latest failure. Waiting for Jay: 6 or more.
const studied=t=>t.resets.some(r=>r.after===t.failures.length);
const waitsForStudy=t=>STUDY_AT.includes(t.failures.length)&&!studied(t)||t.failures.length>JAY_AT&&!studied(t);
const waitsForJay=t=>t.failures.length>=JAY_AT&&studied(t);
const held=(history,ids=[])=>{const t=tally(history);return [...new Set(ids)].filter(id=>{const item=t.get(id);return item&&(waitsForStudy(item)||waitsForJay(item));});};
// What the next delivery of a criterion is, by its count (model-route.cjs takes the same count as failures).
function nextStep(t){
  const n=t.failures.length;
  if(waitsForJay(t))return '研究已登記，等 Jay 裁決（監督在待決帳問他）；裁決後用 rework.cjs resume 登記他的原話';
  if(waitsForStudy(t))return '先派研究子代理（用執行主線當下的模型與推理；先上網搜尋 GitHub、技術論壇與所用語言或框架的外部文件找可行方案再分析，研究範圍含開發與測試驗收環境條件、使用的套件與軟體背景；只做唯讀查核，不做實作實驗；研究工作包不列這條），研究交回用 rework.cjs research 登記，researchAgent 寫研究子代理的代號';
  return ['照常派工',
    '交回剛交件的子代理，同模型同推理重做，附這次的具體指正',
    '研究已登記：開新的子代理，推理升兩檔（開源模型改派下一款開源），附研究選定的方案與前兩次的錯誤摘要；第一步先做驗證小實驗',
    '交回第 3 次做的子代理，同模型同推理重做，附這次的具體指正',
    '研究已登記：開新的子代理，用執行主線當下的模型與推理，附研究選定的方案與前四次的錯誤摘要；第一步先做驗證小實驗',
    '交回第 5 次做的子代理，同模型同推理重做，附這次的具體指正'][n]||'照常派工';
}
function status(run){
  return [...tally(rows(run))].map(([criterionId,t])=>({criterionId,failures:t.failures.length,held:waitsForStudy(t)||waitsForJay(t),
    waitsForJay:waitsForJay(t),studies:t.resets.length,rulings:t.resumes.length,totalFailures:t.all.length,next:nextStep(t),
    current:t.failures.map(f=>({source:f.source,packageId:f.packageId||null,reason:f.reason,at:f.at}))}));
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
  // A failed formal or real run of this package already counted itself (formalFailure, efficiency.cjs); judging the
  // same delivery again does not count the one failure twice. Nor does collecting the same failed delivery twice: a
  // package that stays in flight for its redo can be collected again with the same verdict.
  const reason=verdict.reason.trim();
  const counted=new Set(rows(run).filter(r=>r.kind==='verdict'&&r.packageId===id&&(['formal','efficiency'].includes(r.source)||
    r.source==='executor'&&r.handle===(handle||null)&&r.reason===reason)).map(r=>r.criterionId));
  return criteriaFor(run,binding,verdict.criteria,before.acceptanceIds||tagIds,where).filter(criterionId=>!counted.has(criterionId)).map(criterionId=>({kind:'verdict',criterionId,outcome:'FAIL',source:'executor',
    packageId:id,handle:handle||null,reason:verdict.reason.trim(),at}));
}
// A formal run on the scarce machine that reports FAIL is a measured failure of its criterion, whoever ran it; the
// mainline running the case itself has no delivery to judge. INCONCLUSIVE and BLOCKED say nothing about the work.
function formalFailure(run,permit,attempt,at=new Date().toISOString()){
  if(attempt.outcome!=='FAIL')return;
  // The same attempt may already have counted as too slow (efficiency.cjs); one run is one failure.
  if(rows(run).some(r=>r.kind==='verdict'&&r.attemptId===permit.id))return;
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
  // A criterion with an efficiency expectation is accepted only on runs within it (efficiency.cjs, Jay 2026-11-27).
  const efficiency=require('./efficiency.cjs'),expected=efficiency.expectations(run),history=rows(run);
  for(const r of supplied)for(const id of r.accepted||[]){
    const problems=efficiency.blockers(expected,history,id);
    need(!problems.length,id+' 不能採認，實跑沒達到效率預期：'+problems.join('；')+'。改列在 failed（這次未過）或 remaining');
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
    const stop=held(history,item.acceptanceIds),t=tally(history);
    need(!stop.length,stop.map(id=>'驗收條文 '+id+' 已累計 '+t.get(id).failures.length+' 次不合格，'+item.id+(submitting?' 先不送審':' 先不派')+'：'+nextStep(t.get(id))).join('；')+
      (stop.some(id=>!waitsForJay(t.get(id)))?'。確定不需研究時把理由交監督核可，由監督用 rework.cjs waive 登記':''));
  }
}
function registered(run,binding,id){
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  return fs.existsSync(file)&&entries(read(file)).some(({item})=>item.id===id);
}
// Research is a web search for workable answers (Jay 2026-11-28「他要把這遇到的問題定位了以後，一定要開啟上網，搜尋
// GitHub，各種技術論壇，或是他們使用的語言，或是情境的外部技術文件，找到可能可行的方案了以後，回來分析，然後再回給執行
// 主線，派子代理去做實作」). Workspace E's research C69 ran 112 commands and two searches, proposed a design no source
// held, and wrote all five sources' times within four seconds of each other. So the research subagent's own transcript
// is read: it has to have searched (a Codex web_search_call, a web__run call in a command, or Claude's WebSearch or
// WebFetch), and every source it gives first appears there at or after its first search; that moment is recorded as
// when the source was seen. Only what it did after the latest failure it studies counts. The research itself only reads and checks: the subagent the mainline dispatches on the
// chosen candidate runs the confirming experiment first (Jay 2026-11-28, replacing the passing experiment of 2026-11-19).
const SEARCH_TOOLS=new Set(['WebSearch','WebFetch','web_search','web__run']);
function searchOf(row){
  const item=row.payload;
  if(item?.type==='web_search_call')return [].concat(item.action?.queries||item.action?.query||item.action?.url||'search').map(String);
  if(['custom_tool_call','function_call'].includes(item?.type)){
    const body=String(item.input||item.arguments||'');
    if(SEARCH_TOOLS.has(item.name)||/\bweb__run\s*\(|\bweb_search\s*\(/.test(body))return [body.slice(0,300)];
  }
  if(row.type==='assistant')for(const block of row.message?.content||[])
    if(block?.type==='tool_use'&&SEARCH_TOOLS.has(block.name))return [JSON.stringify(block.input||{}).slice(0,300)];
  return null;
}
function researchTrail(binding,handle,since){
  const pace=require('./pace.cjs'),key=String(handle).replace(/^agent:/,'');
  // An agent path can be reused after its subagent closes; the latest run under that path is the research.
  const agent=pace.agentRuns(binding).filter(item=>[item.path,item.id].includes(key)).sort((a,b)=>(b.lastAt||0)-(a.lastAt||0))[0];
  need(agent,'researchAgent '+handle+' 不是'+(binding.role==='supervisor'?'這個監督對話':'這個執行主線')+'派出的子代理：寫研究子代理的代號（Codex 的 /root/... 路徑或子代理對話 ID，Claude Code 的 agent ID）');
  const files=pace.sessionFiles?pace.sessionFiles(agent.id):[];
  const searches=[],after=[];
  for(const file of files.length?files:[agent.sourceFile])for(const line of fs.readFileSync(file,'utf8').split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    const at=Date.parse(row.timestamp);
    if(!Number.isFinite(at)||at<since)continue;
    const queries=searchOf(row);
    if(queries)searches.push({at:new Date(at).toISOString(),queries});
    if(searches.length)after.push({at,line});
  }
  const seen=url=>{const bare=url.replace(/#.*$/,'').replace(/\/+$/,''),hit=after.find(item=>item.line.includes(bare));return hit?new Date(hit.at).toISOString():null;};
  return {agent:agent.path||agent.id,searches,seen};
}
// 關卡二 (Jay 2026-11-23): research lists the direct cause of each failure and their common upstream cause, the excluded
// causes, and (Jay 2026-11-27 decision 50) the development and test/acceptance environment conditions and the packages
// and software involved. Skipping research needs the supervisor (decision 49): on workspace E the mainline itself waived
// the 2nd failure of I07 and of I23, and no research subagent was ever dispatched; I23 was a performance cause, not a typo.
function reset(run,binding,mode,input,at=new Date().toISOString()){
  if(mode==='research')mainlineOnly('登記研究');
  else{
    try{contract.supervisorOnly(binding);}
    catch{throw Error('「不需研究」要監督核可：執行主線把理由用 question 事件交監督，監督同意後由監督執行 rework.cjs waive（Jay 2026-11-27 決策 49）');}
  }
  const history=rows(run),t=tally(history).get(input?.criterionId);
  need(text(input?.criterionId)&&t&&waitsForStudy(t),'只有等研究的驗收條文能登記（第 '+STUDY_AT.join('、')+' 次不合格後）：'+(input?.criterionId||'（沒寫 criterionId）')+' 目前 '+(t?.failures.length||0)+' 次'+(t&&studied(t)?'，這次已登記過':''));
  // The failures this study covers: those since the previous study.
  const since=t.resets.length?t.resets.at(-1).after:0,covered=t.failures.slice(since);
  const causes=input.directCauses;
  need(Array.isArray(causes)&&causes.length>=covered.length&&causes.every(text),'directCauses 要逐次列出上次研究之後這 '+covered.length+' 次不合格的直接原因（每次一句）');
  const row={kind:'reset',criterionId:input.criterionId,mode,cycle:t.resets.length+1,failureCount:t.failures.length,failures:covered.map(f=>({source:f.source,packageId:f.packageId||null,at:f.at})),
    directCauses:causes.map(c=>c.trim()),at};
  if(mode==='research'){
    need(text(input.commonCause),'commonCause 要寫各次失敗共同的上游原因');
    need(['excluded','environment','software','workPackage','researchAgent'].every(k=>text(input[k]))&&
      Array.isArray(input.sources)&&input.sources.length&&input.sources.every(x=>/^https?:\/\//.test(x?.url)),
      '研究登記要有：excluded（已排除原因）、environment（開發與測試驗收環境的條件：主機、規格、容器、資料、權限與限制）、software（用到的套件與軟體：名稱、版本與已知限制）、researchAgent（研究子代理的代號）、sources（研究子代理搜到的外部網址）、candidates（候選方案）、workPackage（照研究重做的工作包）');
    const trail=researchTrail(binding,input.researchAgent.trim(),Date.parse(covered.at(-1)?.at)||0);
    need(trail.searches.length,'研究子代理 '+trail.agent+' 在最近一次不合格（'+covered.at(-1)?.at+'）之後的執行紀錄沒有任何網路搜尋：研究要先上網搜尋 GitHub、技術論壇與所用語言或框架的外部文件，從找到的方案分析，再交回主線。請派研究子代理照這個順序重做');
    const sources=input.sources.map(x=>({url:x.url,seenAt:trail.seen(x.url)})),unseen=sources.filter(x=>!x.seenAt).map(x=>x.url);
    need(!unseen.length,'這些來源沒有出現在研究子代理 '+trail.agent+' 搜尋之後的執行紀錄裡：'+unseen.join('、')+'。來源要是研究子代理上網搜到、讀到的網址');
    const urls=new Set(sources.map(x=>x.url)),candidates=Array.isArray(input.candidates)?input.candidates:[];
    need(candidates.length||text(input.notFound),'candidates 要列研究找到的候選方案；真的查不到可行方案時，寫 notFound 說明查了哪些地方、為什麼都不可行');
    need(candidates.every(c=>['approach','conditions','risks'].every(k=>text(c?.[k]))&&Array.isArray(c.sources)&&c.sources.length&&c.sources.every(url=>urls.has(url))),
      '每個候選方案要寫 approach（做法）、conditions（適用條件）、risks（風險），sources 列它依據的外部網址（至少一個，要是 sources 列過的）');
    const chosen=candidates.find(c=>c.approach===input.selected);
    need(!candidates.length||chosen&&text(input.selectionReason),'selected 照抄選定候選方案的 approach，selectionReason 寫為什麼選它');
    need(registered(run,binding,input.workPackage),'workPackage '+input.workPackage+' 還沒登記在派工表');
    Object.assign(row,{commonCause:input.commonCause.trim(),excluded:input.excluded,environment:input.environment.trim(),software:input.software.trim(),
      researchAgent:trail.agent,searches:trail.searches,sources,candidates,
      ...(chosen?{selected:chosen.approach,selectionReason:input.selectionReason.trim(),solution:chosen.approach}:{notFound:input.notFound.trim(),solution:'查不到可行方案：'+input.notFound.trim()}),
      workPackage:input.workPackage});
  }else{
    need(text(input.reason),'不需研究要寫 reason：為什麼這兩次不合格不必上網研究（只限錯字、設定值這類不涉及技術判斷的小修，或補做實測就能佐證）');
    row.reason=input.reason.trim();row.by='supervisor';
    if(text(input.commonCause))row.commonCause=input.commonCause.trim();
  }
  append(run,[row]);
  const after=tally(rows(run)).get(row.criterionId);
  return {registered:row.criterionId,mode,cycle:row.cycle,failures:row.failureCount,next:nextStep(after),waitsForJay:waitsForJay(after)};
}
// Jay's ruling after the 6th failure and its study (decision 33): his words are registered and the count starts again.
function resume(run,binding,input,at=new Date().toISOString()){
  mainlineOnly('登記 Jay 的裁決');
  const t=tally(rows(run)).get(input?.criterionId);
  need(text(input?.criterionId)&&t&&waitsForJay(t),'只有第 '+JAY_AT+' 次不合格且研究已登記的驗收條文能登記裁決：'+(input?.criterionId||'（沒寫 criterionId）')+' 目前 '+(t?.failures.length||0)+' 次');
  need(text(input.ruling),'ruling 要照錄 Jay 的裁決原話');
  const row={kind:'resume',criterionId:input.criterionId,failures:t.failures.length,ruling:input.ruling.trim(),...(text(input.pendingKey)?{pendingKey:input.pendingKey.trim()}:{}),at};
  append(run,[row]);
  return {resumed:row.criterionId,failures:0};
}
// The criteria waiting for Jay (the 6th failure studied), once per ruling round. The supervisor is woken to read the six
// deliveries, the rejections and the studies and to put one question to Jay in the pending ledger (decision 34); Veda's
// summaries at 09:00, 12:00 and 19:00 carry it, with no push of its own.
const keyOf=(id,round)=>{const slug=String(id).replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,32);
  return 'rework-'+(slug===id?slug:slug+'-'+crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,6))+'-r'+round;};
function alerts(run,binding){
  const out=[];
  let criteria=[];try{criteria=contract.effective(run,binding).criteria;}catch{}
  for(const [criterionId,t] of tally(rows(run))){
    if(!waitsForJay(t))continue;
    out.push({key:keyOf(criterionId,t.resumes.length+1),criterionId,round:t.resumes.length+1,total:t.all.length,failures:t.failures.length,
      requirement:criteria.find(c=>c.id===criterionId)?.requirement||null,causes:t.resets.flatMap(x=>x.directCauses||[]),
      common:t.resets.map(x=>x.commonCause).filter(Boolean),studies:t.resets.map(x=>x.mode==='research'?x.solution:'不需研究：'+x.reason),
      at:t.resets.at(-1).at});
  }
  return out;
}
function describe(alert,title){
  return ['任務：'+(title||'（監督對話）'),'驗收條文：'+alert.criterionId+(alert.requirement?'（'+alert.requirement+'）':''),
    '這一輪累計不合格 '+alert.failures+' 次（全部 '+alert.total+' 次），研究 '+alert.studies.length+' 次。',
    '各次直接原因：'+alert.causes.join('；'),'共同上游原因：'+(alert.common.join('；')||'（未寫）'),'各次研究結論：'+alert.studies.join('；')].join('\n');
}
// Raised by Claude's watcher, which has no supervisor turn to wake: the question goes to the pending ledger as it is.
function raiseAlerts(run,binding,{title}={}){
  const pending=require('./pending-decisions.cjs'),ledger=pending.load(run),known=new Set(ledger.items.map(item=>item.key));
  const fresh=alerts(run,binding).filter(a=>!known.has(a.key));
  if(!fresh.length)return [];
  pending.apply(run,{raise:fresh.map(a=>({key:a.key,kind:'rework_decision',ask:'情境：同一驗收條文 '+a.criterionId+' 已 '+a.failures+' 次不合格，研究也做了 '+a.studies.length+' 次。\n現況：這條停止派工與送驗，其他工作照常。\n'+describe(a,title),
    recommend:'依研究結論決定方向：改做法、調整條文或暫緩這條',why:'Jay 2026-11-26 定案：第 6 次不合格研究完成後由 Jay 裁決接下來怎麼做',options:['照研究結論再做一輪','我要調整方向（請寫明）']}))},{binding});
  return fresh.map(a=>a.key);
}
module.exports={openingResearch,LIMIT,STUDY_AT,JAY_AT,rows,tally,held,nextStep,status,caller,mainlineOnly,verdictRows,formalFailure,scope,rulingRows,recordRuling,dispatchCheck,reset,resume,alerts,describe,raiseAlerts,keyOf};
// Opening research (Jay 2026-11-28「監督任務今天如果被觸發了時候，他第一件事情應該是要先去看給他的這個計畫內容，有沒有先做外部
// 開源 GitHub 或是一些技術文件 ... 的引用」, then「大部分的狀況我應該在事前就會先做完 ... 如果有疏漏的話，就是進到監督任務後他
// 再做一次 ... 如果裡面已經有做過的話，那他就是再做一次驗證」). Before a new run exists the supervisor's own research subagent
// checks the requirement documents' outside references and the environment they need, or finds them when the documents
// have none. Its transcript is read the same way as a rework study: it searched, and every reference appears after the
// search. A continued run keeps its first run's opening research; a run under the system temp directory is a test, and
// there the record is checked only when it is given.
function openingResearch(run,conversation,input,{inherited=false}={}){
  // The run folder does not exist yet: the nearest existing parent is resolved (macOS /var is /private/var).
  const real=file=>{const full=path.resolve(file);try{return fs.realpathSync(full);}catch{const up=path.dirname(full);return up===full?full:path.join(real(up),path.basename(full));}};
  const tmp=real(process.env.LONG_TASK_TEMP_ROOT||require('node:os').tmpdir()),at=real(path.dirname(run));
  const test=at===tmp||at.startsWith(tmp+path.sep);
  if(input===undefined&&(inherited||test))return null;
  need(input&&typeof input==='object','priorArt is required: the opening research of outside references and the environment, done by a research subagent of this supervisor (see SKILL「開案五項與環境」)');
  need(typeof input.documented==='boolean','priorArt.documented 寫需求文件原本有沒有外部參考與環境評估（true＝已有、這次驗證；false＝沒有或有缺、這次補做）');
  need(text(input.researchAgent),'priorArt.researchAgent 寫監督派出的研究子代理代號');
  need(text(input.environment),'priorArt.environment 寫環境評估的結論：每條驗收條文要在哪一層環境驗，需要的服務、硬體、資料與套件版本，寫進環境表（ENV- 條文）');
  const references=Array.isArray(input.references)?input.references:[];
  need(references.length||text(input.notFound),'priorArt.references 列可沿用的開源專案、套件或技術文件；真的沒有可沿用的，寫 notFound 說明查了哪些地方');
  need(references.every(item=>/^https?:\/\//.test(item?.url)&&['license','maintenance','fit'].every(key=>text(item[key]))),
    '每項參考要有 url、license（授權，商用產品要能用）、maintenance（維護狀況與評分）、fit（要改什麼才合用，或為什麼不合用）');
  const trail=researchTrail({...conversation,role:'supervisor'},input.researchAgent.trim(),0);
  need(trail.searches.length,'研究子代理 '+trail.agent+' 的執行紀錄沒有任何網路搜尋：開案研究要先上網搜尋 GitHub、技術論壇與所用語言或框架的外部文件，再回來對照需求文件');
  const seen=references.map(item=>({...item,seenAt:trail.seen(item.url)})),unseen=seen.filter(item=>!item.seenAt).map(item=>item.url);
  need(!unseen.length,'這些參考沒有出現在研究子代理 '+trail.agent+' 搜尋之後的執行紀錄裡：'+unseen.join('、'));
  return {documented:input.documented,researchAgent:trail.agent,searches:trail.searches,references:seen,environment:input.environment.trim(),
    ...(text(input.notFound)?{notFound:input.notFound.trim()}:{}),at:new Date().toISOString()};
}
if(require.main===module){
  const [command,run,inputFile]=process.argv.slice(2);
  try{
    need(['status','research','waive','resume'].includes(command)&&path.isAbsolute(run||'')&&(command==='status'||path.isAbsolute(inputFile||'')),
      'Usage: rework.cjs status ABSOLUTE_RUN | research ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | waive ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | resume ABSOLUTE_RUN ABSOLUTE_INPUT_JSON');
    const binding=read(path.join(run,'binding.json'));
    console.log(JSON.stringify(command==='status'?status(run):command==='resume'?resume(run,binding,read(inputFile)):reset(run,binding,command==='research'?'research':'waived',read(inputFile)),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
