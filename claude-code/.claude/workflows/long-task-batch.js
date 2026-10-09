export const meta = {
  name: 'long-task-batch',
  description: 'Run a batch of independent long-task work packages in parallel, check each one read-only, and return compact results',
  whenToUse: 'Only from the long-task-orchestrator executor, with packages taken from its state file',
  phases: [
    { title: 'Work', detail: 'one subagent per work package' },
    { title: 'Check', detail: 'read-only check of each package that reports done' },
  ],
}
// The executor passes the packages from its state file and records each result and quality error there itself, then
// dispatches failures at the next tier. Nothing retries in here, so the error ladder, the dispatch gates and the
// supervisor's view work exactly as with single Agent dispatches; the script only removes the model turn per package
// (2026-10-07 GDB run: 64 one-by-one dispatches, no subagent running for 66% of 23 hours).
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
const packages = input.packages || []
const REPORT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'evidence'],
}
const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    checked: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'checked', 'problems'],
}
const work = p => p.prompt +
  '\n\n[回報格式] 只回 status（done／blocked／failed）、summary（3 句內的結論）、evidence（可重查的檔案路徑或指令輸出檔）、changedFiles。細節寫進證據檔，不貼進回報。'
const check = (p, r) => '獨立查核工作包 ' + p.id + '。不得修改任何檔案，不得啟動、停止或重啟任何服務。\n查核依據：' +
  (p.verify || '工作包檔的驗收段（' + (p.wp || '見下方回報引用的工作包') + '）') +
  '\n執行者回報（只是線索，不採信）：' + JSON.stringify(r) +
  '\n逐項自己重跑定向檢查或讀證據，只寫親眼看到的結果；每一項都成立 pass 才是 true，problems 寫具體不符處與位置。'
const results = await pipeline(packages,
  p => agent(work(p), { label: p.id, phase: 'Work', agentType: p.agentType, schema: REPORT }),
  (r, p) => r && r.status === 'done'
    ? agent(check(p, r), { label: 'check:' + p.id, phase: 'Check', agentType: p.checkerType || 'lt-researcher-medium', schema: VERDICT })
      .then(v => ({ ...r, check: v }))
    : r,
)
return packages.map((p, i) => ({
  id: p.id,
  agentType: p.agentType,
  ...(results[i] || { status: 'failed', summary: 'No result: the agent was stopped, hit a usage limit, or failed on an API error', evidence: [] }),
}))
