import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createProxyTokenCache, createRuntime } from './t3poc.mjs';
import { pythonInvocation, shellExec, VM_PYTHON } from './vm-shell.mjs';

test('all guest Python invocations use pinned interpreter and private RAM staging', async () => {
  for (const [command, dest] of [
    ['restore', undefined],
    ['extract', '/dev/shm/claude'],
  ]) {
    const script = pythonInvocation('print("dummy")', command, Buffer.from('dummy'), dest);
    assert.ok(script.includes(VM_PYTHON));
    assert.ok(script.includes('mktemp -d /dev/shm/'));
    assert.equal(/(?:^|\n)python3 /.test(script), false);
    assert.equal(script.includes('/dev/shm/t3poc-payload'), false);
    assert.ok(script.includes('vm_fs.py'));
    assert.ok(script.includes('chown -R vscode:vscode'));
    assert.ok(script.includes('su -s /bin/sh vscode'));
    const { spawnSync } = await import('node:child_process');
    assert.equal(spawnSync('/bin/bash', ['-n'], { input: script }).status, 0);
  }
});

test('lifecycle queue holds new requests while replacement is being prepared', async () => {
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  const api = createRuntime({ readState: () => null, writeState() {}, log() {} });
  api.attach({ microvmId: 'old', endpoint: 'old.example', vmState: 'RUNNING' });
  await api.emitVmReady();
  const change = api.exclusive(async () => {
    api.attach({ microvmId: 'new', endpoint: 'new.example' });
    entered();
    await gate;
  });
  await started;
  let ready = false;
  const request = api.ensureReady().then(() => {
    ready = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ready, false);
  release();
  await change;
  await request;
  assert.equal(ready, true);
});

test('token cache changes VM identity rather than only refreshing on time', async () => {
  const session = { microvmId: 'old' };
  const get = createProxyTokenCache(
    () => session,
    async (id) => ({ value: id, refreshAt: Infinity }),
  );
  assert.equal(await get(), 'old');
  session.microvmId = 'new';
  assert.equal(await get(), 'new');
});

test('shell waits for an output marker rather than its echoed command', async () => {
  let completed = false;
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send(script) {
      this.emit('message', Buffer.from(script));
      setTimeout(() => {
        completed = true;
        this.emit('message', Buffer.from('\nT3POC_SHELL_DONE\n'));
      }, 20);
    }
    close() {}
  }
  await shellExec({ endpoint: 'mock', token: 'dummy', script: 'echo T3POC_SHELL_DONE', WebSocket: Socket });
  assert.equal(completed, true);
});

