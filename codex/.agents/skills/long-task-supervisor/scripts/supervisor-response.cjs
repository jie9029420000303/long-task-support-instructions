// Model output acknowledges a review; only an explicitly submitted decision resolves it.
// Read the newest turn only: an older completed turn must not interrupt a current human discussion.
const TERMINAL=new Set(['completed','interrupted','failed','error']);
function millis(value){
  if(typeof value==='number'&&Number.isFinite(value))return value<1e12?value*1000:value;
  if(typeof value==='string'&&value.trim())return Date.parse(value);
  return NaN;
}
function closedWithoutDecision(detail,deliveredAt){
  const turn=detail?.turns?.[0],status=typeof turn?.status==='string'?turn.status:turn?.status?.type;
  const threadStatus=typeof detail?.thread?.status==='string'?detail.thread.status:detail?.thread?.status?.type;
  if(threadStatus==='active'||!turn?.id||!TERMINAL.has(status))return null;
  const completedAt=millis(turn.completedAt);
  if(!Number.isFinite(completedAt)||!Number.isFinite(deliveredAt)||completedAt<deliveredAt)return null;
  return {turnId:turn.id,status,completedAt:new Date(completedAt).toISOString()};
}
module.exports={closedWithoutDecision};
