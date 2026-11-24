// Keep each answer tied to its assignment and each ruling tied to the submitted revision.
const fs = require('node:fs');
const path = require('node:path');
const {need, hash, read} = require('./guard.cjs');
const commits = require('./decision-commit.cjs');
const text = value => typeof value === 'string' && Boolean(value.trim());
const strings = values => Array.isArray(values) && values.every(text) && new Set(values).size === values.length;
const fileExists = file => text(file) && path.isAbsolute(file) && fs.statSync(file,{throwIfNoEntry:false})?.isFile();

function checkAnswers(item, list) {
  if (!item.questions) return;
  need(strings(item.questions) && item.questions.length, item.id+' needs distinct assigned questions');
  if (!['completed','returned'].includes(list)) return;
  const answers=item.answers;
  need(Array.isArray(answers) && answers.length===item.questions.length, item.id+' needs one answer per original question');
  for (const question of item.questions) {
    const rows=answers.filter(row=>row?.question===question);
    need(rows.length===1 && text(rows[0].finding), 'Missing or duplicate answer: '+question);
    const row=rows[0];
    need(Array.isArray(row.evidence) && row.evidence.length && row.evidence.every(fileExists), 'Each answer needs an existing evidence file: '+question);
    need(row.gap===undefined || typeof row.gap==='boolean', 'gap must be boolean');
    need(!row.gap || (list==='returned' && !item.integrated), 'Unresolved question cannot be integrated: '+question);
  }
}

function entries(snapshot) {
  return Object.entries(snapshot?.packages||{}).flatMap(([list,items])=>items.map(item=>({list,item})));
}
function validateSnapshot(value, previous, run, binding) {
  const before=new Map(entries(previous).map(({item})=>[item.id,item]));
  for(const {item,list} of entries(value)){
    const old=before.get(item.id);
    if(old?.components)need(Array.isArray(item.components) && item.components.length,'Deployment components missing: '+item.id);
    if(item.components && ['ready','inFlight'].includes(list))need(item.deployment && item.components.every(name=>item.deployment.some(row=>row.component===name)), 'Deployment target missing: '+item.id);
    if(item.deployment)need(Array.isArray(item.deployment) && item.deployment.length &&
      item.deployment.every(row=>row && ['component','runtime','identity','dependencies','configuration','verify'].every(key=>text(row[key])) && fileExists(row.source)),
      'Deployment needs the component, runtime, identity, dependencies, configuration, target verification and a source file: '+item.id);
    if(old?.questions) need(JSON.stringify(old.questions)===JSON.stringify(item.questions), 'Original assigned questions changed: '+item.id);
    checkAnswers(item,list);
    before.delete(item.id);
    const newRulings=(item.appliedRulings||[]).filter(row=>!old?.appliedRulings?.some(r=>r.eventId===row.eventId));
    for(const row of newRulings){
      const verified=delivered(run,binding,item.id,row);
      need(old?.submission?.revision===row.revision && old.submission.manifest===verified.event.manifest &&
        ['accepted','failed','remaining'].every(k=>JSON.stringify(row[k]||[])===JSON.stringify(verified.row[k]||[])),'Unverified or superseded package ruling: '+item.id);
      need(!open(row) || list!=='completed','Partial acceptance cannot close the package');
    }
    if(item.submission && JSON.stringify(old?.submission)!==JSON.stringify(item.submission)){
      const {revision,manifest}=item.submission;
      need(fileExists(manifest) && 'sha256:'+hash(manifest)===revision,'Submission must match its immutable manifest');
    }
    need(!item.submission || list!=='completed', 'A package awaiting a ruling cannot close');
    if(old?.submission && !item.submission) need(item.appliedRulings?.some(r=>r.revision===old.submission.revision),'Resolve the submitted revision before clearing it');
    for(const prior of old?.appliedRulings||[]) need(item.appliedRulings?.some(r=>JSON.stringify(r)===JSON.stringify(prior)), 'Applied ruling disappeared: '+item.id);
  }
  for(const item of before.values())need(!item.submission && !item.answers?.some(r=>r.gap),'Resolve open evidence or submission before removing '+item.id);
}
// A ruling with failed or remaining criteria leaves the package open.
const open=row=>Boolean(row.remaining.length||(row.failed||[]).length);
function delivered(run,binding,id,{eventId,revision}){
  const entry=commits.readSnapshot(run,eventId);
  need(entry && entry.contractSha256===binding.contractSha256, 'No committed ruling for this contract');
  const event=read(path.join(run,'review-event-'+eventId+'.json'));
  const receipt=read(path.join(run,'receipt-answer-'+eventId+'.json'));
  const digest=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  need(entry.eventSha256===digest(JSON.stringify(event)) && event.revision===revision && receipt.key==='answer-'+eventId &&
    receipt.target===binding.executorId && receipt.confirmed===true && receipt.promptSha256===digest(entry.decision.reply),'Ruling delivery or revision mismatch');
  const rows=entry.decision.packageRulings;
  const row=Array.isArray(rows) && rows.find(r=>r.id===id);
  need(row && strings(row.accepted) && strings(row.remaining) && strings(row.failed||[]) && new Set([...row.accepted,...row.remaining,...(row.failed||[])]).size===
    row.accepted.length+row.remaining.length+(row.failed||[]).length, '監督這筆裁決沒有 '+id+' 的逐包裁決：照裁決回覆的內容另起工作或重新送審，不要用 collect 套用這筆裁決');
  return {row,event};
}
function apply(run,binding,id,before,result){
  const {eventId,revision}=result.ruling;
  const {row,event}=delivered(run,binding,id,result.ruling);
  // Replaying an acknowledged delivery must not roll back a later stage or reapply acceptance updates.
  if(before.appliedRulings?.some(r=>r.eventId===eventId && r.revision===revision)){
    const snapshot=read(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'));
    const committed=entries(snapshot).find(entry=>entry.item.id===id)?.item;
    result.state=before;
    if(committed?.appliedRulings?.some(r=>r.eventId===eventId))result.updates=[];
    else need(committed?.submission?.revision===revision && !result.updates.some(u=>u.status==='PASS'&&!row.accepted.includes(u.id)),'Cannot replay updates on a different submission');
    return;
  }
  need(before.submission?.revision===revision && before.submission.manifest===event.manifest, 'Ruling is for a different package submission');
  need(!open(row) || !['completed','archived'].includes(result.state.list), 'Partial acceptance cannot close the package');
  need(!result.updates.some(update=>update.status==='PASS' && !row.accepted.includes(update.id)), 'Only accepted criteria can pass');
  delete result.state.submission;
  result.state.appliedRulings=[...(before.appliedRulings||[]),{eventId,revision,accepted:row.accepted,...(row.failed?.length?{failed:row.failed}:{}),remaining:row.remaining}];
}
module.exports={checkAnswers,validateSnapshot,apply,entries};
