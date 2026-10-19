import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonInvocation, STOP_T3 } from './vm-shell.mjs';
import { withWorktrees } from './worktree-code.mjs';

export const PAIRING_SERVICE = 't3poc-pairing';
export const PAIRING_ACCOUNT = 'bundle';
const PY = withWorktrees(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vm_history.py'), 'utf8'),
);

export function authRowCount(bundle) {
  if (!bundle?.auth_tables) return 0;
  return bundle.auth_tables.reduce((sum, table) => sum + (table.rows?.length ?? 0), 0);
}

export function shouldReplace(previous, next) {
  if (!next) return false;
  if (authRowCount(previous) > 0 && authRowCount(next) === 0) return false;
  const hasMaterial = (bundle) =>
    authRowCount(bundle) > 0 || (bundle?.secrets?.length ?? 0) > 0 || Boolean(bundle?.environment_id);
  if (hasMaterial(previous) && !hasMaterial(next)) return false;
  return true;
}

export function parsePairingEmit(text) {
  const abort = text.match(/T3POC_BACKUP_ABORT ([^\r\n]+)/);
  if (abort) return { aborted: true, reason: abort[1].trim() };
  const at = text.lastIndexOf('T3POC_PAIRING_B64');
  const until = text.lastIndexOf('T3POC_PAIRING_END');
  if (at < 0 || until < at) return { aborted: true, reason: 'pairing payload missing' };
  const raw = text.slice(at + 'T3POC_PAIRING_B64'.length, until).replace(/\s+/g, '');
  return { bundle: JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) };
}

export async function snapshot(api) {
  try {
    const out = await api.deps.shell({ script: pythonInvocation(PY, 'emit-pairing') });
    const parsed = parsePairingEmit(out);
    if (parsed.aborted) {
      api.log(`pairing snapshot stopped: ${parsed.reason}`);
      return parsed;
    }
    await api.savePairing(parsed.bundle);
    return { ok: true };
  } catch {
    api.log('pairing snapshot failed');
    return { aborted: true, reason: 'pairing snapshot failed' };
  }
}

export function register(api) {
  api.savePairing = async (bundle) => {
    const keychain = api.deps.keychain(PAIRING_SERVICE);
    let previous = null;
    try {
      previous = JSON.parse((await keychain.get(PAIRING_ACCOUNT)).toString('utf8'));
    } catch (error) {
      if (error.code !== 'KEYCHAIN_NOT_FOUND') throw error;
      previous = null;
    }
    if (!shouldReplace(previous, bundle)) {
      api.log('kept existing pairing bundle; new VM has no session yet');
      return;
    }
    await keychain.set(PAIRING_ACCOUNT, Buffer.from(JSON.stringify(bundle)));
    api.log('pairing bundle updated in the macOS keychain');
  };
  api.hooks.prepareDisk.push(async (runtime) => {
    const keychain = runtime.deps.keychain(PAIRING_SERVICE);
    let raw = null;
    try {
      raw = await keychain.get(PAIRING_ACCOUNT);
    } catch (error) {
      if (error.code !== 'KEYCHAIN_NOT_FOUND') throw error;
      raw = null;
    }
    if (!raw) return;
    const bundle = JSON.parse(raw.toString('utf8'));
    if (!runtime.flags.t3Stopped) {
      await runtime.deps.shell({ script: STOP_T3 });
      runtime.flags.t3Stopped = true;
    }
    const out = await runtime.deps.shell({
      script: pythonInvocation(PY, 'apply-pairing', Buffer.from(JSON.stringify(bundle))),
    });
    if (out.includes('T3POC_BACKUP_ABORT') || !out.includes('T3POC_PAIRING_OK')) {
      throw new Error(out.match(/T3POC_BACKUP_ABORT ([^\r\n]+)/)?.[1] ?? 'pairing restore failed');
    }
    runtime.log('restored T3 pairing material into /dev/shm');
  });
  api.hooks.onVmReady.push(async (runtime) => {
    const keychain = runtime.deps.keychain(PAIRING_SERVICE);
    let has = false;
    try {
      has = Boolean(await keychain.get(PAIRING_ACCOUNT));
    } catch (error) {
      if (error.code !== 'KEYCHAIN_NOT_FOUND') throw error;
      has = false;
    }
    if (has) return;
    if (runtime.deps.mintPairing) await runtime.deps.mintPairing(runtime);
  });
  // The last successful Keychain bundle remains usable for re-pairing.
  // Snapshot failure must not block WIP/history preservation or termination.
  const snapshotBeforeExit = async (runtime) => {
    try {
      const result = await snapshot(runtime);
      if (result?.aborted) runtime.log('pairing snapshot failed; retaining the previous Keychain bundle');
    } catch {
      runtime.log('pairing snapshot failed; retaining the previous Keychain bundle');
    }
  };
  api.hooks.beforeSwap.push(snapshotBeforeExit);
  api.hooks.beforeStop.push(snapshotBeforeExit);
  api.hooks.onTick.push(async (runtime) => {
    if (runtime.session.vmState !== 'RUNNING') return;
    if (runtime.now() - (runtime.flags.pairingSnapshotAt ?? 0) < 60_000) return;
    runtime.flags.pairingSnapshotAt = runtime.now();
    await runtime.exclusive(() => snapshot(runtime));
  });
}
