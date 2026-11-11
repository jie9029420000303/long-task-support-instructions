// v1.4.0 (Jay 2026-11-11): "執行端只就子代理交付成果做測試驗證，整套檢查是監督依照執行交付做一次。最後整套監督做一個大全套".
// WebRPA 11/11 ran its whole seven-stage gate 11 times over 5 versions, 6 of them from scratch; v0.14.0 r1 and r2
// differed by one test file and still re-ran for about 28 minutes. Its supervisor then planned to reuse the executor's
// v0.14.1 gate as the final full suite. These tests pin the split on both platforms so neither drifts back.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const CX='codex/.agents/skills/',CL='claude-code/.claude/skills/';
const PLATFORMS=[
  {name:'codex',supervisor:CX+'long-task-supervisor/',orchestrator:CX+'goal-orchestrator/',runner:'goal-orchestrator'},
  {name:'claude',supervisor:CL+'long-task-supervisor/',orchestrator:CL+'long-task-orchestrator/',runner:'long-task-orchestrator'},
];

test('the shared spec splits the work: affected scope in between, failed stages only, the supervisor runs the final full suite itself',()=>{
  const spec=read('SPEC.md');
  for(const copy of [CX+'goal-orchestrator/references/spec.md',CL+'long-task-orchestrator/references/spec.md'])assert.equal(read(copy),spec,copy);
  for(const marker of ['中途候選不跑整套','只重跑失敗的段或檔','不為一兩個檔整場重跑','監督依交付內容在監督自己的工作區重跑一次受影響的測試段',
    '受監督時由監督在自己的工作區親自跑、不沿用執行端結果','執行端不另跑最終整套','監督的測試不改執行端的檔案與工作樹','不是整套'])
    assert.ok(spec.includes(marker),marker);
  // The old wording let the executor run the final suite and the supervisor only read its log.
  assert.ok(!spec.includes('受監督時監督核對該紀錄、做突變抽查與主機讀回，不重跑整套'));
});

test('each supervisor reruns the affected stages of an interim delivery and runs the final suite itself in its own workspace',()=>{
  for(const p of PLATFORMS){
    const acceptance=read(p.supervisor+'references/acceptance.md');
    for(const marker of ['**測試分工**','只重跑失敗的段或檔','監督依交付內容在自己的工作區重跑一次受影響的測試段','不沿用執行端結果','不改執行端的檔案與工作樹','排他資源',
      p.runner+' 的 `scripts/test-run.py`','lockfile 沒變就不適用','只適用那一次'])
      assert.ok(acceptance.includes(marker),p.name+': '+marker);
    // WebRPA's supervisor cited a lockfile clause and two one-off approvals to demand the whole gate on every version.
    assert.ok(!acceptance.includes('監督不重跑整套'),p.name+': the supervisor runs the final suite');
    assert.ok(acceptance.indexOf('**測試分工**')<acceptance.indexOf('### 測試範圍與實際結果核對'),p.name);
    const skill=read(p.supervisor+'SKILL.md');
    for(const marker of ['最終候選的整套自動化測試由監督親自跑','執行端不另跑','中途版本不跑整套'])assert.ok(skill.includes(marker),p.name+': '+marker);
    const review=read(p.supervisor+'references/event-review.md');
    for(const marker of ['監督在自己的工作區重跑一次受影響的測試段','並先對乾淨匯出親自跑整套自動化測試'])assert.ok(review.includes(marker),p.name+': '+marker);
  }
});

test('each executor reruns only the failed stage and leaves the final suite to the supervisor when supervised',()=>{
  for(const p of PLATFORMS){
    const text=read(p.orchestrator+'SKILL.md')+read(p.orchestrator+'references/execution.md');
    for(const marker of ['只重跑失敗的段或檔','不是整套','受監督時由監督親自跑、主線不另跑','由監督親自跑整套自動化測試並分功能段落全套驗收','未受監督時，主線跑整套自動化測試'])
      assert.ok(text.includes(marker),p.name+': '+marker);
    assert.ok(!text.includes('監督核對這份紀錄、做突變抽查與主機讀回，不重跑整套'),p.name);
  }
});

test('behavioral case 65 is shared word for word and both adapters say how to check it',()=>{
  const common=read('tests/behavioral-cases.md').split('\n').find(line=>line.startsWith('65. '));
  assert.ok(common,'common case 65');
  for(const p of PLATFORMS){
    const row=read(p.orchestrator+'references/behavioral-cases.md').split('\n').find(line=>line.startsWith('| 65 |'));
    assert.ok(row,p.name);
    const cells=row.replace(/^\|\s*/,'').replace(/\s*\|$/,'').split(' | ');
    assert.equal(cells.length,3,p.name);
    assert.equal(cells[1],common.slice(4),p.name);
    assert.ok(cells[2].includes('監督工作區'),p.name);
  }
});
