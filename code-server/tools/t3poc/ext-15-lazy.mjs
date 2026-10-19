export const RELAY_HOLD_MS = 120_000;
const TERMINAL = new Set(['TERMINATED', 'TERMINATING', 'FAILED']);

export function register(api) {
  api.hooks.beforeRequest.push((runtime) => ensureVm(runtime));
}

export async function ensureVm(api) {
  const deadline = api.now() + (api.deps.holdMs ?? RELAY_HOLD_MS);
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
    const current = await api.deps.getMicrovm(existing.microvmId);
    if (current && !TERMINAL.has(current.state)) {
      if (!['RUNNING', 'SUSPENDED', 'SUSPENDING'].includes(current.state)) {
        await api.deps.waitUntil(existing.microvmId, deadline);
      }
      const latest = ['RUNNING', 'SUSPENDED', 'SUSPENDING'].includes(current.state)
        ? current
        : await api.deps.getMicrovm(existing.microvmId);
      api.attach({ ...existing, vmState: latest.state });
      // Only a boot that never finished disk prep may rewrite /dev/shm.
      api.flags.prepareDisk = existing.diskPrepared === false;
      api.flags.historyRestored = false;
      if (latest.state === 'RUNNING') {
        await api.emitVmReady();
        if (existing.diskPrepared === false) api.writeState();
      }
      return;
    }
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
