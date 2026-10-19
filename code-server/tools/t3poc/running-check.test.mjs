import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureVm, RUNNING_CHECK_MS } from './ext-15-lazy.mjs';
import { createRuntime } from './t3poc.mjs';

function fixture() {
  let now = 1000;
  let calls = 0;
  let result = { state: 'RUNNING' };
  const api = createRuntime({
    now: () => now,
    readState: () => null,
    writeState: () => {},
    getMicrovm: async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  });
  api.attach({ microvmId: 'vm-a', endpoint: 'a.example', vmState: 'RUNNING', diskPrepared: true });
  return {
    api,
    calls: () => calls,
    advance: (ms) => {
      now += ms;
    },
    result: (value) => {
      result = value;
    },
  };
}

test('a burst of asset requests shares a bounded RUNNING observation without extending its deadline', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) {
    await ensureVm(f.api);
    f.advance(100);
  }
  assert.equal(f.calls(), 1);
  f.advance(RUNNING_CHECK_MS - 5000);
  await ensureVm(f.api);
  assert.equal(f.calls(), 2);
});

test('VM identity and local suspend transitions invalidate the RUNNING observation', async () => {
  const f = fixture();
  await ensureVm(f.api);
  f.api.attach({ microvmId: 'vm-b', endpoint: 'b.example' });
  await ensureVm(f.api);
  assert.equal(f.calls(), 2);
  f.api.attach({ vmState: 'SUSPENDED' });
  f.result({ state: 'SUSPENDED' });
  await ensureVm(f.api);
  assert.equal(f.calls(), 3);
  assert.equal(f.api.flags.runningCheck, undefined);
});

test('failed observations are retried and expiry cannot use a cached RUNNING state', async () => {
  const f = fixture();
  f.result(new Error('temporary control-plane failure'));
  await assert.rejects(ensureVm(f.api));
  f.result({ state: 'RUNNING' });
  await ensureVm(f.api);
  assert.equal(f.calls(), 2);
  f.api.attach({ expiresAt: 1000 });
  await ensureVm(f.api);
  assert.equal(f.calls(), 3);
});
