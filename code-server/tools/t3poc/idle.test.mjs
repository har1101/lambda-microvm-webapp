import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, IDLE_PAUSE_MS, onTick, SWAP_LEAD_MS, swap } from './ext-16-idle.mjs';
import { createRuntime } from './t3poc.mjs';

test('idle 5 minutes pauses and fresh activity does not', async () => {
  const calls = [];
  const api = createRuntime({
    now: () => 10_000 + IDLE_PAUSE_MS,
    log: () => {},
    readState: () => null,
    writeState: () => {},
    async suspend(id) {
      calls.push(['suspend', id]);
    },
  });
  api.backupHistory = async () => ({ ok: true });
  api.session.microvmId = 'mvm-1';
  api.session.vmState = 'RUNNING';
  api.session.lastActivityAt = 10_000;
  api.session.expiresAt = 10_000 + 8 * 3600 * 1000;
  assert.equal(decide(api.session, api.now()), 'pause');
  await onTick(api);
  assert.deepEqual(calls, [['suspend', 'mvm-1']]);
  assert.equal(api.session.vmState, 'SUSPENDED');
  api.session.vmState = 'RUNNING';
  api.session.lastActivityAt = api.now();
  assert.equal(decide(api.session, api.now()), 'none');
  api.session.inflight = 1;
  api.session.lastActivityAt = 10_000;
  assert.equal(decide(api.session, api.now()), 'pause');
  api.session.expiresAt = api.now() + SWAP_LEAD_MS;
  assert.equal(decide(api.session, api.now() + SWAP_LEAD_MS), 'swap');
});

test('7.5h swap backs up then replaces the VM, and aborts when history cannot be separated', async () => {
  const order = [];
  const api = createRuntime({
    now: () => 1_000,
    holdMs: 5_000,
    log: () => {},
    readState: () => null,
    writeState: () => order.push('state'),
    async terminate(id) {
      order.push(`terminate:${id}`);
    },
    async startMicrovm() {
      order.push('start');
      return { microvmId: 'mvm-2', endpoint: 'new.example', expiresAt: 9_000 };
    },
    async waitUntil() {},
    async shell() {
      return 'T3POC_SHELL_DONE';
    },
  });
  api.wipPush = async () => order.push('wip');
  api.backupHistory = async () => {
    order.push('backup');
    return { aborted: true, reason: 'sqlite table projection_threads contains a credential marker' };
  };
  api.emitVmReady = async () => order.push('ready');
  api.session.microvmId = 'mvm-1';
  api.session.endpoint = 'old.example';
  api.session.vmState = 'RUNNING';
  api.session.expiresAt = 1_000 + SWAP_LEAD_MS;
  api.session.lastActivityAt = 1_000;
  assert.equal(decide(api.session, 1_000 + SWAP_LEAD_MS), 'swap');
  await swap(api);
  assert.deepEqual(order, ['wip', 'backup', 'state']);
  assert.equal(api.session.microvmId, 'mvm-1');
  order.length = 0;
  api.backupHistory = async () => {
    order.push('backup');
    return { ok: true };
  };
  api.flags.nextSwapAt = 0;
  await swap(api);
  assert.deepEqual(order, ['wip', 'backup', 'start', 'state', 'ready', 'state', 'terminate:mvm-1', 'state']);
  assert.equal(api.session.microvmId, 'mvm-2');
});