test('endpoint and token are captured together while swap waits for a pending mint', async () => {
  const { createConnectionProvider } = await import('./t3poc.mjs');
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  const api = createRuntime({ readState: () => null, writeState() {} });
  api.attach({ microvmId: 'old', endpoint: 'old.example' });
  const get = createConnectionProvider(api, async () => {
    entered();
    await gate;
    return api.session.microvmId;
  });
  const connection = get();
  await started;
  let swapped = false;
  const swap = api.exclusive(async () => {
    api.attach({ microvmId: 'new', endpoint: 'new.example' });
    swapped = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(swapped, false);
  release();
  assert.deepEqual(await connection, { endpoint: 'old.example', token: 'old' });
  await swap;
});

test('pairing failure never reruns the command as root', async () => {
  const { pairingScript } = await import('./t3poc.mjs');
  const script = pairingScript('t3 auth pairing create');
  assert.equal(script.split('t3 auth pairing create').length, 2);
  assert.equal(script.includes('||'), false);
  assert.match(script, /^su -s \/bin\/sh vscode/);
});

test('ready hook failure checkpoints disk preparation and backs off without restoring again', async () => {
  let now = 0,
    prepared = 0,
    hooks = 0,
    saved;
  const api = createRuntime({
    now: () => now,
    readState: () => saved,
    writeState: (s) => {
      saved = structuredClone(s);
    },
  });
  api.attach({ microvmId: 'vm', endpoint: 'vm.example', vmState: 'RUNNING', diskPrepared: false });
  api.flags.prepareDisk = true;
  api.hooks.prepareDisk.push(async () => {
    prepared++;
  });
  api.hooks.onVmReady.push(async () => {
    hooks++;
    if (hooks === 1) throw Error('token unavailable');
  });
  await assert.rejects(api.emitVmReady(), /token unavailable/);
  assert.equal(saved.diskPrepared, true);
  await assert.rejects(api.emitVmReady(), /retry deferred/);
  assert.equal(hooks, 1);
  now = 60_000;
  await api.emitVmReady();
  assert.equal(hooks, 2);
  assert.equal(prepared, 1);
});

test('restart cleans journaled replacements before any request and retains failed cleanup IDs', async () => {
  let saved = { microvmId: 'old', endpoint: 'old.example', cleanupMicrovmIds: ['new'] };
  let denied = true;
  let now = 0;
  const terminated = [];
  const api = createRuntime({
    readState: () => saved,
    now: () => now,
    writeState: (s) => {
      saved = structuredClone(s);
    },
    terminate: async (id) => {
      terminated.push(id);
      if (denied) throw Error('denied');
    },
  });
  await assert.rejects(api.ensureReady(), /denied/);
  assert.deepEqual(saved.cleanupMicrovmIds, ['new']);
  denied = false;
  await assert.rejects(api.ensureReady(), /cleanup retry deferred/);
  assert.deepEqual(terminated, ['new']);
  now = 60_000;
  await api.ensureReady();
  assert.deepEqual(terminated, ['new', 'new']);
  assert.deepEqual(saved.cleanupMicrovmIds, []);
  assert.equal(saved.microvmId, 'old');
});

test('stop saves WIP despite resume token failure, then terminates primary before failed cleanup', async () => {
  const { stop } = await import('./t3poc.mjs');
  let state = { microvmId: 'old', endpoint: 'old.example', cleanupMicrovmIds: ['orphan'] };
  let phase = 'SUSPENDED',
    cleanupFails = true,
    removed = false;
  const order = [];
  const api = createRuntime({
    readState: () => state,
    writeState: (s) => {
      state = structuredClone(s);
    },
    log() {},
    getMicrovm: async () => ({ state: phase }),
    resume: async () => {
      order.push('resume');
    },
    waitUntil: async () => {},
    removeState: async () => {
      removed = true;
    },
    terminate: async (id) => {
      order.push(`terminate:${id}`);
      if (id === 'old') phase = 'TERMINATED';
      else if (cleanupFails) throw Error('cleanup denied');
    },
  });
  api.hooks.onResume.push(async () => {
    order.push('refresh');
    throw Error('GitHub unavailable');
  });
  api.wipPush = async () => {
    order.push('wip');
  };
  api.hooks.beforeStop.push(async () => {
    order.push('history');
  });
  await assert.rejects(stop(api), /cleanup denied/);
  assert.deepEqual(order, ['resume', 'refresh', 'wip', 'history', 'terminate:old', 'terminate:orphan']);
  assert.equal(removed, false);
  assert.deepEqual(state.cleanupMicrovmIds, ['orphan']);
  cleanupFails = false;
  await stop(api);
  assert.equal(removed, true);
  assert.equal(order.filter((v) => v === 'wip').length, 1);
});

test('stop still preserves the VM when WIP fails after a resume token failure', async () => {
  const { stop } = await import('./t3poc.mjs');
  let terminated = false;
  const api = createRuntime({
    readState: () => ({ microvmId: 'old' }),
    writeState() {},
    log() {},
    getMicrovm: async () => ({ state: 'SUSPENDED' }),
    resume: async () => {},
    waitUntil: async () => {},
    terminate: async () => {
      terminated = true;
    },
  });
  api.hooks.onResume.push(async () => {
    throw Error('token unavailable');
  });
  api.wipPush = async () => {
    throw Error('WIP push failed');
  };
  await assert.rejects(stop(api), /WIP push failed/);
  assert.equal(terminated, false);
});
