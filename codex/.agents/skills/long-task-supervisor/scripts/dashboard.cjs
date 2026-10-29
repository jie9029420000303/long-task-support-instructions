// A plain-language page the supervisor opens beside its chat at start (Jay 2026-10-11). The model-free watcher
// rewrites it at most once a minute, so looking at progress never wakes a model or costs a turn.
const fs=require('node:fs'),path=require('node:path');
const pending=require('./pending-decisions.cjs');
const FILE='監督儀表板.md';
const clock=ms=>ms?new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const ago=(ms,now)=>ms?Math.max(0,Math.round((now-ms)/60000))+' 分鐘前':'—';
const OPEN=['FAIL','PENDING','INCONCLUSIVE','BLOCKED'];
const who=(id,binding)=>id===binding.executorId?'執行對話':id===binding.supervisorId?'監督對話':'子代理 '+id.slice(0,8);
function render({binding,state,snapshot,paced,alive,paused,ledger={open:[]},now=Date.now()}){
  const items=snapshot?.acceptance?.items||[],passed=items.filter(item=>item.status==='PASS').length;
  const open=items.filter(item=>OPEN.includes(item.status)),settings=state.executorSettings;
  const autoReview=settings?.approvalPolicy&&settings.approvalPolicy!=='never';
  const switched=Object.entries(state.modelSwitch||{}).filter(([,item])=>!item.restored);
  const queued=(state.eventQueue||[]).length;
  const handling=(state.pending?state.pending.id+'（'+state.pending.kind+(state.pending.reasons?'：'+state.pending.reasons.join('、'):'')+'）':'無')+
    (queued?'；另有 '+queued+' 個執行對話事件排隊，處理完依序送監督':'');
  const refusedItems=[...new Set((state.reviewRejections||[]).map(item=>item.item).filter(Boolean))];
  const permission=!settings?'尚未讀到':autoReview?'自動審查（Git、遠端連線等操作會被平台擋下；請在該對話的權限選單選「完全存取」，只切選單、不必打字，切好在監督對話說一聲，續接由監督送）'+
    (state.rejectionCount?'，已被擋 '+state.rejectionCount+' 次'+(refusedItems.length?'，最近被擋：'+refusedItems.slice(-4).join('、'):''):''):'完全存取';
  const models=switched.length?switched.map(([id,item])=>who(id,binding)+' 改用 '+item.current+'，'+clock(item.until)+' 換回 '+item.original).join('；'):'無';
  const failed=state.platformError?clock(state.platformError.since)+' 執行對話被平台錯誤中斷：'+String(state.platformError.text||'').slice(0,120)+'；2 分鐘內沒恢復就叫醒監督處理':'無';
  const lines=['# 監督儀表板','','更新時間：'+clock(now)+'（台北）','','## 監看','',
    '- 背景監看：'+(alive?'運作中':'已停止')+'（狀態 '+(state.phase||'—')+(paused?'，使用者暫停中':'')+'）',
    '- 執行對話最後一次交回進度：'+clock(state.lastRealEventAt)+'（'+ago(state.lastRealEventAt,now)+'）',
    '- 等監督處理：'+handling,'- 執行對話權限：'+permission,'- 限速換模型：'+models,'- 平台錯誤：'+failed];
  if(state.instruction){const due=state.instruction.sentAt+state.instruction.deadlineMs*((state.instruction.misses||0)+1);
    lines.push('- 等執行端回應的指示：'+state.instruction.what.slice(0,80)+'（期限 '+clock(due)+'）');}
  // Jay's decisions from the run ledger: the same list the supervisor asks in one go.
  const waiting=ledger.open||[],cell=value=>String(value??'').replace(/\|/g,'／').replace(/\s+/g,' ').slice(0,160);
  lines.push('','## 待你決定（'+waiting.length+' 項）','');
  if(ledger.error)lines.push('待決帳讀不到：'+ledger.error);
  else if(waiting.length)lines.push('| 要決定的事 | 推薦 | 為什麼要你決定 | 列給你的時間 |','|---|---|---|---|',
    ...waiting.map(item=>'| '+cell(item.ask)+' | '+cell(item.recommend)+' | '+(pending.KINDS[item.kind]||cell(item.kind))+' | '+(item.presentedAt?clock(Date.parse(item.presentedAt)):'還沒列')+' |'));
  else lines.push('目前沒有要你決定的事。');
  // A run started before the ledger: its free-text approvals until the supervisor registers what is still open.
  if(ledger.legacy)lines.push('','舊版決策記下、監督還沒重新登記的待核准：',...ledger.legacy.pendingApprovals.map(item=>'- '+cell(item)));
  lines.push('','## 驗收條件（共 '+items.length+' 條，通過 '+passed+'，未通過 '+open.length+'）','');
  if(items.length)lines.push('| 條件 | 狀態 |','|---|---|',...items.map(item=>'| '+item.id+' | '+item.status+' |'));
  else lines.push('派工快照還沒有逐條驗收狀態。');
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
  const file=path.join(run,FILE),body=require('./watch-health.cjs').withBanner(render({ledger:pending.view(run,args.state),...args}),run);
  fs.writeFileSync(file+'.tmp',body);fs.renameSync(file+'.tmp',file);
  return file;
}
module.exports={FILE,render,write};
