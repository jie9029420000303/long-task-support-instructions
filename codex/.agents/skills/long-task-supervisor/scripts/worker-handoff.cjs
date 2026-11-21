const crypto=require('node:crypto');
const digest=ids=>crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');

function isUnreadable(error){
  try{return JSON.parse(error?.message).error?.code==='unreadable_encrypted_agent_task';}catch{return false;}
}

// The parent may fail before consuming even an interim message. Recover through a normal
// executor turn and the assigned worker's readable output, never by forwarding the encrypted item.
function workerHandoff(turn,mail,snapshot,agents,executorId){
  if(turn?.status!=='failed' || !turn.id || mail?.id!==turn.id || snapshot?.executorId!==executorId)return null;
  if(!isUnreadable(turn.error) && !(turn.error==null && mail.unreadable))return null;
  const sources=[];
  for(const [sender,envelope] of Object.entries(mail.senders||{})){
    const matches=agents.filter(a=>a.path===sender);
    if(matches.length!==1)continue;
    const agent=matches[0],entries=snapshot.packages||{};
    const packages=[...(entries.inFlight||[]),...(entries.returned||[]).filter(item=>!item.integrated)];
    const item=packages.find(row=>[sender,agent.id].includes((row.handle||'').replace(/^agent:/,'')));
    if(!envelope?.id || !Number.isFinite(envelope.at))continue;
    const sameTurn=agent.turnStartedAt && agent.turnStartedAt<=envelope.at &&
      (agent.active || agent.completedAt>=envelope.at);
    sources.push({message:envelope.id,receivedAt:new Date(envelope.at).toISOString(),packageId:item?.id||null,worker:agent.id,
      turn:sameTurn?(agent.completedTurnId||agent.turnId):null,
      // The envelope can arrive after the worker finished. Report the separately verified
      // completion even when its relationship to the envelope is unknown.
      latestFinishedTurn:!agent.active && item?agent.completedTurnId:null,
      finishedAt:!agent.active && item && agent.completedAt?new Date(agent.completedAt).toISOString():null,
      state:!sameTurn?'依收訊時間定位原回合':agent.active?'執行中':agent.done?'已交回，待核對':'已停止，待查原件'});
  }
  if(!sources.length)return null;
  sources.sort((a,b)=>a.message.localeCompare(b.message));
  return {workers:sources.map(s=>s.worker),finished:sources.filter(s=>s.finishedAt),key:'worker-handoff-'+digest(sources.map(s=>s.message)).slice(0,32),
    prompt:'子代理訊息未送達。依這些工作包與代理對話 ID，用 read_thread 核對該回合及工作包的交付檔、結果與證據。代理仍在做就接續其他工作，完成後由主線收件。確認包號、回合與交付原件後 collect。包號或回合待查時按收訊時間對原交辦。latestFinishedTurn 是可另外核對的最近結束回合，先比對包號與原件後收件。這次讀回用一般工具，不重送加密訊息、不重派、不重跑，也不據此判定驗收通過。\n'+JSON.stringify(sources)};
}
module.exports={workerHandoff,isUnreadable};
