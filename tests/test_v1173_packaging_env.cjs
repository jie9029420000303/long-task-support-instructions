// v1.17.3 (Jay 2026-11-26): "建docker在我本機沒差，如果是為了部署Staging要先有映像的話，重點是城市跟驗收功能不能在測試環境以外的環境測試"
// ("城市" is voice input for "程式"). The environment rules only said "換環境要問" without saying what an environment is,
// and changing it was missing from the "仍要問" list. On 11/26 the 工區E supervisor first delegated building the image
// on the Mac as an out-of-scope direction choice (01:40), then treated that same packaging as opening a new environment
// and halted it (01:56). These tests pin both halves on both platforms: packaging is not an environment change, and
// moving programs or acceptance tests off the contract's environment table is always asked, even with a recommendation.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const CX='codex/.agents/skills/',CL='claude-code/.claude/skills/';
const SUPERVISORS=[CX+'long-task-supervisor/',CL+'long-task-supervisor/'];

test('the shared spec defines an environment as where programs run and are tested, so packaging anywhere is not a change',()=>{
  const spec=read('SPEC.md');
  for(const copy of [CX+'goal-orchestrator/references/spec.md',CL+'long-task-orchestrator/references/spec.md'])assert.equal(read(copy),spec,copy);
  for(const marker of ['環境指程式實際跑起來、做測試的地方','在哪台機器打包都不算換環境','部署前核對兩端映像摘要相同','打包的機器不啟動也不測試這個映像','有推薦也不代決'])
    assert.ok(spec.includes(marker),marker);
});

test('each supervisor asks before moving programs or acceptance tests off the environment table, and never for packaging',()=>{
  for(const dir of SUPERVISORS){
    const authorization=read(dir+'references/authorization.md');
    const stillAsk=authorization.slice(authorization.indexOf('仍要停下來問使用者'));
    assert.ok(stillAsk.includes('**把程式或驗收測試改到契約環境表以外的環境跑**'),dir+': the move is on the still-ask list');
    assert.ok(stillAsk.includes('只為部署測試環境而打包映像不算'),dir+': packaging is excluded from it');
    const acceptance=read(dir+'references/acceptance.md');
    for(const marker of ['這裡的「環境」指程式實際跑起來、做測試的地方','在哪台機器打包都不算換環境，不必問使用者','屬[「仍要問」](authorization.md#長任務預設類別授權)','有推薦也不代決','打包後不在本機啟動或測試'])
      assert.ok(acceptance.includes(marker),dir+': '+marker);
    assert.ok(!acceptance.includes('真的需要換環境或另開環境時'),dir+': the old undefined wording is gone');
  }
});

test('the execution guide lets the main line package locally without starting the image there',()=>{
  const execution=read(CX+'goal-orchestrator/references/execution.md');
  assert.ok(execution.includes('只為部署測試環境在本機打包映像不算換環境，打包後不在本機啟動或測試'));
});
