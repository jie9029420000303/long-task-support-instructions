const { PROGRESS_REVIEW_MS } = require('./guard.cjs');

function activityMarker(poll) {
  return JSON.stringify([
    poll.latestAssistantMessageId || null,
    poll.latestTurn?.id || null
  ]);
}
function supervisorPollFromThread(detail) {
  const turn = detail.turns?.[0];
  const visible = turn?.items?.filter(item => item.type === 'userMessage' || item.type === 'agentMessage').at(-1);
  return { latestTurn: turn || null, latestAssistantMessageId: visible?.id || null };
}
function observeActivity(state, poll, binding, nowMs = Date.now(), role = 'executor') {
  const label = role === 'supervisor' ? 'Supervisor' : 'Executor';
  const markerKey = `last${label}ActivityMarker`, atKey = `last${label}ActivityAt`;
  const marker = activityMarker(poll);
  if (state[markerKey] === undefined) {
    const turnAt = Number(poll.latestTurn?.completedAt || poll.latestTurn?.startedAt) * 1000;
    const boundAt = Date.parse(binding.createdAt);
    state[atKey] ||= Math.max(turnAt || 0, boundAt || 0) || nowMs;
  } else if (marker !== state[markerKey]) {
    state[atKey] = nowMs;
  }
  state[markerKey] = marker;
  return marker;
}
function due(state, nowMs = Date.now()) {
  return nowMs - Math.max(state.lastExecutorActivityAt || 0, state.lastSupervisorActivityAt || 0,
    state.lastProgressReviewAt || 0) >= PROGRESS_REVIEW_MS;
}
function eventFor(state, nowMs = Date.now()) {
  state.progressReviewSequence = (state.progressReviewSequence || 0) + 1;
  return { id: 'progress-review-' + state.progressReviewSequence, kind: 'progress_review',
    activityMarker: state.lastExecutorActivityMarker, lastExecutorActivityAt: new Date(state.lastExecutorActivityAt).toISOString(),
    supervisorActivityMarker: state.lastSupervisorActivityMarker,
    lastSupervisorActivityAt: new Date(state.lastSupervisorActivityAt).toISOString(),
    at: new Date(nowMs).toISOString() };
}
module.exports = { activityMarker, supervisorPollFromThread, observeActivity, due, eventFor };
