'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const base=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'approval-behavior-'));process.env.CODEX_HOME=tmp;
const id='test-thread',dir=path.join(tmp,'sessions','2026','11','02');fs.mkdirSync(dir,{recursive:true});const log=path.join(dir,'rollout-2026-11-02T000000-'+id+'.jsonl');
const now=new Date().toISOString();fs.writeFileSync(log,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
const binding={executorId:id,supervisorId:'supervisor',createdAt:now};
const state={executorSettings:{approvalPolicy:'on-request',reviewer:'auto_review',at:now},lastHealthAt:Date.now(),lastAutomationCheckAt:Date.now(),lastRealEventAt:Date.now(),lastExecutorActivityAt:Date.now(),lastExecutorWorkAt:Date.now(),lastDecisionAt:Date.now()};
function check(){const file=path.join(base,'supervisor-clock.cjs');delete require.cache[require.resolve(file)];return require(file).check(tmp,binding,state);}
function append(row){fs.appendFileSync(log,JSON.stringify({timestamp:now,...row})+'\n');}
let result=check();assert.ok(!result?.reasons.includes('permission_review'),'review mode alone must not create a rejection event');
append({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-a',arguments:JSON.stringify({cmd:'git push'})}});
append({type:'response_item',payload:{type:'function_call_output',call_id:'call-a',output:'rejected due to unacceptable risk\nReason: example review refusal'}});
result=check();assert.ok(result?.reasons.includes('permission_review'),'actual refusal must wake supervisor');assert.equal(result.permission.newRejections.length,1);assert.equal(result.permission.newRejections[0].source.path,log);assert.equal(result.permission.newRejections[0].source.callId,'call-a');assert.match(result.permission.newRejections[0].source.outputSha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(result.permission).includes('example review refusal'),'raw refusal remains in source log only');
result=check();assert.ok(!result?.reasons.includes('permission_review'),'same refusal must not repeat');
append({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-b',arguments:JSON.stringify({cmd:'docker build'})}});
append({type:'response_item',payload:{type:'function_call_output',call_id:'call-b',output:'rejected due to unacceptable risk\nReason: another refusal'}});
state.executorSettings=null;result=check();assert.ok(result?.reasons.includes('permission_review'),'actual refusal must not be lost when mode is unknown');
const render=require(path.join(base,'dashboard.cjs')).render;const text=render({binding,state:{executorSettings:{approvalPolicy:'on-request'},phase:'watching'},snapshot:null,paced:{packages:[]},alive:true,paused:false});assert.ok(!text.includes('會被平台擋下'));assert.ok(text.includes('不是完全存取，監督會請你切換一次'),'Jay 2026-11-09 keeps executors on full access: the page says so, without claiming a block');assert.ok(text.includes('依實際審查結果'));
// The scanner is only a lead: a tool can quote denial text, so the dashboard must not assert rejection.
append({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-c',arguments:JSON.stringify({cmd:'cat example'})}});
append({type:'response_item',payload:{type:'function_call_output',call_id:'call-c',output:'Documentation example: Auto-review denied'}});
result=check();assert.ok(result?.reasons.includes('permission_review'),'quoted text can be a scanner candidate');
const quoted=render({binding,state,snapshot:null,paced:{packages:[]},alive:true,paused:false});assert.ok(!quoted.includes('已被擋'));assert.ok(quoted.includes('疑似審查拒絕紀錄'));
// A quoted candidate must not hide a later true denial from the same work item.
append({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-d',arguments:JSON.stringify({cmd:'cat example'})}});
append({type:'response_item',payload:{type:'function_call_output',call_id:'call-d',output:'rejected due to unacceptable risk\nReason: actual subsequent refusal'}});
result=check();assert.ok(result?.reasons.includes('permission_review'));assert.equal(result.permission.newRejections[0].callId,'call-d');
const review=fs.readFileSync(path.join(base,'../references/event-review.md'),'utf8');assert.ok(review.includes('文字可能只是引用'));assert.ok(review.includes('只見引用或證據不足時記 `observe`'));assert.ok(review.includes('沒有新事實不重問'));
console.log('PASS: auto-review mode alone, actual refusal and source locator, deduplication, unknown mode, neutral dashboard, quoted candidate requires verification');
