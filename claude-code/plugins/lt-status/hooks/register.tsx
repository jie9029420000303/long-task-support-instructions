import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RunStatus } from '../types'

// A view of one supervised run: it never writes run files, sends messages or types for anyone. supervise.cjs status is
// the source for "is the watcher really watching", as the skill itself requires. Version 0.2 also typed a short prompt
// for a supervisor that left an event waiting 3 minutes. That backstop lived in the supervisor's own process: every miss
// it was built for (2026-10-07 GDB, 10-13 IA twice, 10-14 GDB) was the App pausing that chat under memory pressure,
// which stops this mod too, so it caught none, and both times it fired (10-13 08:04Z, 10-14 04:45Z) the supervisor was
// already verifying the event. The supervisor now keeps its chat loaded with claude-hold.cjs RUN.
// 待你決定 reads the run's pending-decision ledger (pending-decisions.json), the same list the supervisor asks once;
// it no longer guesses the list from the newest decision that carried pendingApprovals (GDB 2026-10-13: stale for 22
// decisions). A run started before the ledger shows that old list until its supervisor writes the ledger once.
const PANE = 'lt-status'
const runPath = atom({ plugin: 'lt-status', key: 'run' } as const, null)
const status = atom({ plugin: 'lt-status', key: 'status' } as const, null)
const SUPERVISE = '/.claude/skills/long-task-supervisor/scripts/supervise.cjs'

async function readJson($: any, file: string): Promise<any> {
  try { return JSON.parse(await $.fs.read(file)) } catch { return null }
}

async function supervisorStatus($: any, run: string): Promise<{ value: any; error: string | null }> {
  const script = (await $.env.get('HOME')) + SUPERVISE
  for (const node of ['node', '/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    try {
      const ran = await $.process.run([node, script, 'status', run], { timeoutMs: 15000 })
      if (ran.exitCode === 0) return { value: JSON.parse(ran.stdout), error: null }
      return { value: {}, error: ran.stderr.trim().slice(0, 200) || 'status failed' }
    } catch {}
  }
  return { value: {}, error: 'node not found' }
}

async function refresh($: any): Promise<void> {
  const run = await read($, runPath)
  if (!run) return
  const { value, error } = await supervisorStatus($, run)
  const state = (await readJson($, run + '/daemon-state.json')) || {}
  const nowMs = await $.clock.now()
  const pendingId = state.pending ? String(state.pending.id) : null
  // Minutes from the event's own time, so a chat the App paused and resumed does not start the count again.
  const waited = state.pending?.at ? Math.max(0, Math.round((nowMs - Date.parse(state.pending.at)) / 60000)) || 0 : 0
  const resolved = Object.entries(state.resolved || {}) as [string, any][]
  const ledger = await readJson($, run + '/pending-decisions.json')
  const waiting: string[] = ledger && Array.isArray(ledger.items)
    ? ledger.items.filter((item: any) => item?.status === 'open').map((item: any) => String(item.ask))
    : resolved.map(([, item]) => item.decision?.pendingApprovals).filter(Boolean).pop() || []
  const next: RunStatus = {
    run,
    phase: value.phase || state.phase || 'unknown',
    active: value.active === true,
    pending: pendingId ? { id: pendingId, kind: String(state.pending.kind), waitedMinutes: waited } : null,
    lastExecutorActivityAt: state.lastExecutorActivityAt ? new Date(state.lastExecutorActivityAt).toISOString() : null,
    unconfirmedDeliveries: value.unconfirmedDeliveries || Object.keys(state.unconfirmedDeliveries || {}),
    pendingApprovals: waiting,
    queued: Number(value.queued) || 0,
    recent: resolved.slice(-10).reverse().map(([id, item]) => ({
      id, kind: String(item.event?.kind || '?'),
      disposition: item.obsolete ? 'obsolete' : item.closedWithAcceptance ? 'closed_with_acceptance' : String(item.decision?.disposition || '?'),
    })),
    error: error || value.error?.message || null,
    checkedAt: new Date(await $.clock.now()).toISOString(),
  }
  await update($, status, () => next)
}

// The run a supervisor or executor works on is named in its own commands: claude-watch.cjs RUN,
// supervise.cjs <command> RUN, handoff.cjs <command> RUN, dispatch.cjs write RUN.
const RUN_ARG = /(?:claude-watch\.cjs["']?|(?:supervise|handoff)\.cjs["']?\s+[a-z-]+|dispatch\.cjs["']?\s+write)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/

