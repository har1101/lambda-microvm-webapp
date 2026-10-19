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
  assert.deepEqual(order, ['wip', 'backup']);
  assert.equal(api.session.microvmId, 'mvm-1');
  order.length = 0;
  api.backupHistory = async () => {
    order.push('backup');
    return { ok: true };
  };
  await swap(api);
  assert.deepEqual(order, ['wip', 'backup', 'start', 'ready', 'state', 'terminate:mvm-1']);
  assert.equal(api.session.microvmId, 'mvm-2');
});
