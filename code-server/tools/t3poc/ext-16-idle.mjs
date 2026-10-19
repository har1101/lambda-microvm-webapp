export const IDLE_PAUSE_MS = 5 * 60 * 1000;
export const SWAP_LEAD_MS = 30 * 60 * 1000;
export const SWAP_BOOT_MS = 450_000;

export function decide(session, now) {
  if (!session?.microvmId || session.swapping) return 'none';
  // A silent websocket stays open for the whole T3 session. Idle is the last
  // byte, not the open socket. Swap still runs at 7.5h while that socket is up.
  if (session.expiresAt && now >= session.expiresAt - SWAP_LEAD_MS) return 'swap';
  if (session.vmState === 'RUNNING' && now - (session.lastActivityAt ?? now) >= IDLE_PAUSE_MS) return 'pause';
  return 'none';
}

async function resume(api) {
  const started = api.now();
  await api.deps.resume(api.session.microvmId);
  await api.deps.waitUntil(api.session.microvmId, api.now() + (api.deps.holdMs ?? 120_000));
  api.session.vmState = 'RUNNING';
  api.session.lastActivityAt = api.now();
  api.log(`resume latency ${api.now() - started}ms`);
}

export async function swap(api) {
  if (api.session.swapping) return;
  const previous = {
    microvmId: api.session.microvmId,
    endpoint: api.session.endpoint,
    expiresAt: api.session.expiresAt,
    startedAt: api.session.startedAt,
    vmState: api.session.vmState,
    diskPrepared: api.session.diskPrepared,
  };
  api.session.swapping = true;
  let created = null;
  let committed = false;
  try {
    if (previous.vmState === 'SUSPENDED' || previous.vmState === 'SUSPENDING') {
      await resume(api);
      previous.vmState = 'RUNNING';
    }
    for (const fn of api.hooks.beforeSwap) await fn(api);
    await api.wipPush();
    const backup = await api.backupHistory();
    if (!backup?.ok) throw new Error(backup?.reason || 'history backup did not complete');
    const started = api.now();
    const run = await api.deps.startMicrovm({ allowExisting: true });
    created = run.microvmId;
    await api.deps.waitUntil(run.microvmId, api.now() + SWAP_BOOT_MS);
    api.log(`swap startup latency ${api.now() - started}ms (RunMicrovm -> RUNNING)`);
    api.attach({ ...run, vmState: 'RUNNING', startedAt: api.now(), lastActivityAt: api.now() });
    api.flags.historyRestored = false;
    api.flags.prepareDisk = true;
    await api.emitVmReady();
    api.writeState();
    committed = true;
    try {
      await api.deps.terminate(previous.microvmId);
    } catch (error) {
      api.log(`old MicroVM terminate failed: ${error.message}`);
    }
    api.log('swapped MicroVM after the 7.5h mark');
  } catch (error) {
    if (!committed) {
      if (created) {
        try {
          await api.deps.terminate(created);
        } catch {
          // the failed replacement is best-effort
        }
      }
      api.attach(previous);
    }
    api.log(`swap stopped: ${error.message}`);
  } finally {
    api.session.swapping = false;
  }
}

export async function onTick(api) {
  const action = decide(api.session, api.now());
  if (action === 'pause') {
    try {
      const backup = await api.backupHistory();
      if (backup?.aborted) api.log(`pause will not upload history: ${backup.reason}`);
      if (backup?.skipped) api.log('pause without history backup: module not installed');
    } catch (error) {
      api.log(`pause skipped: ${error.message}`);
      return;
    }
    await api.deps.suspend(api.session.microvmId);
    api.session.vmState = 'SUSPENDED';
    api.log('paused MicroVM after 5 minutes idle');
    return;
  }
  if (action === 'swap') await swap(api);
}

export function register(api) {
  api.hooks.beforeRequest.push(async (runtime) => {
    if (['SUSPENDED', 'SUSPENDING'].includes(runtime.session.vmState)) await resume(runtime);
  });
  api.hooks.onTick.push((runtime) => onTick(runtime));
}
