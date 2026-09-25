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

/**
 * Summarizes lifecycle.py's auth-sync.json for the status bar. Ages use the local
 * clock on purpose: lifecycle.py stamps the file with the same guest clock.
 * Failures outrank staleness; a sync older than three intervals means the
 * periodic sync is not running and S3 may be missing recent logins.
 */
function describeAuthSync(status, nowMs, syncIntervalMs) {
  const restoreFailed = Array.isArray(status?.restoreFailed) ? status.restoreFailed : [];
  const failed = Array.isArray(status?.failed) ? status.failed : [];
  if (restoreFailed.length > 0) {
    return {
      text: '$(warning) 認証復元失敗',
      level: 'error',
      detail: `起動時にS3から復元できなかったため、次のファイルの自動保存を止めています: ${restoreFailed.join(', ')}。ログインし直してからクリックで保存してください。`,
    };
  }
  if (failed.length > 0) {
    return {
      text: '$(warning) 認証保存失敗',
      level: 'error',
      detail: `S3へ保存できませんでした: ${failed.join(', ')}。クリックで再試行します。`,
    };
  }
  if (!Number.isSafeInteger(status?.lastSuccessAt)) {
    return {
      text: '$(cloud) 認証 未保存',
      level: 'warning',
      detail: 'S3への保存記録がありません。クリックで保存します。',
    };
  }
  const ageMs = Math.max(0, nowMs - status.lastSuccessAt);
  const text = `認証 ${Math.floor(ageMs / 60_000)}分前`;
  if (ageMs > 3 * syncIntervalMs) {
    return {
      text: `$(warning) ${text}`,
      level: 'warning',
      detail: '定期保存が止まっている可能性があります。クリックで今すぐ保存します。',
    };
  }
  return {
    text: `$(cloud) ${text}`,
    level: 'normal',
    detail: 'S3の認証状態はこのVMの最新状態と一致しています。クリックで今すぐ保存します。',
  };
}

module.exports = {
  NOTIFY_MINUTES,
  clockOffsetMs,
  describeAuthSync,
  dueNotification,
  formatRemaining,
  parseSessionDeadline,
  severity,
};
