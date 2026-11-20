// v1.9.0 (Jay 2026-11-19: Q19-A, Q20-A, Q22-A; 2026-11-18: "監督任務就是專注目標任務達成，系統的事情不要管").
// On 2026-11-18 a real-site order lookup failed four live tests out of five, 2 hours 47 minutes from the first failure
// to the pass, and nobody searched outside once; three executors searched six times in five days. On 2026-11-19 one
// run area held 1,297 delivered work-package folders (78.5 GiB, 19 GiB more each day) whose 39,727 PDFs were about 67
// distinct files, and the system temp folder had 12,291 test leftovers twelve hours after a reboot. The programs are
// tested in test_v190_task_focus.cjs and test_v190_workdir_tmp.py; these tests pin the rules that tell an agent to use
// them, on both platforms, so that a rule cannot name a command the ledger does not have and neither adapter drifts.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const CX='codex/.agents/skills/',CL='claude-code/.claude/skills/';
const PLATFORMS=[
  {name:'codex',supervisor:CX+'long-task-supervisor/',orchestrator:CX+'goal-orchestrator/'},
  {name:'claude',supervisor:CL+'long-task-supervisor/',orchestrator:CL+'long-task-orchestrator/'},
];
const FOUR='失敗證據、已排除原因、外部來源連結與查閱時間、小實驗結果';

test('the shared spec carries the five v1.9.0 rules and both adapters hold the same copy',()=>{
  const spec=read('SPEC.md');
  for(const marker of [
    '同一工作包第 2 次被退回重做',FOUR+'四項','第 1 次退回與不涉及技術判斷的小修不強制','第 4 次由執行主線接手','監督只在送驗時核對四項證據',
    '電腦睡眠不叫醒監督、不通知使用者','等待只因執行端自己重新開始工作而解除時只記錄、不查核','監督對話正在回合中或事件送出後已有新動作',
    '以檔案系統的寫入時複製複本取用，不整份複製','主線刪除其中可重建的過程檔','未通過或主線接手者不刪',
    '已通過卻未清理也未寫明無可刪原因的工作資料夾須先處理','寫在該工作包自己的暫存資料夾','仍有程序使用者不刪，系統暫存區裡不屬本任務的內容不碰',
    '32. 專注任務、不監看整機資源','不因此通知使用者、停工、減派或延後派工','使用者設定的固定名額',
  ])assert.ok(spec.includes(marker),'SPEC: '+marker);
  // The sentence v1.8.0 and earlier used to tell the user about a closed lid must not come back beside the new one.
  assert.ok(!spec.includes('或電腦睡眠時，直接通知使用者'),'SPEC still tells the user about sleep');
  for(const p of PLATFORMS)assert.equal(read(p.orchestrator+'references/spec.md'),spec,p.name+' spec copy');
});

test('a second return sends the main line outside for a fix before it redoes the package, on both platforms',()=>{
  for(const p of PLATFORMS){
    const skill=read(p.orchestrator+'SKILL.md');
    for(const marker of ['**第 2 次退回先向外找解法**','recurringRework 達 2','同一個問題修過後又失敗','官方文件、上游 GitHub 問題單與原始碼、相關開源專案的做法、技術論壇',
      '每筆附連結與查閱時間','在本案環境確認候選解法確實消除這個失敗','查不到可行解法也照實交回','第 1 次退回，以及錯字、設定值這類不涉及技術判斷的小修不強制',
      '錯 4：由執行主線接手','主線自行安排研究和小實驗'])assert.ok(skill.includes(marker),p.name+' SKILL: '+marker);
    // The rule sits with the error ladder it extends: after the third error and before the per-line counting.
    const at=skill.indexOf('**第 2 次退回先向外找解法**');
    assert.ok(at>skill.indexOf('3. 錯 3')&&at<skill.indexOf('A 查核、B 技術、C 研究、介面操作各自計數'),p.name+': placed with the error ladder');
    const execution=read(p.orchestrator+'references/execution.md');
    assert.ok(execution.includes('派研究子代理向外找解法')&&execution.includes(FOUR+'四項'),p.name+' execution: research on recurring rework');
    assert.ok(!execution.includes('停止原樣重跑，等監督指定新做法。'),p.name+' execution: the old wait-for-the-supervisor wording is gone');
    for(const file of ['references/dispatch.md','references/event-review.md']){
      const text=read(p.supervisor+file);
      assert.ok(text.includes(FOUR)&&text.includes('不自己做技術研究'),p.name+' supervisor '+file);
    }
    assert.ok(read(p.supervisor+'references/dispatch.md').includes('監督督促執行主線啟動外研'),p.name+': second reject asks for it');
  }
});

test('work-package folders and test temp files have an owner, and every command the rules name exists in the ledger',()=>{
  for(const p of PLATFORMS){
    const skill=read(p.orchestrator+'SKILL.md'),ledger=path.join(ROOT,p.orchestrator,'scripts/resource-ledger.py');
    for(const marker of ['**工作包資料夾回收**','cp -c','不整份複製','--workdir <路徑> --keep <樣式>','prune --state … --wp <id> -- <過程檔…>','--none --reason <原因>',
      'FAIL、主線接手或還沒判定的一律不刪','check --final','**任務自己的暫存**','resource-ledger.py tmpdir --state','TMPDIR=','stop --wp <id>',
      '還有程序在用就不刪、回 4','系統暫存區裡不是 \x60tmpdir\x60 建立的內容不碰'])assert.ok(skill.includes(marker),p.name+' SKILL: '+marker);
    const execution=read(p.orchestrator+'references/execution.md');
    assert.ok(execution.includes('工作資料夾與暫存')&&execution.includes('register --wp <id> --workdir <路徑> --keep')&&execution.includes('tmpdir --state'),p.name+' work package fields');
    const help=args=>{const r=spawnSync('python3',[ledger,...args,'--help'],{encoding:'utf8'});assert.equal(r.status,0,p.name+' '+args.join(' ')+': '+r.stderr);return r.stdout;};
    const register=help(['register']),prune=help(['prune']);
    assert.ok(register.includes('--workdir')&&register.includes('--keep'),p.name+': register takes --workdir and --keep');
    assert.ok(prune.includes('--none')&&prune.includes('--reason')&&prune.includes('--search'),p.name+': prune takes --none, --reason and --search');
    assert.ok(help(['tmpdir']).includes('--wp'),p.name+': tmpdir takes --wp');
    assert.ok(help(['check']).includes('--final'),p.name+': check takes --final');
  }
});

test('behavioral cases 69 to 73 are shared word for word and both adapters say how to check them',()=>{
  for(const number of [69,70,71,72,73]){
    const common=read('tests/behavioral-cases.md').split('\n').find(line=>line.startsWith(number+'. '));
    assert.ok(common,'common case '+number);
    for(const p of PLATFORMS){
      const row=read(p.orchestrator+'references/behavioral-cases.md').split('\n').find(line=>line.startsWith('| '+number+' |'));
      assert.ok(row,p.name+' '+number);
      const cells=row.replace(/^\|\s*/,'').replace(/\s*\|$/,'').split(' | ');
      assert.equal(cells.length,3,p.name+' '+number);
      assert.equal(cells[1],common.slice(4),p.name+' '+number);
      assert.ok(cells[2].trim().length>40,p.name+' '+number+': a way to check it');
    }
  }
});

