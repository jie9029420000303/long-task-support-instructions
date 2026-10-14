export type RecentEvent = { id: string; kind: string; disposition: string }

export type RunStatus = {
  run: string
  phase: string
  active: boolean
  pending: { id: string; kind: string; waitedMinutes: number } | null
  lastExecutorActivityAt: string | null
  unconfirmedDeliveries: string[]
  // Open items of the run's pending-decision ledger (the old decision field for runs started before it).
  pendingApprovals: string[]
  // Executor handoffs queued behind the pending event.
  queued: number
  recent: RecentEvent[]
  error: string | null
  checkedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'lt-status': { run: string | null; status: RunStatus | null }
  }
}
