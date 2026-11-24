// 關卡一 (Jay 2026-11-23; handoff V7 item 3): a release proposal answers three questions per item and the third, what
// the change replaces or removes, may not be blank. From v1.0.0 to v1.12.4 the skills gained 5,262 lines and lost
// 570 with no file ever removed; the check is what makes "what does this replace" a question every release answers.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const SCRIPT=path.resolve(__dirname,'..','maintenance','check-proposal.cjs');
const {check,growth}=require(SCRIPT);
const item=(n,{origin='收件判定的當下',missed='判定只寫在自由文字',replaces='刪除錯 3 換模型與錯 4 主線接手'}={})=>
  '## '+n+' 項目 '+n+'\n'+(origin===null?'':'- 事實最早在哪一步產生：'+origin+'\n')+(missed===null?'':'- 為什麼沒在那一步被記下或擋下：'+missed+'\n')+
  (replaces===null?'':'- 取代或刪掉哪個既有機制：'+replaces+'\n');

test('every numbered item answers all three questions; a blank third answer fails',()=>{
  assert.equal(check('# 提案\n\n'+item(1)+'\n'+item(2)).ok,true);
  const blank=check(item(1)+item(2,{replaces:''}));
  assert.equal(blank.ok,false);assert.deepEqual(blank.items.map(i=>i.ok),[true,false]);
  assert.match(blank.problems[0],/第 2 項沒回答：取代或刪掉哪個既有機制/);
  assert.match(check(item(1,{origin:null})).problems[0],/事實最早在哪一步產生/);
  // A trailing section without a number (implementation notes) is not an item and does not swallow the last answer.
  const tail=check(item(1)+'\n## 自行決定的實作細節\n\n- 取代或刪掉哪個既有機制：不是項目\n');
  assert.equal(tail.ok,true);assert.equal(tail.items.length,1);
  assert.equal(check('# 沒有項目\n').ok,false);
});

test('"only an addition" passes only with its reason written beside it',()=>{
  const bare=check(item(3,{replaces:'只能新增。'}));
  assert.equal(bare.ok,false);assert.match(bare.problems[0],/只寫了只能新增/);
  const reasoned=check(item(3,{replaces:'只能新增：repo 原本沒有改版流程，沒有既有機制可以取代'}));
  assert.equal(reasoned.ok,true);assert.equal(reasoned.items[0].onlyAdds,true);
});

test('the release lists how much the skills grew or shrank between two commits',t=>{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'proposal-growth-'));t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
  const put=(rel,text)=>{fs.mkdirSync(path.dirname(path.join(repo,rel)),{recursive:true});fs.writeFileSync(path.join(repo,rel),text);};
  git('init','-q');git('config','user.email','qa@example.org');git('config','user.name','qa');
  put('codex/.agents/skills/a/SKILL.md','one\ntwo\nthree\n');put('claude-code/.claude/skills/b/old.md','x\n');put('README.md','outside\n');
  git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD').trim();
  put('codex/.agents/skills/a/SKILL.md','one\n');put('codex/.agents/skills/a/new.md','n\n');fs.rmSync(path.join(repo,'claude-code/.claude/skills/b/old.md'));put('README.md','outside\nmore\n');
  git('add','-A');git('commit','-qm','next');
  assert.deepEqual(growth(repo,base),{base,head:'HEAD',linesAdded:1,linesRemoved:3,netLines:-2,filesAdded:1,filesRemoved:1});
});

test('the command exits 1 on a failing proposal and checks this release\'s own proposal shape',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proposal-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bad=path.join(dir,'bad.md'),good=path.join(dir,'good.md');
  fs.writeFileSync(bad,item(1,{replaces:''}));fs.writeFileSync(good,item(1));
  const run=file=>spawnSync(process.execPath,[SCRIPT,file],{encoding:'utf8'});
  const failed=run(bad);assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).ok,false);
  const passed=run(good);assert.equal(passed.status,0,passed.stderr);assert.equal(JSON.parse(passed.stdout).items[0].ok,true);
  assert.ok(fs.readFileSync(path.resolve(__dirname,'..','maintenance','改版流程.md'),'utf8').includes('check-proposal.cjs'),'the process document names the check');
});
