export const IDLE_PAUSE_MS = 5 * 60 * 1000;
export const SWAP_LEAD_MS = 30 * 60 * 1000;
export const SWAP_BOOT_MS = 450_000;
export const RETRY_MS = 60_000;

export function decide(session, now) {
  if (!session?.microvmId || session.swapping) return 'none';
  // A silent websocket stays open for the whole T3 session. Idle is the last
  // byte, not the open socket. Swap still runs at 7.5h while that socket is up.
  if (session.expiresAt && now >= session.expiresAt - SWAP_LEAD_MS) return 'swap';
  if (session.vmState === 'RUNNING' && now - (session.lastActivityAt ?? now) >= IDLE_PAUSE_MS) return 'pause';
  return 'none';
}

async function resume(api, preservingBeforeSwap = false) {
  const started = api.now();
  await api.deps.resume(api.session.microvmId);
  await api.deps.waitUntil(api.session.microvmId, api.now() + (api.deps.holdMs ?? 120_000));
  api.session.vmState = 'RUNNING';
  for (const fn of api.hooks.onResume) {
    try {
      await fn(api);
    } catch (error) {
      if (!preservingBeforeSwap) throw error;
      api.log('resume hook failed during swap; attempting WIP with the available token');
    }
  }
  api.session.lastActivityAt = api.now();
  api.log(`resume latency ${api.now() - started}ms`);
}

export function swap(api) {
  return api.exclusive(() => swapInside(api));
}

async function swapInside(api) {
  if (api.session.swapping || api.now() < (api.flags.nextSwapAt ?? 0)) return;
  try {
    await api.recoverCleanup();
  } catch (error) {
    api.flags.nextSwapAt = api.now() + RETRY_MS;
    api.log(`swap cleanup deferred: ${error.message}`);
    return;
  }
  const previous = {
    microvmId: api.session.microvmId,
    endpoint: api.session.endpoint,
    expiresAt: api.session.expiresAt,
    startedAt: api.session.startedAt,
    vmState: api.session.vmState,
    diskPrepared: api.session.diskPrepared,
  };
  api.session.swapping = true;
  const previousFlags = { ...api.flags };
  let created = null;
  let committed = false;
  try {
    if (previous.vmState === 'SUSPENDED' || previous.vmState === 'SUSPENDING') {
      await resume(api, true);
      previous.vmState = 'RUNNING';
    }
    await api.wipPush();
    for (const fn of api.hooks.beforeSwap) await fn(api);
    const backup = await api.backupHistory();
    if (!backup?.ok) throw new Error(backup?.reason || 'history backup did not complete');
    const started = api.now();
    const run = await api.deps.startMicrovm({ allowExisting: true });
    created = run.microvmId;
    // Keep the old primary until restoration succeeds, but journal the new ID
    // immediately so a restarted relay can reclaim an unfinished replacement.
    api.session.cleanupMicrovmIds = [created];
    api.writeState();
    api.flags.deferState = true;
    await api.deps.waitUntil(run.microvmId, api.now() + SWAP_BOOT_MS);
    api.log(`swap startup latency ${api.now() - started}ms (RunMicrovm -> RUNNING)`);
    api.attach({ ...run, vmState: 'RUNNING', diskPrepared: false, startedAt: api.now(), lastActivityAt: api.now() });
    api.flags.historyRestored = false;
    api.flags.prepareDisk = true;
    await api.emitVmReady();
    api.flags.deferState = false;
    api.session.cleanupMicrovmIds = [previous.microvmId];
    api.writeState();
    committed = true;
    api.flags.nextSwapAt = 0;
    try {
      await api.recoverCleanup();
    } catch (error) {
      api.log(`old MicroVM terminate failed: ${error.message}`);
    }
    api.log('swapped MicroVM after the 7.5h mark');
  } catch (error) {
    if (!committed) {
      api.attach(previous);
      Object.assign(api.flags, previousFlags);
      api.flags.deferState = false;
      api.session.cleanupMicrovmIds = created ? [created] : [];
      api.writeState();
      try {
        await api.recoverCleanup();
      } catch (cleanupError) {
        api.log(`replacement cleanup deferred: ${cleanupError.message}`);
      }
    }
    api.flags.nextSwapAt = api.now() + RETRY_MS;
    api.log(`swap stopped: ${error.message}`);
  } finally {
    api.session.swapping = false;
  }
}

export function onTick(api) {
  return api.exclusive(() => tickInside(api));
}

async function tickInside(api) {
  const action = decide(api.session, api.now());
  if (action === 'pause') {
    if (api.now() < (api.flags.nextPauseAt ?? 0)) return;
    try {
      const idleSince = api.session.lastActivityAt;
      api.log(`idle pause due: idle ${api.now() - idleSince}ms, last byte ${new Date(idleSince).toISOString()}`);
      const backup = await api.backupHistory();
      if (backup?.aborted) api.log(`pause will not upload history: ${backup.reason}`);
      if (backup?.skipped) api.log('pause without history backup: module not installed');
      if (decide(api.session, api.now()) !== 'pause') {
        api.log(`pause skipped: activity during backup (idle ${api.now() - api.session.lastActivityAt}ms)`);
        return;
      }
      await api.deps.suspend(api.session.microvmId);
      api.session.vmState = 'SUSPENDED';
      api.log(`paused MicroVM after 5 minutes idle (idle ${api.now() - api.session.lastActivityAt}ms)`);
      api.flags.nextPauseAt = 0;
    } catch (error) {
      api.flags.nextPauseAt = api.now() + RETRY_MS;
      api.log(`pause skipped: ${error.message}`);
    }
    return;
  }
  if (action === 'swap') await swapInside(api);
}

export function register(api) {
  api.hooks.beforeRequest.push(async (runtime) => {
    if (['SUSPENDED', 'SUSPENDING'].includes(runtime.session.vmState)) await resume(runtime);
  });
  api.hooks.onTick.push((runtime) => onTick(runtime));
}
