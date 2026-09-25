// Pure countdown logic, kept free of the vscode module so it can be unit tested.

const WARNING_MS = 30 * 60_000;
const ERROR_MS = 10 * 60_000;
const NOTIFY_MINUTES = [60, 15, 5];

/** Returns the deadline (epoch ms) from the lifecycle-written session file, or null. */
function parseSessionDeadline(text) {
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    return null;
  }
  const expiresAt = session?.expiresAt;
  return Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : null;
}

/** Formats a positive remaining duration as H:MM, rounding down. */
function formatRemaining(remainingMs) {
  const totalMinutes = Math.floor(Math.max(0, remainingMs) / 60_000);
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function severity(remainingMs) {
  if (remainingMs <= ERROR_MS) return 'error';
  if (remainingMs <= WARNING_MS) return 'warning';
  return 'normal';
}

/**
 * Returns the notification threshold (minutes) to announce now, or undefined.
 * Only the tightest crossed threshold fires, so opening the IDE with 12 minutes
 * left produces one 15-minute warning rather than a burst of stale ones.
 * The caller marks every threshold >= the returned value as notified.
 */
function dueNotification(remainingMs, notified) {
  if (remainingMs <= 0) return undefined;
  let due;
  for (const minutes of NOTIFY_MINUTES) {
    if (remainingMs <= minutes * 60_000) due = minutes;
  }
  return due === undefined || notified.has(due) ? undefined : due;
}

/**
 * Estimates (true time - local clock) from an HTTP Date header. The guest clock
 * is not NTP-synced and may lag after Suspend/Resume; the header has 1 s
 * resolution, so the midpoint of that second is compared with the request midpoint.
 */
function clockOffsetMs(dateHeader, sentAt, receivedAt) {
  const serverSecond = Date.parse(dateHeader ?? '');
  if (Number.isNaN(serverSecond)) return null;
  return Math.round(serverSecond + 500 - (sentAt + receivedAt) / 2);
}

module.exports = { NOTIFY_MINUTES, clockOffsetMs, dueNotification, formatRemaining, parseSessionDeadline, severity };
