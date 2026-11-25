// v1.12.5 (Jay 2026-11-23, Q68「A 跟 C都做」): an account whose OpenCodex 自訂門檻 is set must stop being used once
// its weekly use reaches that number, and come back after its weekly reset. What each test pins: only accounts with
// their own threshold are paused; an account Jay paused is never resumed by the program; an account Jay resumed himself
// is not paused again before its reset; an unreadable account is left alone; a stopped account counts at 0% in the
// supervisor reserve so the executor leaves the Claude subscription instead of crowding the supervisor.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const quota=require(path.join(scripts,'claude-quota.cjs'));
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  const restore=()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;};
  return Promise.resolve().then(fn).finally(restore);
}
// The 2026-11-23 21:40 accounts: jay@xplorx (no own threshold), a***e (70, paused by Jay), b***e (50), jjdigi (none).
function reading(now,{b=52,bPaused=false,jay=2,small=23,bReset=now+DAY,wwPaused=true,wwReset=now+2*DAY}={}){
  return {accounts:[
    {provider:'anthropic',id:'jay',label:'jay@xplorx.co',plan:'max_20x',paused:false,autoSwitchThresholdOverride:null,quota:{weeklyPercent:jay,weeklyResetAt:now+7*DAY}},
    {provider:'anthropic',id:'ww',label:'a***e@wwinno.com',plan:'max_20x',paused:wwPaused,autoSwitchThresholdOverride:70,quota:{weeklyPercent:61,weeklyResetAt:wwReset}},
    {provider:'anthropic',id:'bb',label:'b***e@xplorx.co',plan:'max_20x',paused:bPaused,autoSwitchThresholdOverride:50,quota:{weeklyPercent:b,weeklyResetAt:bReset}},
    {provider:'anthropic',id:'jj',label:'j***y@jjdigi.com.tw',plan:'max_5x',paused:false,autoSwitchThresholdOverride:null,quota:{weeklyPercent:small,weeklyResetAt:now+4*DAY}}]};
}
function fakeOcx(root,{fail=false}={}){
  const log=path.join(root,'ocx-calls.jsonl'),bin=path.join(root,'ocx');
  fs.writeFileSync(bin,'#!/usr/bin/env node\n'+(fail?'process.stderr.write("boom");process.exit(3);\n':'')+
    'require("fs").appendFileSync('+JSON.stringify(log)+',JSON.stringify(process.argv.slice(2))+"\\n");\n');
  fs.chmodSync(bin,0o755);
  return {bin,calls:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}

test('only an account with its own threshold is paused, and only once its weekly use reaches it',()=>{
  const now=Date.now(),empty={accounts:{}};
  assert.deepEqual(quota.planStops(reading(now,{b:49}),empty,now),[],'49% is under the 50% line');
  const at=quota.planStops(reading(now,{b:50}),empty,now);
  assert.deepEqual(at.map(a=>[a.type,a.id,a.line]),[['pause','bb',50]],'50% used is the line Jay asked for: half left');
  assert.deepEqual(quota.planStops(reading(now,{b:30,jay:99,small:99}),empty,now),[],'accounts without their own threshold are never paused, whatever the pool-wide threshold');
  assert.deepEqual(quota.planStops(reading(now,{b:100,bPaused:true}),empty,now),[],'an account already paused by someone else is left alone');
  const unreadable=reading(now);delete unreadable.accounts[2].quota.weeklyPercent;
  assert.deepEqual(quota.planStops(unreadable,empty,now),[],'an unreadable weekly use is neither a reason to pause nor to resume');
  const stale=reading(now,{bReset:now-MINUTE});
  assert.deepEqual(quota.planStops(stale,empty,now),[],'a reading from a week that already ended is not current');
});

test('a paused account is resumed after its weekly reset; one Jay paused never is, and one Jay resumed stays in use until its reset',()=>{
  const now=Date.now();
  const ours={accounts:{bb:{state:'paused',label:'b',line:50,pausedAt:now-HOUR,resetAt:now+DAY}}};
  assert.deepEqual(quota.planStops(reading(now,{bPaused:true}),ours,now),[],'before the reset it stays paused');
  assert.deepEqual(quota.planStops(reading(now+DAY,{bPaused:true,b:0,bReset:now+8*DAY}),ours,now+DAY).map(a=>a.type),['resume']);
  assert.deepEqual(quota.planStops(reading(now+3*DAY,{b:0,wwReset:now+2*DAY}),{accounts:{}},now+3*DAY),[],'a***e was paused by Jay: past its reset it is still not resumed');
  const released=quota.planStops(reading(now,{bPaused:false,b:60}),ours,now);
  assert.deepEqual(released.map(a=>[a.type,a.until]),[['released',now+DAY]],'Jay resumed it himself: it is not paused again');
  assert.deepEqual(quota.planStops(reading(now,{b:70}),{accounts:{bb:{state:'released',until:now+DAY}}},now),[],'still before its reset: left in use');
  const justPaused={accounts:{bb:{state:'paused',pausedAt:now-10000,resetAt:now+DAY}}};
  assert.deepEqual(quota.planStops(reading(now,{bPaused:false}),justPaused,now),[],'a reading taken at the moment of the pause is not mistaken for Jay resuming it');
});

test('the watcher pauses through OpenCodex, records it for both runs, counts the account at 0% and resumes it after the reset',async()=>{
  const now=Date.now(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'account-stop-')));
  try{
    const ocx=fakeOcx(root),file=path.join(root,'quota.json'),ledger=path.join(root,'stops.json');
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file,OPENCODEX_OCX_BIN:ocx.bin,LONG_TASK_ACCOUNT_STOPS_FILE:ledger},async()=>{
      save(file,reading(now,{b:52}));
      const state={};
      assert.equal(await quota.refresh(state,now),true);
      assert.deepEqual(ocx.calls(),[['account','pause','anthropic','bb']]);
      assert.equal(read(ledger).accounts.bb.state,'paused');
      // jay 2% (x4), b***e stopped 0% (x4), jjdigi 23% used (x1): (98*4+0*4+77)/9
      assert.equal(state.claudeQuota.weeklyRemaining,52.1,'the stopped account still counts, at 0% remaining');
      assert.match(quota.describe(state.claudeQuota),/b\*\*\*e@xplorx\.co 週用量到自訂門檻 50%，已暫停到 .* 重置/);
      const other={};
      save(file,reading(now+MINUTE,{b:53,bPaused:true}));
      await quota.refresh(other,now+MINUTE);
      assert.equal(ocx.calls().length,1,'the other run reads the same ledger and does not pause or resume again');
      assert.equal(other.claudeQuota.weeklyRemaining,52.1);
      save(file,reading(now+DAY+MINUTE,{b:0,bPaused:true,bReset:now+8*DAY}));
      await quota.refresh(state,now+DAY+MINUTE);
      assert.deepEqual(ocx.calls().at(-1),['account','resume','anthropic','bb']);
      assert.deepEqual(read(ledger).accounts,{},'after the resume nothing is left recorded');
      assert.equal(ocx.calls().some(call=>call.includes('ww')),false,'the account Jay paused was never touched');
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a failed pause leaves nothing recorded and is reported; a test without a stand-in command never changes OpenCodex',async()=>{
  const now=Date.now(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'account-stop-')));
  try{
    const ocx=fakeOcx(root,{fail:true}),file=path.join(root,'quota.json'),ledger=path.join(root,'stops.json');
    save(file,reading(now,{b:55}));
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file,OPENCODEX_OCX_BIN:ocx.bin,LONG_TASK_ACCOUNT_STOPS_FILE:ledger},async()=>{
      const state={};await quota.refresh(state,now);
      assert.equal(fs.existsSync(ledger),false);
      assert.match(quota.describe(state.claudeQuota),/b\*\*\*e@xplorx\.co 暫停失敗/);
      assert.equal(state.claudeQuota.weeklyRemaining,72.1,'not paused: counted at its real remainder, (98*4+45*4+77)/9');
    });
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file,OPENCODEX_OCX_BIN:undefined,LONG_TASK_ACCOUNT_STOPS_FILE:ledger},async()=>{
      const state={};await quota.refresh(state,now);
      assert.match(quota.describe(state.claudeQuota),/測試沒有指定 OpenCodex 指令/);
      assert.equal(fs.existsSync(ledger),false);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('a stopped account is judged again by its current threshold: raised above its use, or cleared, it is resumed at once and the new line applies',async()=>{
  // Jay 2026-11-26: he raised b***e from 50 to 80 in OpenCodex while it was paused at 51%, and it stayed paused until its reset.
  const now=Date.now();
  const ours={accounts:{bb:{state:'paused',label:'b',line:50,weeklyUsed:51,pausedAt:now-HOUR,resetAt:now+DAY}}};
  const raised=(line,b=51)=>{const value=reading(now,{bPaused:true,b});value.accounts[2].autoSwitchThresholdOverride=line;return value;};
  assert.deepEqual(quota.planStops(raised(80),ours,now).map(a=>[a.type,a.id]),[['resume','bb']],'51% used is under the new 80% line');
  assert.deepEqual(quota.planStops(raised(null),ours,now).map(a=>a.type),['resume'],'a cleared threshold leaves no line to stop at');
  assert.deepEqual(quota.planStops(raised(51),ours,now),[],'raised only to the use it already reached: still at the line');
  assert.deepEqual(quota.planStops(raised(50),ours,now),[],'the same line: stays paused until its reset');
  const unreadable=raised(80);delete unreadable.accounts[2].quota.weeklyPercent;
  assert.deepEqual(quota.planStops(unreadable,ours,now),[],'an unreadable weekly use is no reason to resume');
  assert.equal(quota.planStops(raised(80),ours,now).some(a=>a.id==='ww'),false,'a***e, paused by Jay under its 70% line, is still not touched');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'account-stop-')));
  try{
    const ocx=fakeOcx(root),file=path.join(root,'quota.json'),ledger=path.join(root,'stops.json');
    save(ledger,ours);
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file,OPENCODEX_OCX_BIN:ocx.bin,LONG_TASK_ACCOUNT_STOPS_FILE:ledger},async()=>{
      save(file,raised(80));
      const state={};await quota.refresh(state,now);
      assert.deepEqual(ocx.calls(),[['account','resume','anthropic','bb']]);
      assert.deepEqual(read(ledger).accounts,{},'the stop record is dropped');
      assert.equal(state.claudeQuota.weeklyRemaining,73.9,'counted at its real remainder again: (98*4+49*4+77)/9');
      assert.doesNotMatch(quota.describe(state.claudeQuota),/b\*\*\*e@xplorx\.co 週用量到自訂門檻/);
      save(file,reading(now+HOUR,{b:80,bReset:now+DAY}));
      const file80=read(file);file80.accounts[2].autoSwitchThresholdOverride=80;save(file,file80);
      await quota.refresh(state,now+HOUR);
      assert.deepEqual(ocx.calls().at(-1),['account','pause','anthropic','bb'],'the new 80% line stops it when reached');
      assert.equal(read(ledger).accounts.bb.line,80);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

