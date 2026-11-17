export const MIN_HEARTBEAT_MS = 1_000;
export const MAX_HEARTBEAT_MS = 15_000;

export const heartbeatInterval = (inactivityMs) =>
  Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, Math.floor(inactivityMs / 10)));

export const shouldReport = ({ now, lastReportedMs, inactivityMs, warning }) =>
  warning || now - lastReportedMs >= heartbeatInterval(inactivityMs);

export const deadlineFromStatus = (sentAt, status) => sentAt + status.expires_in_ms;

export const earlierDeadline = (currentDeadline, sentAt, status) =>
  Math.min(currentDeadline, deadlineFromStatus(sentAt, status));

export const warningLead = (warnBeforeMs, inactivityMs) =>
  Math.min(warnBeforeMs, Math.floor(inactivityMs / 2));

export const hiddenTooLong = ({ hiddenAt, now, hiddenMs }) =>
  hiddenAt !== null && now - hiddenAt >= hiddenMs;
