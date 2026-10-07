import { expect, mock, test } from 'claude-code/testing'

// What the person sees is the point of the mod: once a supervisor's own command names its run, the pane
// opens by itself and the band says at a glance whether the watcher is really watching and what waits on
// them, on the desktop app as in a terminal. The engine nouns the mod reaches are answered here.
const RUN = '/Users/jay/雲端(同步Nas)/proj/.claude/long-task-supervisor/20261003-run'
const STATUS = { phase: 'watching', active: true, unconfirmedDeliveries: ['6f9bd496-queued'], error: null }
const STATE = {
  phase: 'watching',
  lastExecutorActivityAt: Date.parse('2026-10-06T03:00:00.000Z'),
  resolved: {
    '22d1421e-c0de': { event: { kind: 'progress' }, decision: { disposition: 'observe', pendingApprovals: ['發 v0.17.2'] } },
  },
}

test('a supervisor command opens the pane and fills the band on terminal and desktop', async ($, on) => {
  const opened: string[] = []
  mock.env(on, { HOME: '/Users/jay' })
  mock.clock(on, { now: Date.parse('2026-10-06T03:05:00.000Z') })
  on('fs.exists', async (_, e) => ({ value: e.path === RUN + '/binding.json' }))
  on('fs.read', async (_, e) => {
    if (e.path === RUN + '/daemon-state.json') return { value: JSON.stringify(STATE) }
    return { deny: 'missing ' + e.path }
  })
  on('fs.write', async () => ({ value: undefined }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('ui.open', async (_, e) => { opened.push(e.id); return { value: {} } as any })
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '', isError: false }) as any)

  await $.tool.call({ tool: 'Bash', command: `R="${RUN}"; node ~/.claude/skills/long-task-supervisor/scripts/claude-watch.cjs "$R"` } as any)
  expect(opened).toEqual(['lt-status'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'lt-status', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /^監看 ● 監看中｜執行端 5 分鐘前有動作｜待處理：無｜待對帳送達 1｜待你核准 1$/ })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({
      plugin: 'lt-status', surface, component: 'Pane', requestId: 'lt-status',
      props: { title: '長任務監看', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await pane.find({ type: 'Text', text: RUN })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '・發 v0.17.2' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '・6f9bd496-queued' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^・progress　observe　22d1421e/ })).toBeDefined()
    await pane.unmount()
  }
})
