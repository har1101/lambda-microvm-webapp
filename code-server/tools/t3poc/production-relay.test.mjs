import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { IDLE_PAUSE_MS, register as idle } from './ext-16-idle.mjs';
import { createRuntime, relay } from './t3poc.mjs';

test('production relay timer pauses after lazy first request and resumes on next request', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1000;
  let saved = null;
  let state = 'RUNNING';
  let starts = 0;
  const events = [];
  const api = createRuntime({
    now: () => now,
    readState: () => saved,
    writeState: (s) => {
      saved = structuredClone(s);
    },
    log: (s) => events.push(s),
    getMicrovm: async () => ({ state }),
    startMicrovm: async () => {
      starts++;
      return { microvmId: 'vm', endpoint: 'vm.example', expiresAt: now + 28800000 };
    },
    waitUntil: async () => {},
    suspend: async () => {
      state = 'SUSPENDED';
      events.push('suspend');
    },
    resume: async () => {
      state = 'RUNNING';
      events.push('resume');
    },
  });
  // #2 supplies lazy boot; run the same test in #7 alone using a beforeRequest
  // hook with the same session transitions. Integration must use the real #2.
  const lazy = await import('./ext-15-lazy.mjs').catch((e) => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return {
      register(runtime) {
        runtime.hooks.beforeRequest.push(async () => {
          if (runtime.session.microvmId) return;
          runtime.attach({
            ...(await runtime.deps.startMicrovm()),
            vmState: 'RUNNING',
            lastActivityAt: now,
            diskPrepared: true,
          });
        });
      },
    };
  });
  lazy.register(api);
  idle(api);
  api.backupHistory = async () => ({ ok: true });
  const timerTicks = [];
  const tick = api.tick.bind(api);
  api.tick = () => {
    const pending = tick();
    timerTicks.push(pending);
    return pending;
  };
  const server = await relay(
    api,
    { port: '0' },
    {
      getToken: async () => 'dummy',
      request(_options, callback) {
        const request = new PassThrough();
        process.nextTick(() => {
          const response = new PassThrough();
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          response.end('ready');
        });
        return request;
      },
    },
  );
  t.after(() => server.close());
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/health`;
  assert.equal(await (await fetch(url)).text(), 'ready');
  const lastByte = api.session.lastActivityAt;
  now = lastByte + IDLE_PAUSE_MS - 1;
  t.mock.timers.tick(15000);
  assert.equal(timerTicks.length, 1);
  await timerTicks[0];
  assert.equal(state, 'RUNNING');
  now++;
  t.mock.timers.tick(15000);
  assert.equal(timerTicks.length, 2);
  await timerTicks[1];
  assert.equal(state, 'SUSPENDED');
  assert.equal(await (await fetch(url)).text(), 'ready');
  assert.equal(state, 'RUNNING');
  assert.equal(starts, 1);
  assert.deepEqual(
    events.filter((e) => ['suspend', 'resume'].includes(e)),
    ['suspend', 'resume'],
  );
});

test('new bytes during idle backup cancel pause with an explicit reason', async () => {
  let now = IDLE_PAUSE_MS;
  const logs = [];
  const api = createRuntime({
    now: () => now,
    readState: () => null,
    writeState() {},
    log: (s) => logs.push(s),
    suspend: async () => {
      throw Error('must not suspend');
    },
  });
  api.attach({ microvmId: 'vm', vmState: 'RUNNING', lastActivityAt: 0 });
  idle(api);
  api.backupHistory = async () => {
    now++;
    api.session.lastActivityAt = now;
    return { ok: true };
  };
  await api.tick();
  assert.ok(logs.some((s) => s.includes('pause skipped: activity during backup')));
  assert.equal(api.session.vmState, 'RUNNING');
});
