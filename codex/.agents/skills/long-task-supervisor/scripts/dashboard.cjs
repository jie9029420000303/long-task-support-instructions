// A plain-language page the supervisor opens beside its chat at start (Jay 2026-10-11). The model-free watcher
// rewrites it at most once a minute, so looking at progress never wakes a model or costs a turn.
const fs=require('node:fs'),path=require('node:path');
const FILE='監督儀表板.md';
const clock=ms=>ms?new Date(ms).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const ago=(ms,now)=>ms?Math.max(0,Math.round((now-ms)/60000))+' 分鐘前':'—';
const OPEN=['FAIL','PENDING','INCONCLUSIVE','BLOCKED'];
const who=(id,binding)=>id===binding.executorId?'執行對話':id===binding.supervisorId?'監督對話':'子代理 '+id.slice(0,8);
function render({binding,state,snapshot,paced,alive,paused,now=Date.now()}){
  const items=snapshot?.acceptance?.items||[],passed=items.filter(item=>item.status==='PASS').length;
  const open=items.filter(item=>OPEN.includes(item.status)),settings=state.executorSettings;
  const autoReview=settings?.approvalPolicy&&settings.approvalPolicy!=='never';
  const switched=Object.entries(state.modelSwitch||{}).filter(([,item])=>!item.restored);
  const hours=Math.max(0,(now-(Date.parse(binding.createdAt)||now))/3600000);
  const perHour=passed&&hours>0?passed/hours:0;
  const pending=state.pending?state.pending.id+'（'+state.pending.kind+(state.pending.reasons?'：'+state.pending.reasons.join('、'):'')+'）':'無';
  const permission=!settings?'尚未讀到':autoReview?'自動審查（Git、遠端連線等操作會被平台擋下，需在該對話切成「完全存取」）':'完全存取';
  const models=switched.length?switched.map(([id,item])=>who(id,binding)+' 改用 '+item.current+'，'+clock(item.until)+' 換回 '+item.original).join('；'):'無';
  const lines=['# 監督儀表板','','更新時間：'+clock(now)+'（台北）','','## 監看','',
    '- 背景監看：'+(alive?'運作中':'已停止')+'（狀態 '+(state.phase||'—')+(paused?'，使用者暫停中':'')+'）',
    '- 執行對話最後一次交回進度：'+clock(state.lastRealEventAt)+'（'+ago(state.lastRealEventAt,now)+'）',
    '- 等監督處理：'+pending,'- 執行對話權限：'+permission,'- 限速換模型：'+models];
  if(state.instruction){const due=state.instruction.sentAt+state.instruction.deadlineMs*((state.instruction.misses||0)+1);
    lines.push('- 等執行端回應的指示：'+state.instruction.what.slice(0,80)+'（期限 '+clock(due)+'）');}
  lines.push('','## 驗收條件（共 '+items.length+' 條，通過 '+passed+'，未通過 '+open.length+'）','');
  if(items.length)lines.push('| 條件 | 狀態 |','|---|---|',...items.map(item=>'| '+item.id+' | '+item.status+' |'));
  else lines.push('派工快照還沒有逐條驗收狀態。');
  lines.push('','## 在途工作','');
  if(paced.packages.length)lines.push('| 工作包 | 已跑（分） | 預估（分） | 比值 |','|---|---|---|---|',
    ...paced.packages.map(item=>'| '+item.id+' | '+(item.elapsedMinutes??'—')+' | '+(item.baselineMinutes??'未填')+' | '+(item.ratio??'—')+' |'));
  else lines.push('目前沒有在途工作包。');
  lines.push('','## 預估完成','');
  if(perHour&&open.length)lines.push('約 '+Math.round(open.length/perHour*10)/10+' 小時。算法：開工 '+Math.round(hours*10)/10+' 小時通過 '+passed+' 條，每小時約 '+
    Math.round(perHour*100)/100+' 條；剩 '+open.length+' 條 ÷ 每小時條數。不含等你核准或外部結果的時間。');
  else lines.push(open.length?'還沒有任何條件通過，無法用實測速度推估。':'所有條件都已通過，或尚未建立驗收表。');
  return lines.join('\n')+'\n';
}
function write(run,args){
  const file=path.join(run,FILE),body=render(args);
  fs.writeFileSync(file+'.tmp',body);fs.renameSync(file+'.tmp',file);
  return file;
}
module.exports={FILE,render,write};
