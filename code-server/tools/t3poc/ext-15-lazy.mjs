export const RELAY_HOLD_MS = 120_000;
export const RUNNING_CHECK_MS = 15_000;
const TERMINAL = new Set(['TERMINATED', 'TERMINATING', 'FAILED']);

export function register(api) {
  api.hooks.beforeRequest.push((runtime) => ensureVm(runtime));
}

export async function ensureVm(api) {
  const deadline = api.now() + (api.deps.bootMs ?? 450_000);
  const existing = api.session.microvmId
    ? {
        microvmId: api.session.microvmId,
        endpoint: api.session.endpoint,
        expiresAt: api.session.expiresAt,
        startedAt: api.session.startedAt,
        diskPrepared: api.session.diskPrepared,
      }
    : api.readState();
  if (existing?.microvmId) {
    let current;
    const check = api.flags.runningCheck;
    const fresh =
      api.session.vmState === 'RUNNING' &&
      check?.microvmId === existing.microvmId &&
      api.now() - check.at < RUNNING_CHECK_MS &&
      (!existing.expiresAt || api.now() < existing.expiresAt);
    delete api.flags.runningCheck;
    try {
      current = fresh ? { state: 'RUNNING' } : await api.deps.getMicrovm(existing.microvmId);
      if (current?.state === 'RUNNING')
        api.flags.runningCheck = { microvmId: existing.microvmId, at: fresh ? check.at : api.now() };
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
      current = null;
    }
    if (current && !TERMINAL.has(current.state)) {
      if (!['RUNNING', 'SUSPENDED', 'SUSPENDING'].includes(current.state)) {
        await api.deps.waitUntil(existing.microvmId, deadline);
      }
      const latest = ['RUNNING', 'SUSPENDED', 'SUSPENDING'].includes(current.state)
        ? current
        : await api.deps.getMicrovm(existing.microvmId);
      if (existing.diskPrepared === false && existing.startedAt != null && latest.state === 'RUNNING') {
        api.log(`startup latency ${api.now() - existing.startedAt}ms (RunMicrovm -> RUNNING)`);
      }
      api.attach({ ...existing, vmState: latest.state });
      // Only a boot that never finished disk prep may rewrite /dev/shm.
      api.flags.prepareDisk = existing.diskPrepared === false;
      if (existing.diskPrepared === false && !api.flags.prepareDisk) api.flags.historyRestored = false;
      if (latest.state === 'RUNNING') {
        await api.emitVmReady();
        if (existing.diskPrepared === false) api.writeState();
      }
      return;
    }
  }
  const recorded = api.readState();
  if (recorded?.microvmId && recorded.microvmId !== existing?.microvmId) {
    api.attach({ ...recorded, vmState: recorded.vmState ?? 'STARTING' });
    api.flags.historyRestored = false;
    return ensureVm(api);
  }
  const started = api.now();
  const run = await api.deps.startMicrovm({ allowExisting: false });
  api.attach({ ...run, vmState: 'STARTING', startedAt: started, lastActivityAt: api.now(), diskPrepared: false });
  api.writeState();
  await api.deps.waitUntil(run.microvmId, deadline);
  api.log(`startup latency ${api.now() - started}ms (RunMicrovm -> RUNNING)`);
  api.attach({ vmState: 'RUNNING', lastActivityAt: api.now() });
  api.flags.historyRestored = false;
  api.flags.prepareDisk = true;
  await api.emitVmReady();
  api.writeState();
}