test('concurrent request waits for complete replacement disk preparation', async () => {
  const { ensureVm } = await import('./ext-15-lazy.mjs').catch(() => ({ ensureVm: async () => {} }));
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const prep = new Promise((r) => {
    started = r;
  });
  const old = { microvmId: 'old', endpoint: 'old.example', vmState: 'RUNNING', diskPrepared: true };
  const api = createRuntime({
    now: () => 0,
    log() {},
    readState: () => old,
    writeState() {},
    getMicrovm: async () => ({ state: 'RUNNING' }),
    startMicrovm: async () => ({ microvmId: 'new', endpoint: 'new.example' }),
    waitUntil: async () => {},
    terminate: async () => {},
  });
  api.attach(old);
  await api.emitVmReady();
  api.hooks.beforeRequest.push(ensureVm);
  api.hooks.prepareDisk.push(async () => {
    started();
    await gate;
  });
  api.wipPush = async () => ({ ok: true });
  api.backupHistory = async () => ({ ok: true });
  const replacing = swap(api);
  await prep;
  let ready = false;
  const request = api.ensureReady().then(() => {
    ready = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ready, false);
  assert.equal(api.session.swapping, true);
  release();
  await replacing;
  await request;
  assert.equal(ready, true);
  assert.equal(api.session.diskPrepared, true);
});

test('WIP failure prevents replacement and preserves the old VM', async () => {
  let starts = 0,
    terminates = 0;
  const api = createRuntime({
    now: () => 0,
    log() {},
    readState: () => null,
    writeState() {},
    startMicrovm: async () => {
      starts++;
    },
    terminate: async () => {
      terminates++;
    },
  });
  api.attach({ microvmId: 'old', endpoint: 'old.example', vmState: 'RUNNING' });
  api.wipPush = async () => {
    throw Error('push denied');
  };
  api.backupHistory = async () => ({ ok: true });
  await swap(api);
  assert.equal(starts, 0);
  assert.equal(terminates, 0);
  assert.equal(api.session.microvmId, 'old');
});

test('ticks do not overlap and recover saved suspended sessions after relay restart', async () => {
  let release,
    reads = 0,
    ticks = 0;
  const gate = new Promise((r) => {
    release = r;
  });
  const api = createRuntime({
    now: () => 0,
    log() {},
    readState: () => ({ microvmId: 'saved', endpoint: 'saved.example' }),
    writeState() {},
    getMicrovm: async () => {
      reads++;
      return { state: 'SUSPENDED' };
    },
  });
  api.hooks.onTick.push(async () => {
    ticks++;
    await gate;
  });
  const a = api.tick(),
    b = api.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(ticks, 1);
  assert.equal(reads, 1);
  assert.equal(api.session.vmState, 'SUSPENDED');
  release();
  await Promise.all([a, b]);
});

test('failed replacement restoration terminates only the new VM and rolls back', async () => {
  const terminated = [];
  const api = createRuntime({
    readState: () => null,
    writeState() {},
    log() {},
    now: () => 0,
    startMicrovm: async () => ({ microvmId: 'new', endpoint: 'new.example' }),
    waitUntil: async () => {},
    terminate: async (id) => terminated.push(id),
  });
  api.attach({ microvmId: 'old', endpoint: 'old.example', vmState: 'RUNNING', diskPrepared: true });
  await api.emitVmReady();
  api.wipPush = async () => ({ ok: true });
  api.backupHistory = async () => ({ ok: true });
  api.hooks.prepareDisk.push(async () => {
    throw Error('restore denied');
  });
  await swap(api);
  assert.deepEqual(terminated, ['new']);
  assert.equal(api.session.microvmId, 'old');
  assert.equal(api.session.endpoint, 'old.example');
  assert.equal(api.flags.prepareDisk, false);
});

test('failed pause and swap back off for one minute', async () => {
  let now = IDLE_PAUSE_MS,
    backups = 0;
  const api = createRuntime({
    now: () => now,
    readState: () => null,
    writeState() {},
    log() {},
    suspend: async () => {
      throw Error('unavailable');
    },
  });
  api.attach({ microvmId: 'old', vmState: 'RUNNING', lastActivityAt: 0 });
  api.backupHistory = async () => {
    backups++;
    return { ok: true };
  };
  await onTick(api);
  await onTick(api);
  assert.equal(backups, 1);
  now += 60_000;
  await onTick(api);
  assert.equal(backups, 2);
  let pushes = 0;
  api.wipPush = async () => {
    pushes++;
    throw Error('push denied');
  };
  await swap(api);
  await swap(api);
  assert.equal(pushes, 1);
  now += 60_000;
  await swap(api);
  assert.equal(pushes, 2);
});

test('replacement is journaled before waiting and failed cleanup stays recoverable', async () => {
  let saved,
    waits = 0;
  const api = createRuntime({
    now: () => 0,
    readState: () => saved,
    writeState: (s) => {
      saved = structuredClone(s);
    },
    log() {},
    startMicrovm: async () => ({ microvmId: 'new', endpoint: 'new.example' }),
    waitUntil: async () => {
      waits++;
      assert.equal(saved.microvmId, 'old');
      assert.deepEqual(saved.cleanupMicrovmIds, ['new']);
      throw Error('boot failed');
    },
    terminate: async () => {
      throw Error('cleanup denied');
    },
  });
  api.attach({ microvmId: 'old', endpoint: 'old.example', vmState: 'RUNNING' });
  api.wipPush = async () => ({});
  api.backupHistory = async () => ({ ok: true });
  await swap(api);
  assert.equal(waits, 1);
  assert.equal(saved.microvmId, 'old');
  assert.deepEqual(saved.cleanupMicrovmIds, ['new']);
});

test('swap pushes WIP before an optional failed pairing snapshot', async (context) => {
  const extension = await import('./ext-30-pairing.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
  if (!extension) return context.skip('pairing extension is provided by PR #3');
  const { register } = extension;
  const order = [];
  const api = createRuntime({
    now: () => 0,
    readState: () => null,
    writeState() {},
    log() {},
    shell: async () => {
      order.push('pairing');
      throw Error('snapshot unavailable');
    },
    startMicrovm: async () => {
      order.push('start');
      return { microvmId: 'new', endpoint: 'new.example' };
    },
    waitUntil: async () => {},
    terminate: async () => {
      order.push('terminate');
    },
  });
  api.attach({ microvmId: 'old', vmState: 'RUNNING' });
  register(api);
  api.wipPush = async () => {
    order.push('wip');
  };
  api.backupHistory = async () => {
    order.push('history');
    return { ok: true };
  };
  api.emitVmReady = async () => {};
  await swap(api);
  assert.deepEqual(order, ['wip', 'pairing', 'history', 'start', 'terminate']);
});

test('suspended swap attempts WIP even when resume token refresh fails', async () => {
  const order = [];
  const api = createRuntime({
    now: () => 0,
    readState: () => null,
    writeState() {},
    log() {},
    resume: async () => {
      order.push('resume');
    },
    waitUntil: async () => {},
    startMicrovm: async () => {
      order.push('start');
      return { microvmId: 'new' };
    },
    terminate: async () => {
      order.push('terminate');
    },
  });
  api.attach({ microvmId: 'old', vmState: 'SUSPENDED' });
  api.hooks.onResume.push(async () => {
    order.push('refresh');
    throw Error('GitHub unavailable');
  });
  api.wipPush = async () => {
    order.push('wip');
    throw Error('push failed');
  };
  api.backupHistory = async () => ({ ok: true });
  await swap(api);
  assert.deepEqual(order, ['resume', 'refresh', 'wip']);
  assert.equal(api.session.microvmId, 'old');
  assert.equal(api.session.vmState, 'RUNNING');
});
