import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { authRowCount, shouldReplace } from './ext-30-pairing.mjs';
import { memoryKeychain } from './keychain.mjs';

test('pairing bundle keeps a real session over an empty new VM', () => {
  const previous = { auth_tables: [{ rows: [{ session_id: 's' }] }] };
  const empty = { auth_tables: [{ rows: [] }] };
  assert.equal(authRowCount(previous), 1);
  assert.equal(shouldReplace(previous, empty), false);
  assert.equal(shouldReplace(empty, previous), true);
});

test('keychain stand-in keeps bytes in memory', async () => {
  const kc = memoryKeychain();
  await kc.set('bundle', Buffer.from('secret-bytes'));
  assert.equal((await kc.get('bundle')).toString(), 'secret-bytes');
});

test('pairing secrets stay out of the history archive', () => {
  const result = spawnSync('python3.14', ['vm_history_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('secrets-only bundle is not overwritten by an empty VM', () => {
  assert.equal(shouldReplace({ secrets: [{ path: 'server.bin' }] }, { auth_tables: [], secrets: [] }), false);
  assert.equal(shouldReplace({ environment_id: 'existing' }, {}), false);
});

test('fresh server secret cannot overwrite authenticated pairing sessions', () => {
  assert.equal(
    shouldReplace(
      { auth_tables: [{ rows: [['active']] }], secrets: [{ path: 'old' }] },
      { auth_tables: [], secrets: [{ path: 'fresh' }] },
    ),
    false,
  );
});

test('pairing snapshot failure is a warning after WIP and does not block safe termination', async () => {
  const { createRuntime, stop } = await import('./t3poc.mjs');
  const { register } = await import('./ext-30-pairing.mjs');
  const order = [];
  const api = createRuntime({
    readState: () => ({ microvmId: 'old', endpoint: 'old.example' }),
    writeState() {},
    log() {},
    getMicrovm: async () => ({ state: 'RUNNING' }),
    removeState: async () => {},
    shell: async () => {
      order.push('pairing');
      throw Error('snapshot unavailable');
    },
    terminate: async () => {
      order.push('terminate');
    },
  });
  register(api);
  api.wipPush = async () => {
    order.push('wip');
  };
  await stop(api);
  assert.deepEqual(order, ['wip', 'pairing', 'terminate']);
});

test('transient Keychain read failure cannot overwrite or skip existing pairing', async () => {
  const { register } = await import('./ext-30-pairing.mjs');
  let writes = 0,
    mints = 0;
  const api = {
    deps: {
      keychain: () => ({
        get: async () => {
          throw Error('temporarily unavailable');
        },
        set: async () => {
          writes++;
        },
      }),
      mintPairing: async () => {
        mints++;
      },
    },
    hooks: { prepareDisk: [], onVmReady: [], beforeSwap: [], beforeStop: [], onTick: [] },
    flags: {},
    log() {},
  };
  register(api);
  await assert.rejects(() => api.savePairing({ auth_tables: [] }), /temporarily unavailable/);
  await assert.rejects(() => api.hooks.prepareDisk[0](api), /temporarily unavailable/);
  await assert.rejects(() => api.hooks.onVmReady[0](api), /temporarily unavailable/);
  assert.equal(writes, 0);
  assert.equal(mints, 0);
});
test('only explicit missing Keychain item allows initial pairing save and mint', async () => {
  const { register } = await import('./ext-30-pairing.mjs');
  let writes = 0,
    mints = 0;
  const api = {
    deps: {
      keychain: () => ({
        get: async () => {
          const e = Error('missing');
          e.code = 'KEYCHAIN_NOT_FOUND';
          throw e;
        },
        set: async () => {
          writes++;
        },
      }),
      mintPairing: async () => {
        mints++;
      },
    },
    hooks: { prepareDisk: [], onVmReady: [], beforeSwap: [], beforeStop: [], onTick: [] },
    flags: {},
    log() {},
  };
  register(api);
  await api.savePairing({ auth_tables: [] });
  await api.hooks.prepareDisk[0](api);
  await api.hooks.onVmReady[0](api);
  assert.equal(writes, 1);
  assert.equal(mints, 1);
});
