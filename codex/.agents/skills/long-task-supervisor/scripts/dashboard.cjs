// A plain-language page the supervisor opens beside its chat at start (Jay 2026-10-11). The model-free watcher
// rewrites it at most once a minute, so looking at progress never wakes a model or costs a turn.
const fs=require('node:fs'),path=require('node:path');
const pending=require('./pending-decisions.cjs');
const FILE='監督儀表板.md';
const clock=ms=>ms?new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const ago=(ms,now)=>ms?Math.max(0,Math.round((now-ms)/60000))+' 分鐘前':'—';
const OPEN=['FAIL','PENDING','INCONCLUSIVE','BLOCKED'];
const who=(id,binding)=>id===binding.executorId?'執行對話':id===binding.supervisorId?'監督對話':'子代理 '+id.slice(0,8);
const cell=value=>String(value??'').replace(/\|/g,'／').replace(/\s+/g,' ').slice(0,160);
// A question push that did not get through is on the page until one does (Jay 2026-11-09: GDB's 6 never left unseen).
const pushLine=problem=>'- 題目推播到你手機：'+(problem?clock(Date.parse(problem.at))+' 沒送出（'+cell(problem.error).slice(0,100)+'）；每 10 分鐘自動重試，最多 3 次，監督下一則回覆會說明':'沒有失敗');
// What the supervisor decided in Jay's place, newest first, each with the way back (Jay 2026-11-09). Delegations are
// not pushed: they stay in the task's closing report, which lists every one once the run is accepted (Jay 2026-11-24
// 「只要留在他的專案裡面的結案報告，或者是當我詢問的時候」).
function delegatedLines(delegated=[],closing=false){
  const lines=['',closing?'## 結案報告：監督代決的全部事項（'+delegated.length+' 項）':'## 監督已代決（'+delegated.length+' 項）',''];
  if(!delegated.length)return [...lines,closing?'這個任務沒有代決。':'目前沒有。'];
  const shown=closing?delegated:delegated.slice(0,20);
  return [...lines,'監督依規格先決定、不等你；要改回直接跟監督說。'+(shown.length<delegated.length?'這裡列最近 20 項，完整清單在 run 目錄的 pending-decisions.json。':''),'',
    '| 決定的事 | 監督的選擇 | 依據 | 怎麼改回 | 時間 |','|---|---|---|---|---|',
    ...shown.map(item=>'| '+cell(item.ask)+' | '+cell(item.choice)+' | '+cell(item.basis)+' | '+cell(item.revert)+' | '+clock(Date.parse(item.at))+' |')];
}
// The model order the watcher applies (Jay 2026-11-21, 2026-11-26), in the words Jay used: how far down the quota
// ladder each role is, whether the API key is out for the month, whether an open-source route is left, and acceptances
// an interim supervisor wrote that wait for a high-tier review.
function modelLines(binding,state,now){
  const lines=[];
  if(state.claudeQuota)lines.push('- 訂閱額度降級階梯：'+require('./claude-quota.cjs').describe(state.claudeQuota));
  if(state.claudeQuota?.openai)lines.push('- OpenAI 訂閱額度：'+require('./claude-quota.cjs').describeOpenAI(state.claudeQuota));
  if(state.apiMonth?.until>now)lines.push('- Claude API：本月額度已用完，'+clock(state.apiMonth.until)+' 前所有任務的各角色都跳過這一站');
  let open=null;try{open=require('./openrouter-route.cjs').routes(binding.fourthExecutorModel||null).length;}catch{}
  if(open===0)lines.push('- 開源備援：目前沒有可用模型（OpenCodex 設定或價格上限未通過）；前面順位都用完時只能等重置');
  const held=state.heldFinalReviews||[];
  if(held.length)lines.push('- 暫代監督保留的結案：'+held.length+' 件（'+held.map(item=>item.event?.id||item.id).filter(Boolean).slice(0,3).join('、')+
    '），等 Sol、Astra、Opus 或 Fable 回到監督後逐條複驗');
  return lines;
}
function render({binding,state,snapshot,paced,alive,paused,ledger={open:[]},pushProblem=null,segments=null,now=Date.now()}){
  const items=snapshot?.acceptance?.items||[],passed=items.filter(item=>item.status==='PASS').length;
  const open=items.filter(item=>OPEN.includes(item.status)),settings=state.executorSettings;
  const autoReview=settings?.approvalPolicy&&settings.approvalPolicy!=='never';
  const switched=Object.entries(state.modelSwitch||{}).filter(([,item])=>!item.restored||!item.respondedAt && item.current===item.original);
  const queued=(state.eventQueue||[]).length;
  const handling=(state.pending?state.pending.id+'（'+state.pending.kind+(state.pending.reasons?'：'+state.pending.reasons.join('、'):'')+'）':'無')+
    (queued?'；另有 '+queued+' 個執行對話事件排隊，處理完依序送監督':'');
  const permission=(!settings?'尚未讀到':(autoReview?'自動審查（是否允許依實際審查結果）':'不需逐項審查（是否可操作依實際工具結果）'))+
    (state.rejectionCount?'，疑似審查拒絕紀錄 '+state.rejectionCount+' 次（待核對原始事件）':'')+
    (require('./model-fallback.cjs').fullAccess(settings)===false?'；不是完全存取，監督會請你切換一次':'');
  const models=switched.length?switched.map(([id,item])=>who(id,binding)+' 改用 '+item.current+
    (item.respondedAt?'，已確認模型產生輸出':'，尚未確認模型產生輸出')+(item.current===item.original?'':'，背景持續查核較高順位')).join('；'):'無';
  const failed=state.platformError?clock(state.platformError.since)+' 執行對話被平台錯誤中斷：'+String(state.platformError.text||'').slice(0,120)+'；2 分鐘內沒恢復就叫醒監督處理':'無';
  const lines=['# 監督儀表板','','更新時間：'+clock(now)+'（台北）','','## 監看','',
    '- 背景監看：'+(alive?'運作中':'已停止')+'（狀態 '+(state.phase||'—')+(paused?'，使用者暫停中':'')+'）',
    '- 執行對話最後一次交回進度：'+clock(state.lastRealEventAt)+'（'+ago(state.lastRealEventAt,now)+'）',
    '- 等監督處理：'+handling,'- 執行對話權限：'+permission,'- 限速換模型：'+models,'- 平台錯誤：'+failed,pushLine(pushProblem)];
  lines.push(...modelLines(binding,state,now));
  for(const [id,item] of Object.entries(state.routeWaiting||{}))lines.push('- '+who(id,binding)+' 正在等可用模型，由背景檢查恢復。');
  const response=state.pending&&state.supervisorWake?.[state.pending.id];
  if(response?.completionRecovery)lines.push('- 監督決策：上一回合已結束，這個事件仍未結案；'+
    (response.completionWakeSentAt?'已補送原事件的決策提醒，等待正式提交。':'正在補送原事件的決策提醒。'));
  if(state.instruction){const due=state.instruction.sentAt+state.instruction.deadlineMs*((state.instruction.misses||0)+1);
    lines.push('- 等執行端回應的指示：'+state.instruction.what.slice(0,80)+'（期限 '+clock(due)+'）');}
  // Jay's decisions from the run ledger: the same list the supervisor asks in one go.
  const waiting=ledger.open||[];
  lines.push('','## 待你決定（'+waiting.length+' 項）','');
  if(ledger.error)lines.push('待決帳讀不到：'+ledger.error);
  else if(waiting.length)lines.push('| 要決定的事 | 推薦 | 為什麼要你決定 | 列給你的時間 |','|---|---|---|---|',
    ...waiting.map(item=>'| '+cell(item.ask)+' | '+cell(item.recommend)+' | '+(pending.KINDS[item.kind]||cell(item.kind))+' | '+(item.presentedAt?clock(Date.parse(item.presentedAt)):'還沒列')+' |'));
  else lines.push('目前沒有要你決定的事。');
  // A run started before the ledger: its free-text approvals until the supervisor registers what is still open.
  if(ledger.legacy)lines.push('','舊版決策記下、監督還沒重新登記的待核准：',...ledger.legacy.pendingApprovals.map(item=>'- '+cell(item)));
  lines.push(...delegatedLines(ledger.delegated,state.phase==='accepted'));
  lines.push('','## 驗收條件（共 '+items.length+' 條，通過 '+passed+'，未通過 '+open.length+'）','');
  if(items.length)lines.push('| 條件 | 狀態 |','|---|---|',...items.map(item=>'| '+item.id+' | '+item.status+' |'));
  else lines.push('派工快照還沒有逐條驗收狀態。');
  // Each segment with the criteria the supervisor has passed (Jay 2026-11-25): segments are ruled one at a time while
  // the mainline works on the next, so progress shows here during development instead of only at the end.
  if(segments?.length)lines.push('','## 區段進度（共 '+segments.length+' 段，已全部通過 '+segments.filter(item=>item.passed.length===item.criteria.length).length+' 段）','',
    '| 區段 | 通過／條文 | 依賴 |','|---|---|---|',...segments.map(item=>'| '+item.id+(item.title?' '+cell(item.title):'')+' | '+item.passed.length+'／'+item.criteria.length+' | '+(item.dependsOn.join('、')||'—')+' |'));
  lines.push('','## 在途工作','');
  if(paced.packages.length)lines.push('| 工作包 | 已跑（分） | 預估（分） | 比值 |','|---|---|---|---|',
    ...paced.packages.map(item=>'| '+item.id+' | '+(item.elapsedMinutes??'—')+' | '+(item.baselineMinutes??'未填')+' | '+(item.ratio??'—')+' |'));
  else lines.push('目前沒有在途工作包。');
  // Only measured package baselines estimate the rest; without them the page says 未估 (no measurement, no estimate).
  // Passed criteria per hour said 19.7 hours on GDB 2026-10-15 while most criteria pass together after one deploy.
  lines.push('','## 預估完成','');
  const remaining=['ready','blocked'].flatMap(key=>snapshot?.packages?.[key]||[]),inFlight=paced.packages.filter(item=>!item.finished);
  const unmeasured=[...remaining.map(item=>item.id),...inFlight.filter(item=>!item.baselineMinutes||item.ratio>=1).map(item=>item.id)];
  if(!snapshot)lines.push('未估：還沒有派工快照。');
  else if(unmeasured.length)lines.push('未估：'+unmeasured.length+' 個工作包沒有可用的時程基準（就緒或受阻、還沒開跑的包，以及沒填基準或已超過基準的在途包）：'+unmeasured.slice(0,8).join('、')+(unmeasured.length>8?' 等':'')+'。');
  else if(inFlight.length){const minutes=Math.max(...inFlight.map(item=>item.baselineMinutes-item.elapsedMinutes));
    lines.push('約 '+Math.round(minutes)+' 分鐘（'+clock(now+minutes*60000)+' 前後）。依據：派工快照在途 '+inFlight.length+' 個工作包的時程基準減去已跑時間（扣掉電腦睡眠），取最晚的一包；不含等你核准、限速、外部結果與之後還沒拆出的工作。');}
  else lines.push(open.length?'未估：還有 '+open.length+' 條未通過，派工快照沒有剩餘的工作包。':'所有條件都已通過，或尚未建立驗收表。');
  return lines.join('\n')+'\n';
}
function write(run,args){
  // An outage notice from watch-health.cjs stays at the top until the watch works again.
  const file=path.join(run,FILE),body=require('./watch-health.cjs').withBanner(render({ledger:pending.view(run,args.state),pushProblem:pending.pushProblem(run),
    segments:require('./segments.cjs').progress(require('./segments.cjs').read(run),args.snapshot?.acceptance?.items),...args}),run);
  fs.writeFileSync(file+'.tmp',body);fs.renameSync(file+'.tmp',file);
  return file;
}
module.exports={FILE,render,write};
