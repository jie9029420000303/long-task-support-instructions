import { expect, mock, test } from 'claude-code/testing'

import { NUDGE_AFTER_MS, nudgeDue } from '../hooks/register'

// 2026-10-07 GDB run: the supervisor sat idle 96 minutes, the background notification for its next event did not
// start a model turn, and supervision stood still until Jay happened to type. The panel lives in the supervisor's
// session, sees the event waiting, and can type for him — but only there, only once, and only when no turn ran.
const RUN = '/Users/jay/proj/.claude/long-task-supervisor/r1'

test('the backstop fires only for a stale event in the supervisor session with no model turn since', () => {
  const base = { isSupervisor: true, pendingId: 'e1', seenAt: 1000, lastTurnAt: 0, turnRunning: false, nudged: false, now: 1000 + NUDGE_AFTER_MS }
  expect(nudgeDue(base)).toBe(true)
  expect(nudgeDue({ ...base, now: 1000 + NUDGE_AFTER_MS - 1 })).toBe(false)
  expect(nudgeDue({ ...base, isSupervisor: false })).toBe(false)
  expect(nudgeDue({ ...base, lastTurnAt: 2000 })).toBe(false)
  expect(nudgeDue({ ...base, turnRunning: true })).toBe(false)
  expect(nudgeDue({ ...base, nudged: true })).toBe(false)
  expect(nudgeDue({ ...base, pendingId: null })).toBe(false)
})

function world(on: any, session: string, submitted: string[]) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T13:40:10.000Z') })
  mock.env(on, { HOME: '/Users/jay' })
  on('session.id', async () => ({ value: session }) as any)
  on('fs.exists', async (_: any, e: any) => ({ value: e.path === RUN + '/binding.json' }))
  on('fs.read', async (_: any, e: any) => {
    if (e.path === RUN + '/binding.json') return { value: JSON.stringify({ supervisorId: 'sup-1', toolSessionId: 'sup-1', executorId: 'exe-1' }) }
    if (e.path === RUN + '/daemon-state.json') return { value: JSON.stringify({ phase: 'awaiting_decision', pending: { id: 'progress-review-1', kind: 'progress_review' } }) }
    return { deny: 'missing ' + e.path }
  })
  on('fs.write', async () => ({ value: undefined }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ phase: 'awaiting_decision', active: false }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('ui.open', async () => ({ value: {} }) as any)
  on('command.register', async () => ({ value: undefined }) as any)
  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }) as any)
  on('prompt.submit', async (_: any, e: any) => { submitted.push(e.text); return { text: e.text } as any })
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '', isError: false }) as any)
  return clock
}

test('a supervisor session that missed an event gets one short prompt after three minutes', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, 'sup-1', submitted)
  await $.session.start({ cwd: '/Users/jay/proj', surface: 'desktop', isInteractive: true } as any)
  await $.tool.call({ tool: 'Bash', command: `node /x/scripts/claude-watch.cjs "${RUN}"` } as any)
  await clock.advance(2 * 60 * 1000)
  expect(submitted).toEqual([])
  await clock.advance(90 * 1000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('progress_review')
  expect(submitted[0]).toContain('supervise.cjs brief')
  await clock.advance(10 * 60 * 1000)
  expect(submitted.length).toBe(1)
})

test('the executor session that shows the same run never types for the supervisor', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, 'exe-1', submitted)
  await $.session.start({ cwd: '/Users/jay/proj', surface: 'desktop', isInteractive: true } as any)
  await $.tool.call({ tool: 'Bash', command: `node /x/scripts/dispatch.cjs write "${RUN}" /tmp/s.json` } as any)
  await clock.advance(10 * 60 * 1000)
  expect(submitted).toEqual([])
})

test('a model turn that started after the event means the supervisor is already on it', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, 'sup-1', submitted)
  on('turn.start', async (_: any, e: any) => ({ turnId: e.turnId }) as any)
  on('turn.complete', async () => ({ text: '' }) as any)
  await $.session.start({ cwd: '/Users/jay/proj', surface: 'desktop', isInteractive: true } as any)
  await $.tool.call({ tool: 'Bash', command: `node /x/scripts/claude-watch.cjs "${RUN}"` } as any)
  await clock.advance(30 * 1000)
  await $.turn.start({ text: '', turnId: 't1' } as any)
  await clock.advance(10 * 60 * 1000)
  expect(submitted).toEqual([])
})
