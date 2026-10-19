import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonInvocation } from './vm-shell.mjs';

const PY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vm_history.py');
const PY = fs.readFileSync(PY_PATH, 'utf8');

export function historyLocation(account) {
  if (!/^\d{12}$/.test(String(account))) throw new Error('bad account id');
  return {
    Bucket: `t3poc-auth-${account}-ap-northeast-1`,
    Key: 't3-history/latest.tar',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: 'alias/t3poc-auth-state',
  };
}

function lastBetween(text, start, end) {
  const at = text.lastIndexOf(start);
  const until = text.lastIndexOf(end);
  if (at < 0 || until < at) return null;
  return text.slice(at + start.length, until).replace(/\s+/g, '');
}

export function parseEmit(text) {
  const abort = text.match(/T3POC_BACKUP_ABORT ([^\r\n]+)/);
  if (abort) return { aborted: true, reason: abort[1].trim() };
  try {
    const history = lastBetween(text, 'T3POC_HISTORY_B64', 'T3POC_HISTORY_END');
    if (!history) return { aborted: true, reason: 'history payload missing' };
    const pairingB64 = lastBetween(text, 'T3POC_PAIRING_B64', 'T3POC_PAIRING_END');
    return {
      ok: true,
      history: Buffer.from(history, 'base64'),
      pairing: pairingB64 ? JSON.parse(Buffer.from(pairingB64, 'base64').toString('utf8')) : null,
    };
  } catch {
    return { aborted: true, reason: 'history payload could not be read' };
  }
}

export function assertHistoryTar(bytes) {
  const result = spawnSync('python3', [PY_PATH, 'check-tar'], { input: bytes });
  const out = `${result.stdout ?? ''}`;
  if (result.status !== 0 || out.includes('T3POC_BACKUP_ABORT')) {
    const reason = out.match(/T3POC_BACKUP_ABORT ([^\r\n]+)/)?.[1] ?? 'history tar rejected';
    const error = new Error(reason);
    error.aborted = true;
    throw error;
  }
}

export async function backupHistory(api) {
  const out = await api.deps.shell({ script: pythonInvocation(PY, 'emit') });
  const parsed = parseEmit(out);
  if (parsed.aborted) {
    api.log(`t3 history backup stopped: ${parsed.reason}`);
    return parsed;
  }
  try {
    assertHistoryTar(parsed.history);
  } catch (error) {
    api.log(`t3 history backup stopped: ${error.message}`);
    return { aborted: true, reason: error.message };
  }
  const location = historyLocation(await api.deps.accountId());
  await api.deps.s3Put({ ...location, Body: parsed.history });
  api.log(`t3 history backed up (${parsed.history.length} bytes, sse-kms ${location.SSEKMSKeyId})`);
  if (parsed.pairing) await api.savePairing?.(parsed.pairing);
  return { ok: true, bytes: parsed.history.length, pairing: parsed.pairing };
}

export async function restoreHistory(api) {
  const location = historyLocation(await api.deps.accountId());
  let body;
  try {
    body = await api.deps.s3Get(location);
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error.name) || error.Code === 'NoSuchKey') {
      api.log('no t3 history backup to restore');
      return { empty: true };
    }
    throw error;
  }
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  assertHistoryTar(bytes);
  const out = await api.deps.shell({ script: pythonInvocation(PY, 'restore', bytes) });
  if (out.includes('T3POC_BACKUP_ABORT') || !out.includes('T3POC_RESTORE_OK')) {
    const reason = out.match(/T3POC_BACKUP_ABORT ([^\r\n]+)/)?.[1] ?? 'restore failed';
    api.log(`t3 history restore stopped: ${reason}`);
    return { aborted: true, reason };
  }
  api.log(`t3 history restored (${bytes.length} bytes)`);
  return { ok: true };
}
