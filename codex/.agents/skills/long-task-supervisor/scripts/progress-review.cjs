const { PROGRESS_REVIEW_MS } = require('./guard.cjs');

function activityMarker(poll) {
  const turn = poll.latestTurn;
  return JSON.stringify([
    poll.cursor || null,
    poll.latestAssistantMessageId || null,
    poll.latestToolMarkerId || null,
    turn?.id || null,
    turn?.status || null
  ]);
}
function observeActivity(state, poll, binding, nowMs = Date.now()) {
  const marker = activityMarker(poll);
  if (state.lastExecutorActivityMarker === undefined) {
    const turnAt = Number(poll.latestTurn?.completedAt || poll.latestTurn?.startedAt) * 1000;
    const boundAt = Date.parse(binding.createdAt);
    state.lastExecutorActivityAt ||= Math.max(turnAt || 0, boundAt || 0) || nowMs;
  } else if (marker !== state.lastExecutorActivityMarker) {
    state.lastExecutorActivityAt = nowMs;
  }
  state.lastExecutorActivityMarker = marker;
  return marker;
}
function due(state, nowMs = Date.now()) {
  return nowMs - Math.max(state.lastExecutorActivityAt || 0, state.lastProgressReviewAt || 0) >= PROGRESS_REVIEW_MS;
}
function eventFor(state, nowMs = Date.now()) {
  state.progressReviewSequence = (state.progressReviewSequence || 0) + 1;
  return { id: 'progress-review-' + state.progressReviewSequence, kind: 'progress_review',
    activityMarker: state.lastExecutorActivityMarker, lastExecutorActivityAt: new Date(state.lastExecutorActivityAt).toISOString(),
    at: new Date(nowMs).toISOString() };
}
module.exports = { activityMarker, observeActivity, due, eventFor };
