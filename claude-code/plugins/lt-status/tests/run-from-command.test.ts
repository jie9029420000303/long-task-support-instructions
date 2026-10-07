import { expect, test } from 'claude-code/testing'

import { runFromCommand } from '../hooks/register'

// The panel opens by itself only if it can read the run from the commands a supervisor or executor
// really types; a miss means the person is back to typing /lt-run by hand.
test('reads the run from the command forms the long-task skills use', () => {
  const run = '/Users/jay/雲端(同步Nas)/proj/.claude/long-task-supervisor/20261003-run'
  expect(runFromCommand(`node "/Users/jay/.claude/skills/long-task-supervisor/scripts/claude-watch.cjs" "${run}"`)).toBe(run)
  expect(runFromCommand(`node /x/scripts/claude-watch.cjs ${run}`)).toBe(run)
  expect(runFromCommand(`node "/x/scripts/supervise.cjs" decision "${run}" "${run}/decision-a.json"`)).toBe(run)
  expect(runFromCommand(`node /x/scripts/handoff.cjs prepare '${run}' /tmp/e.json`)).toBe(run)
  expect(runFromCommand(`node /x/scripts/dispatch.cjs write "${run}" /tmp/s.json`)).toBe(run)
  expect(runFromCommand(`R="${run}"; node ~/.claude/skills/long-task-supervisor/scripts/claude-watch.cjs "$R"`)).toBe(run)
})

test('ignores commands that do not name an absolute run', () => {
  expect(runFromCommand('node /x/scripts/claude-watch.cjs "$UNSET"')).toBe(null)
  expect(runFromCommand('node /x/scripts/supervise.cjs status relative/run')).toBe(null)
  expect(runFromCommand('git status')).toBe(null)
})