export function runFromCommand(command: string): string | null {
  const match = RUN_ARG.exec(command)
  let run = match ? match[1] || match[2] || match[3] : null
  const variable = run && /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(run)
  if (variable) {
    const assigned = new RegExp(`(?:^|[\\s;&])${variable[1]}=(?:"([^"]+)"|'([^']+)'|([^\\s;&]+))`).exec(command)
    run = assigned ? assigned[1] || assigned[2] || assigned[3] : null
  }
  return run && run.startsWith('/') ? run : null
}

async function bindFromCommand($: any, command: string): Promise<void> {
  const run = runFromCommand(command)
  if (!run || !run.startsWith('/') || run === (await read($, runPath))) return
  if (!(await $.fs.exists(run + '/binding.json'))) return
  await update($, runPath, () => run)
  await refresh($)
  void $.ui.open({ id: PANE, title: '長任務監看' })
}

function watchLabel(item: RunStatus): string {
  if (item.error) return '✕ 錯誤'
  if (item.phase === 'accepted') return '✓ 已驗收'
  if (item.phase === 'stopped') return '■ 已停止'
  if (item.pending && item.pending.waitedMinutes >= 3) return `⚠ 監督 ${item.pending.waitedMinutes} 分鐘未處理`
  if (item.pending) return '⚑ 等監督處理'
  return item.active ? '● 監看中' : '○ 未在監看（需重掛）'
}

function minutesAgo(iso: string | null, now: number): string {
  if (!iso) return '未知'
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60000)) + ' 分鐘前'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lt-run', description: 'Show a long-task run: /lt-run <absolute run path>' })
    await $.command.register({ name: 'lt-status', description: 'Open the long-task status pane' })
    $.clock.every(10000, () => { void refresh($) })
    void refresh($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await bindFromCommand($, String(e.command || ''))
    return ran
  })

  on('command.run', { command: 'lt-run' }, async ($, e) => {
    const run = e.args.trim()
    if (!run.startsWith('/') || !(await $.fs.exists(run + '/binding.json'))) {
      return { text: '找不到 run：請給含 binding.json 的絕對路徑。' }
    }
    await update($, runPath, () => run)
    await refresh($)
    return { text: '已顯示 run：' + run }
  })

  on('command.run', { command: 'lt-status' }, async $ => {
    await $.ui.open({ id: PANE, title: '長任務監看' })
    return { text: '已開啟長任務監看面板。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const item = await read($, status)
    if (e.props.hasSurvey || !item) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.parse(item.checkedAt)
    const pending = (item.pending ? `${item.pending.kind} ${item.pending.id.slice(0, 8)}` : '無') + (item.queued ? `（另排隊 ${item.queued}）` : '')
    return (
      <Box>
        <Text dimColor>
          {`監看 ${watchLabel(item)}｜執行端 ${minutesAgo(item.lastExecutorActivityAt, now)}有動作｜待處理：${pending}｜待對帳送達 ${item.unconfirmedDeliveries.length}｜待你決定 ${item.pendingApprovals.length}`}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const item = await read($, status)
    if (!item) return <Box><Text dimColor>尚未指定 run：輸入 /lt-run 加上 run 的絕對路徑。</Text></Box>
    return (
      <Box flexDirection="column">
        <Text bold>{watchLabel(item)}</Text>
        <Text dimColor>{item.run}</Text>
        <Text dimColor>{`最後查核 ${item.checkedAt}${item.error ? '｜' + item.error : ''}`}</Text>
        {item.queued > 0 && <Text>{`執行端事件排隊 ${item.queued} 個，依送出先後送到監督`}</Text>}
        <Text bold>待你決定</Text>
        {item.pendingApprovals.length === 0 && <Text dimColor>無</Text>}
        {item.pendingApprovals.map(text => <Text>{'・' + text}</Text>)}
        <Text bold>待對帳送達</Text>
        {item.unconfirmedDeliveries.length === 0 && <Text dimColor>無</Text>}
        {item.unconfirmedDeliveries.map(id => <Text>{'・' + id}</Text>)}
        <Text bold>最近事件</Text>
        {item.recent.length === 0 && <Text dimColor>無</Text>}
        {item.recent.map(event => <Text>{`・${event.kind}　${event.disposition}　${event.id.slice(0, 18)}`}</Text>)}
      </Box>
    )
  })
}
