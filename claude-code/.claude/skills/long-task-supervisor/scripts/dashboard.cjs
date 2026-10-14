// A plain-language page the supervisor opens for Jay at start (Jay 2026-10-11, Codex parity). The model-free watcher
// rewrites it at most once a minute while it runs, so looking at progress never wakes a model or costs a turn.
const fs=require('node:fs'),path=require('node:path');
const ledger=require('./pending-decisions.cjs'),{queued}=require('./handoff-lib.cjs');
const FILE='監督儀表板.md';
const clock=ms=>ms?new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const ago=(ms,now)=>ms?Math.max(0,Math.round((now-ms)/60000))+' 分鐘前':'—';
const OPEN=['FAIL','PENDING','INCONCLUSIVE','BLOCKED'];
function render({binding,state,snapshot,paced,alive,hold,paused,pendingDecisions={open:[]},queue=[],now=Date.now()}){
  const items=snapshot?.acceptance?.items||[],passed=items.filter(item=>item.status==='PASS').length;
  const open=items.filter(item=>OPEN.includes(item.status)),settings=state.executorSettings;
  const hours=Math.max(0,(now-(Date.parse(binding.createdAt)||now))/3600000);
  const perHour=passed&&hours>0?passed/hours:0;
  const pending=state.pending?state.pending.id+'（'+state.pending.kind+(state.pending.reasons?'：'+state.pending.reasons.join('、'):'')+'）':'無';
  const refusedItems=[...new Set((state.reviewRejections||[]).map(item=>item.item).filter(Boolean))];
  const permission=!settings?.permissionMode?'尚未讀到':settings.permissionMode==='auto'?'自動模式（Git、遠端連線等操作可能被自動模式擋下；請在該對話的權限選單切成「略過權限」，不必在該對話打字，續接訊息由監督送）'+
    (state.rejectionCount?'，已被擋 '+state.rejectionCount+' 次'+(refusedItems.length?'，最近被擋：'+refusedItems.slice(-4).join('、'):''):''):settings.permissionMode==='bypassPermissions'?'略過權限':settings.permissionMode;
  const model=settings?.model?settings.model+(settings.effort?'／'+settings.effort:''):'尚未讀到';
  const limit=state.rateLimit&&state.rateLimit.until>now?'限速中（'+(state.rateLimit.who||'執行端')+'），預計 '+clock(state.rateLimit.until)+' 恢復；期間不叫醒模型，恢復後自動續接':'無';
  const failed=state.platformError?clock(state.platformError.since)+' 執行對話被平台錯誤中斷：'+String(state.platformError.text||state.platformError.kind).slice(0,120)+'；2 分鐘內沒恢復就叫醒監督處理':'無';
  const lines=['# 監督儀表板','','更新時間：'+clock(now)+'（台北）','','## 監看','',
    '- 背景監看：'+(alive?'運作中':'已停止')+'（狀態 '+(state.phase||'—')+(paused?'，使用者暫停中':'')+'）',
    '- 監督保持載入：'+(hold?'運作中':'未掛（監督可能在交出事件時被 App 暫停而叫不醒，監督下次醒來會補掛）'),
    '- 執行對話最後一次交回進度：'+clock(state.lastRealEventAt)+'（'+ago(state.lastRealEventAt,now)+'）',
    '- 等監督處理：'+pending+(queue.length?'；另有 '+queue.length+' 個執行端事件排隊，依送出先後送到':''),'- 執行對話權限：'+permission,'- 執行對話模型：'+model,'- 額度限速：'+limit,'- 平台錯誤：'+failed];
  if(state.instruction){const due=state.instruction.sentAt+state.instruction.deadlineMs*((state.instruction.misses||0)+1);
    lines.push('- 等執行端回應的指示：'+state.instruction.what.slice(0,80)+'（期限 '+clock(due)+'）');}
  // Jay's decisions from the run ledger: the same list the supervisor asks once (Jay 2026-10-14).
  const waiting=pendingDecisions.open||[],cell=value=>String(value??'').replace(/\|/g,'／').replace(/\s+/g,' ').slice(0,160);
  lines.push('','## 待你決定（'+waiting.length+' 項）','');
  if(pendingDecisions.error)lines.push('待決帳讀不到：'+cell(pendingDecisions.error));
  else if(waiting.length)lines.push('| 要決定的事 | 推薦 | 為什麼要你決定 | 列給你的時間 |','|---|---|---|---|',
    ...waiting.map(item=>'| '+cell(item.ask)+' | '+cell(item.recommend)+' | '+(ledger.KINDS[item.kind]||item.kind)+' | '+(item.presentedAt?clock(Date.parse(item.presentedAt)):'還沒列')+' |'));
  else lines.push(pendingDecisions.legacy?'監督還沒把舊版決策裡的待核准事項登記進待決帳：'+pendingDecisions.legacy.pendingApprovals.map(cell).join('；'):'目前沒有要你決定的事。');
  lines.push('','## 驗收條件（共 '+items.length+' 條，通過 '+passed+'，未通過 '+open.length+'）','');
  if(items.length)lines.push('| 條件 | 狀態 |','|---|---|',...items.map(item=>'| '+item.id+' | '+item.status+' |'));
  else lines.push('派工快照還沒有逐條驗收狀態。');
  lines.push('','## 在途工作','');
  if(paced.packages.length)lines.push('| 工作包 | 已跑（分） | 預估（分） | 比值 |','|---|---|---|---|',
    ...paced.packages.map(item=>'| '+item.id+' | '+(item.elapsedMinutes??'—')+' | '+(item.baselineMinutes??'未填')+' | '+(item.ratio??'—')+' |'));
  else lines.push('目前沒有在途工作包。');
  lines.push('','## 預估完成','');
  if(perHour&&open.length)lines.push('約 '+Math.round(open.length/perHour*10)/10+' 小時。算法：開工 '+Math.round(hours*10)/10+' 小時通過 '+passed+' 條，每小時約 '+
    Math.round(perHour*100)/100+' 條；剩 '+open.length+' 條 ÷ 每小時條數。不含等你核准、限速或外部結果的時間。');
  else lines.push(open.length?'還沒有任何條件通過，無法用實測速度推估。':'所有條件都已通過，或尚未建立驗收表。');
  lines.push('','背景監看在每個事件後暫停、由監督處理完再重掛；暫停期間與驗收後本頁不更新，最新的「待你決定」以狀態面板或 run 目錄的 pending-decisions.json 為準。');
  return lines.join('\n')+'\n';
}
function write(run,args){
  const file=path.join(run,FILE),body=render({pendingDecisions:ledger.view(run,args.state),queue:queued(run),...args});
  fs.writeFileSync(file+'.tmp',body);fs.renameSync(file+'.tmp',file);
  return file;
}
module.exports={FILE,render,write};
