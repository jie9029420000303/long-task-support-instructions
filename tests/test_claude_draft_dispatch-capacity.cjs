const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {derive,freeCapacity}=require('../claude-code/.claude/skills/long-task-supervisor/scripts/dispatch-audit.cjs');

function snapshot(handles,capacity=2){
  return {activity:'working',capacity:{verified:capacity},packages:{
    ready:[{id:'ready',independent:true,safe:true,dependencies:[],exclusiveResources:[]}],
    inFlight:handles.map((handle,i)=>({id:'active-'+i,handle,exclusiveResources:[]})),
    returned:[],blocked:[],completed:[],recurringRework:[]}};
}
function readyIssue(value){return derive(value).find(item=>item.kind==='ready_capacity');}

test('main and resource processes do not consume subagent seats',()=>{
  const s=snapshot(['main','resource:database']);
  assert.equal(freeCapacity(s),2);
  assert.equal(readyIssue(s).detail.freeCapacity,2);
});
test('actual and unrecognized agent handles consume seats conservatively',()=>{
  const s=snapshot(['main','resource:db','agent:a','workflow:run:pkg','unrecognized']);
  assert.equal(freeCapacity(s),0);
  assert.equal(readyIssue(s),undefined);
  assert.equal(freeCapacity(snapshot(['main','agent:a'])),1);
  assert.equal(freeCapacity(snapshot(['resource:'])),1);
});
test('main and resource work still block conflicting resources',()=>{
  for(const handle of ['main','resource:db']){
    const s=snapshot([handle]);
    s.packages.inFlight[0].exclusiveResources=[{key:'db:one',kind:'database'}];
    s.packages.ready[0].exclusiveResources=[{key:'db:one',kind:'database'}];
    assert.equal(freeCapacity(s),2);
    assert.equal(readyIssue(s),undefined);
  }
});
