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
// What the model has done in the newest turn, apart from messages sent to it: which turn, how many items, the last one.
// A working turn adds commands and reasoning long before it writes a message (2026-11-17, zone E supervisor: in the 45
// seconds after a review arrived its running turn gained three finished commands while its last message stayed the
// same, and the watcher told it "no model output detected").
function activityMarker(detail){
  const turn=detail?.turns?.[0];if(!turn?.id)return null;
  const items=(turn.items||[]).filter(item=>item?.type!=='userMessage'),last=items.at(-1);
  return JSON.stringify([turn.id,items.length,last?.id||last?.type||null]);
}
// Why the missed-start reminder must not go out: the chat is running a turn, or its newest turn holds work that was
// not there when the review was armed. null means nothing has moved. An armed record written before this check
// existed has no marker; then only the two status checks apply.
function working(detail,armedActivity){
  const turn=detail?.turns?.[0],status=typeof turn?.status==='string'?turn.status:turn?.status?.type;
  const threadStatus=typeof detail?.thread?.status==='string'?detail.thread.status:detail?.thread?.status?.type;
  if(threadStatus==='active')return 'thread_active';
  if(turn?.id&&status&&!TERMINAL.has(status))return 'turn_in_progress';
  if(armedActivity!==undefined&&activityMarker(detail)!==armedActivity)return 'new_activity';
  return null;
}
module.exports={closedWithoutDecision,activityMarker,working};
