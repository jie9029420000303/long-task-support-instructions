// Decisions waiting on Jay (Jay 2026-10-14:「這件事情不要留存在記憶中，就不會被壓縮了…每次產生新問題，就去確認下已經
// 存下的問題是否有重複」). 2026-10-13 GDB: one question reworded 7 ways in 13 decisions, 4 of 7 known items on one card and
// the other 3 on a second card while Jay was online, and a status pane that kept 2 decided items for 22 more decisions.
// The ledger is a program-kept run file, so dedup and "one card with everything" do not depend on chat memory.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const versions=[['claude-code','claude-code/.claude/skills/long-task-supervisor/scripts'],['codex','codex/.agents/skills/long-task-supervisor/scripts']]
  .map(([platform,dir])=>[platform,path.resolve(__dirname,'..',dir)]);
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
// The caller check reads the chat ID from the environment; each test sets it explicitly.
delete process.env.CLAUDE_SESSION_ID;delete process.env.CODEX_THREAD_ID;
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
const at=minute=>new Date(Date.UTC(2026,9,13,22,minute)).toISOString();
const item=(key,ask,extra={})=>({key,kind:'credential',ask,recommend:'A 兩個都重登',why:'驗證碼只有你收得到',...extra});
function fixture(platform){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-decisions-')),run=path.join(root,'run');fs.mkdirSync(run);
  const source=path.join(root,'jay-words.md');
  fs.writeFileSync(source,'Jay 2026-10-13 00:56: R24R21: A 兩個都重登\nJay 2026-10-11: 中間不要再停下來問我，代我回答所有執行對話\n');
  const contract={goal:'Finish',authorization:'Supervise until accepted',criteria:[{id:'A1',requirement:'Works',source:'spec',verify:'Run it'}],sources:[{path:source,sha256:sha(source)}]};
  save(path.join(run,'contract.json'),contract);
  const binding={platform,supervisorId:'supervisor-chat',executorId:'executor-chat',allowedRoots:[root],contractSha256:sha(path.join(run,'contract.json'))};
  save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'idle',pending:null,inflight:null});
  return {root,run,source,binding,ledger:path.join(run,'pending-decisions.json'),done(){fs.rmSync(root,{recursive:true,force:true});}};
}
test('both adapters ship the same ledger module',()=>{
  // If the copies drift, one platform re-asks or splits cards while the other does not.
  assert.deepEqual(fs.readFileSync(path.join(versions[0][1],'pending-decisions.cjs')),fs.readFileSync(path.join(versions[1][1],'pending-decisions.cjs')));
});
for(const [platform,scripts] of versions){
  const pending=require(path.join(scripts,'pending-decisions.cjs')),{append}=require(path.join(scripts,'contract-state.cjs'));
  const heard=quote=>{if(!['R24R21: A 兩個都重登','A','B','C'].includes(quote))throw Error('Answer quote did not reach the supervisor in this turn');};
  const change=(f,value,minute=0)=>pending.apply(f.run,value,{binding:f.binding,checkQuote:heard,at:at(minute)});

  test(platform+': only decisions that need Jay can be registered, and a mistyped change is refused',()=>{
    // 2026-10-13 GDB: 5 of the 9 items on Jay's cards were reversible choices the supervisor could make itself.
    const f=fixture(platform);
    try{
      assert.throws(()=>change(f,{raise:[item('webhook-fix','webhook 用 A/B/C 哪個修法？',{kind:'reversible'})]}),/kind must be one of/);
      assert.throws(()=>change(f,{raise:[item('webhook-fix','webhook 用 A/B/C 哪個修法？',{kind:undefined})]}),/kind must be one of/);
      assert.throws(()=>change(f,{raise:[item('r24','R24/R21 要怎麼驗？',{recommend:' '})]}),/needs recommend/);
      assert.throws(()=>change(f,{raise:[item('r24','R24/R21 要怎麼驗？',{why:undefined})]}),/needs why/);
      // A typo such as "raises" must fail loudly instead of silently registering nothing.
      assert.throws(()=>change(f,{raises:[item('r24','R24/R21 要怎麼驗？')]}),/only raise, reopen, withdraw or answer/);
      assert.equal(fs.existsSync(f.ledger),false,'refused changes write nothing');
      const out=change(f,{raise:[item('r24','R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？',{options:['A 兩個都重登','B 只重登 uat2','C 列已知缺口']})]});
      assert.deepEqual(out.raised,['r24']);
      const [saved]=out.open;
      assert.equal(saved.status,'open');assert.equal(saved.raisedAt,at(0));assert.equal(saved.presentedAt,null);
      assert.deepEqual(saved.options,['A 兩個都重登','B 只重登 uat2','C 列已知缺口']);
    }finally{f.done();}
  });

  test(platform+': the same question is never asked twice, whatever key or wording copy it comes back under',()=>{
    // GDB copied its pending list into 23 of 53 decisions and asked the 80-mail threshold twice within 9 minutes.
    const f=fixture(platform);
    try{
      const ask='R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？';
      change(f,{raise:[item('r24',ask)]},0);
      pending.shown(f.run,['r24'],{binding:f.binding,at:at(1)});
      const again=change(f,{raise:[item('r24',ask)]},2);
      assert.deepEqual(again.unchanged,['r24'],'an identical raise is not news');
      const stored=pending.load(f.run).items[0];
      assert.equal(stored.updatedAt,at(0));assert.equal(stored.history.length,0);
      assert.equal(pending.ask(f.run).repeat,true,'so it does not bring a new card');
      assert.throws(()=>change(f,{raise:[item('r24-uat3',' R24/R21 要 uat2、uat3 重新登入才能跑， 要怎麼驗？')]}),/already open as r24/);
      change(f,{answer:[{key:'r24',choice:'A',quote:'R24R21: A 兩個都重登'}]},3);
      // After Jay answered, neither a new key nor the old one may ask the same thing again without a new fact.
      assert.throws(()=>change(f,{raise:[item('r24-relogin-2',ask)]}),/already answered as r24; if a new fact changes it, reopen r24/);
      assert.throws(()=>change(f,{raise:[item('r24',ask)]}),/already answered; if a new fact changes the question, reopen it/);
      assert.throws(()=>change(f,{reopen:[{key:'r24'}]}),/new fact/);
      const reopened=change(f,{reopen:[{key:'r24',fact:'uat3 重登後仍是 needs-auth，A 已做過沒用',recommend:'C 列已知缺口'}]},4);
      assert.deepEqual(reopened.reopened,['r24']);
      assert.deepEqual(reopened.open.map(entry=>entry.key),['r24']);assert.equal(reopened.open[0].recommend,'C 列已知缺口');
      assert.deepEqual(reopened.closed,[]);assert.deepEqual(reopened.unpresented,['r24']);
      const [last]=pending.load(f.run).items[0].history.slice(-1);
      assert.equal(last.answer.quote,'R24R21: A 兩個都重登','the earlier answer stays on record');assert.match(last.fact,/needs-auth/);
    }finally{f.done();}
  });

  test(platform+': a card is stamped only when it listed every open item, and new items bring the whole list again',()=>{
    // GDB 22:11 carried 4 of 7 known items; the other 3 came on a second card at 00:58 while Jay was online.
    const f=fixture(platform);
    try{
      const keys=['k1','k2','k3','k4','k5','k6','k7'];
      change(f,{raise:keys.map(key=>item(key,'第 '+key+' 件要你決定的事'))},0);
      const first=pending.ask(f.run);
      assert.deepEqual(first.items.map(entry=>entry.key),keys);assert.deepEqual(first.new,keys);assert.equal(first.repeat,false);
      assert.deepEqual(pending.ask(f.run),first,'reading the list never stamps it');
      assert.throws(()=>pending.shown(f.run,['k1','k2','k3','k4'],{binding:f.binding,at:at(1)}),/missing k5, k6, k7/);
      assert.deepEqual(pending.ask(f.run).new,keys,'a subset card leaves every item still to ask');
      pending.shown(f.run,keys,{binding:f.binding,at:at(1)});
      assert.deepEqual(pending.ask(f.run).new,[]);assert.equal(pending.ask(f.run).repeat,true);
      change(f,{answer:['k1','k2','k3','k4'].map(key=>({key,quote:'A'}))},2);
      assert.deepEqual(pending.ask(f.run).items.map(entry=>entry.key),['k5','k6','k7']);
      assert.equal(pending.ask(f.run).repeat,true,'items already on the last card are not asked again');
      change(f,{raise:[item('k8','第 k8 件要你決定的事')]},3);
      const withNew=pending.ask(f.run);
      assert.deepEqual(withNew.items.map(entry=>entry.key),['k5','k6','k7','k8'],'the next card carries every open item, not just the new one');
      assert.deepEqual(withNew.new,['k8']);assert.equal(withNew.repeat,false);
      change(f,{raise:[item('k5','第 k5 件要你決定的事',{recommend:'B 先只做 uat2'})]},4);
      assert.deepEqual(pending.ask(f.run).new,['k5','k8'],'a changed item counts as new');
      change(f,{withdraw:[{key:'k6',reason:'修訂 AMEND-AUTH-OLD-R21 的「代我回答所有執行對話」涵蓋，監督自己決定'}]},5);
      assert.deepEqual(pending.ask(f.run).items.map(entry=>entry.key),['k5','k7','k8']);
      assert.throws(()=>pending.shown(f.run,['k1','k5','k7','k8'],{binding:f.binding}),/not open k1/);
      assert.throws(()=>pending.shown(f.run,['k5','k5','k7','k8'],{binding:f.binding}),/listed twice k5/);
    }finally{f.done();}
  });

  test(platform+": an answer is Jay's words, never the supervisor's reading of them",()=>{
    const f=fixture(platform);
    try{
      change(f,{raise:[item('r24','R24/R21 要怎麼驗？'),item('webhook','webhook 修法要用哪個？',{kind:'major_change'}),item('mail','寄信上限要多少？',{kind:'external'}),
        item('auth','執行中能不能自己重登？')]});
      assert.throws(()=>change(f,{answer:[{key:'r24',choice:'A'}]}),/needs Jay's words/);
      assert.throws(()=>change(f,{answer:[{key:'r24',quote:'Jay 說選 A'}]}),/did not reach the supervisor in this turn/);
      // A saved snapshot works later, like an amendment source: inside the allowed roots and still holding the words.
      const outside=fs.mkdtempSync(path.join(os.tmpdir(),'pending-outside-'));
      try{
        const copy=path.join(outside,'jay.md');fs.copyFileSync(f.source,copy);
        assert.throws(()=>change(f,{answer:[{key:'r24',quote:'R24R21: A 兩個都重登',source:{path:copy,sha256:sha(copy)}}]}),/outside allowed roots/);
      }finally{fs.rmSync(outside,{recursive:true,force:true});}
      assert.throws(()=>change(f,{answer:[{key:'r24',quote:'R24R21: B',source:{path:f.source,sha256:sha(f.source)}}]}),/quote is absent/);
      change(f,{answer:[{key:'r24',choice:'A',quote:'R24R21: A 兩個都重登',source:{path:f.source,sha256:sha(f.source)}}]});
      change(f,{answer:[{key:'mail',choice:'B',quote:'B'}]});
      assert.throws(()=>change(f,{answer:[{key:'webhook',amendmentId:'AMEND-NONE'}]}),/Unknown amendment AMEND-NONE/);
      append(f.run,f.binding,{id:'AMEND-AUTH-DELEGATE',contractSha256:f.binding.contractSha256,
        authority:{role:'user',quote:'中間不要再停下來問我，代我回答所有執行對話',at:'2026-10-11T02:00:00Z',locator:'Jay in the old supervisor chat',source:{path:f.source,sha256:sha(f.source)}},
        changes:[{action:'authorization',id:'answer-for-jay',scope:'all executor questions',instruction:'代我回答所有執行對話'}]});
      const binding=JSON.parse(fs.readFileSync(path.join(f.run,'binding.json'),'utf8'));
      assert.throws(()=>pending.apply(f.run,{answer:[{key:'webhook',amendmentId:'AMEND-AUTH-DELEGATE',quote:'A'}]},{binding,checkQuote:heard}),/one source/);
      const out=pending.apply(f.run,{answer:[{key:'webhook',amendmentId:'AMEND-AUTH-DELEGATE'}]},{binding,checkQuote:heard});
      assert.deepEqual(out.closed.map(entry=>[entry.key,entry.answer.choice,entry.answer.quote,entry.answer.amendmentId]),
        [['r24','A','R24R21: A 兩個都重登',null],['webhook',null,null,'AMEND-AUTH-DELEGATE'],['mail','B','B',null]]);
      assert.deepEqual(out.open.map(entry=>entry.key),['auth']);
    }finally{f.done();}
  });

  test(platform+': a bad change writes nothing',()=>{
    // A half-applied ledger would show Jay a list that no supervisor turn produced.
    const f=fixture(platform);
    try{
      change(f,{raise:[item('r24','R24/R21 要怎麼驗？'),item('mail','寄信上限要多少？')]});
      const before=fs.readFileSync(f.ledger);
      assert.throws(()=>change(f,{raise:[item('ok','新的一題'),item('bad','壞的一題',{kind:'reversible'})]}),/kind must be one of/);
      assert.throws(()=>change(f,{withdraw:[{key:'mail',reason:'授權涵蓋'}],answer:[{key:'r24',quote:'沒收到的話'}]}),/this turn/);
      assert.throws(()=>change(f,{raise:[item('r24','R24/R21 要怎麼驗？',{recommend:'B'})],withdraw:[{key:'r24',reason:'同一題'}]}),/once per change/);
      assert.deepEqual(fs.readFileSync(f.ledger),before);
    }finally{f.done();}
  });

  test(platform+': every wake sees the whole list, also from an old run or a damaged file',()=>{
    const f=fixture(platform);
    try{
      // Runs started before the ledger kept pending items in decisions (GDB as a full list, IA as a delta).
      const state={resolved:{e1:{decision:{pendingApprovals:['R24/R21 重登','刪除 34 筆']}},e2:{decision:{disposition:'observe'}},e3:{decision:{pendingApprovals:['刪除 34 筆','LEASE_SAFETY_MARGIN']}}}};
      assert.deepEqual(pending.view(f.run,state).legacy.pendingApprovals,['R24/R21 重登','刪除 34 筆','LEASE_SAFETY_MARGIN']);
      change(f,{raise:[]});
      assert.equal(pending.view(f.run,state).legacy,undefined,'once the supervisor registered the old items, the hint is gone');
      change(f,{raise:[item('r24','R24/R21 要怎麼驗？'),item('mail','寄信上限要多少？')]},1);
      change(f,{answer:[{key:'mail',choice:'B',quote:'B'}]},2);
      const seen=pending.view(f.run);
      assert.deepEqual(seen.open.map(entry=>entry.key),['r24']);assert.equal(seen.open[0].history,undefined);
      assert.deepEqual(seen.closed.map(entry=>[entry.key,entry.status,entry.answer.quote]),[['mail','answered','B']]);
      assert.deepEqual(seen.unpresented,['r24']);
      // A damaged file must not stop event handling, and must never be overwritten by the next change.
      fs.writeFileSync(f.ledger,'{"items":[');
      const damaged=pending.view(f.run);
      assert.match(damaged.error,/unreadable/);assert.deepEqual(damaged.open,[]);
      assert.throws(()=>change(f,{raise:[item('r25','R25 要怎麼驗？')]}),/unreadable/);
      assert.equal(fs.readFileSync(f.ledger,'utf8'),'{"items":[');
    }finally{f.done();}
  });

  test(platform+': only the supervisor chat writes the ledger',()=>{
    // The executor reads run files and runs the same scripts; it must not raise, withdraw or answer for Jay.
    const f=fixture(platform),variable=platform==='codex'?'CODEX_THREAD_ID':'CLAUDE_SESSION_ID';
    try{
      withEnv({[variable]:'executor-chat'},()=>{
        assert.throws(()=>change(f,{raise:[item('r24','R24/R21 要怎麼驗？')]}),/Only the original supervisor/);
        assert.equal(fs.existsSync(f.ledger),false);
      });
      withEnv({[variable]:'supervisor-chat'},()=>change(f,{raise:[item('r24','R24/R21 要怎麼驗？')]}));
      withEnv({[variable]:'executor-chat'},()=>{
        assert.deepEqual(pending.ask(f.run).new,['r24'],'reading is open to anyone');
        assert.throws(()=>pending.shown(f.run,['r24'],{binding:f.binding}),/Only the original supervisor/);
      });
    }finally{f.done();}
  });
}
