'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../claude-code/.claude/skills/long-task-supervisor/scripts/supervise.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-preflight-'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const file = name => path.join(base, name);
const put = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value) + '\n');
const contentHash = value => hash(JSON.stringify(value) + '\n');
const source = file('source.txt');
fs.writeFileSync(source, 'synthetic source');
const contract = { goal: 'synthetic goal', authorization:'synthetic authorization',
  criteria:[{id:'A1',requirement:'requirement',source:'source',verify:'verify'}],
  sources:[{path:source,sha256:hash(fs.readFileSync(source))}] };
put('contract.json', contract);
const contractHash = hash(fs.readFileSync(file('contract.json')));
put('binding.json', {contractSha256:contractHash,allowedRoots:[base],executorId:'synthetic-executor'});
const event = {id:'event-1',kind:'question',text:'synthetic question'};
const state = {phase:'awaiting_decision',pending:event,resolved:{},seen:[]};
put('daemon-state.json', state);
const draft = {eventId:event.id,disposition:'reply',reply:'synthetic reply'};
put('draft.json', draft);
const command = (evhash=contentHash(event), chash=contractHash, statehash='-') =>
  spawnSync(process.execPath,[script,'decision-preflight',base,file('draft.json'),evhash,chash,statehash],{encoding:'utf8',timeout:10000});
const snapshot = () => Object.fromEntries(fs.readdirSync(base).sort().map(n => [n,hash(fs.readFileSync(file(n)))]));
function checked(cmd, expectedStatus) {
  const before=snapshot();const result=cmd();assert.equal(result.status,expectedStatus,result.stderr);assert.deepEqual(snapshot(),before,'preflight modified run files');return result;
}
try {
  const ok=checked(()=>command(),0);const result=JSON.parse(ok.stdout);
  assert.equal(result.eventId,event.id);assert.equal(result.eventSha256,contentHash(event));
  assert.equal(result.contractSha256,contractHash);assert.equal(result.contractStateSha256,null);
  assert.equal(result.messageSha256,hash('LONG_TASK_DELIVERY:'+event.id+'\n'+draft.reply));
  assert.equal(result.decisionSha256,hash(fs.readFileSync(file('draft.json'))));
  put('daemon-state.json',{...state,pending:{...event,text:'changed question'}});
  assert.match(checked(()=>command(),1).stderr,/event content changed/);
  put('daemon-state.json',{...state,pending:{...event,id:'event-2'}});
  assert.match(checked(()=>command(),1).stderr,/Pending event changed/);
  put('daemon-state.json',state);
  put('draft.json',{...draft,reply:''});assert.match(checked(()=>command(),1).stderr,/Missing specific reply/);
  put('draft.json',{...draft,delivery:{status:'queued'}});assert.match(checked(()=>command(),1).stderr,/must not contain a delivery/);
  put('draft.json',draft);
  assert.match(checked(()=>command(contentHash(event),'f'.repeat(64)),1).stderr,/Contract or authorization state changed/);
  assert.match(checked(()=>command(contentHash(event),contractHash,'e'.repeat(64)),1).stderr,/Contract or authorization state changed/);
  fs.writeFileSync(file('STOP'),'');assert.match(checked(()=>command(),1).stderr,/stopped or paused/);fs.unlinkSync(file('STOP'));
  fs.writeFileSync(file('PAUSED.json'),'{}');assert.match(checked(()=>command(),1).stderr,/stopped or paused/);fs.unlinkSync(file('PAUSED.json'));
  put('daemon-state.json',{...state,phase:'accepted'});assert.match(checked(()=>command(),1).stderr,/stopped or accepted/);
  put('daemon-state.json',state);put('draft.json',{...draft,reply:'changed reply'});
  const changed=JSON.parse(checked(()=>command(),0).stdout);assert.notEqual(changed.messageSha256,result.messageSha256);
  console.log('PASS: valid, same-ID event change, event replacement, malformed reply, premature receipt, contract mismatch, authorization-version mismatch, STOP, pause, accepted run, changed message; each preflight read-only.');
} finally { fs.rmSync(base,{recursive:true,force:true}); }
