import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE_START, register, resourceScript } from './ext-15-resources.mjs';
import { START_T3, STOP_T3 } from './vm-shell.mjs';

function fixture() {
  const calls = [];
  const api = {
    deps: {
      shell: async (request) => {
        calls.push(request);
        return 'T3POC_T3_STOPPED T3POC_RAM_OK T3POC_T3_STARTED';
      },
    },
    hooks: { prepareDisk: [], onVmReady: [], onTick: [] },
    flags: {},
    session: { microvmId: 'fixture-vm' },
    now: () => 1000,
    log: () => {},
  };
  register(api);
  return { api, calls };
}

test('all restart paths apply bounded RAM traces and discard stdout logs', async () => {
  const { api, calls } = fixture();
  await api.deps.shell({ script: START_T3 });
  assert.equal(calls[0].script, RESOURCE_START);
  assert.match(RESOURCE_START, /T3CODE_TRACE_MAX_BYTES=262144 T3CODE_TRACE_MAX_FILES=1 T3CODE_TRACE_MIN_LEVEL=Warn/);
  assert.match(RESOURCE_START, />\/dev\/null/);
  assert.doesNotMatch(RESOURCE_START, /t3-serve.log/);
});

test('new and reattached VMs configure before readiness, once per VM identity', async () => {
  const { api, calls } = fixture();
  await api.hooks.prepareDisk[0](api);
  await api.hooks.onVmReady[0](api);
  const count = calls.length;
  await api.hooks.onVmReady[0](api);
  assert.equal(calls.length, count);
  api.session.microvmId = 'replacement';
  await api.hooks.onVmReady[0](api);
  assert.ok(calls.length > count);
});

test('large transfer refuses execution when RAM preflight fails', async () => {
  const { api, calls } = fixture();
  await api.deps.shell({ script: 'x'.repeat(20000) });
  assert.equal(calls.length, 2);
  const failed = fixture();
  // The captured underlying shell returns no completion marker.
  const api2 = {
    ...failed.api,
    deps: { shell: async () => '' },
    hooks: { prepareDisk: [], onVmReady: [], onTick: [] },
  };
  register(api2);
  await assert.rejects(api2.deps.shell({ script: 'x'.repeat(20000) }), /RAM reserve/);
});

test('RAM monitor logs only numeric usage and threshold warnings once a minute', async () => {
  const messages = [];
  const api = {
    deps: { shell: async () => 'T3POC_RAM {"used":60,"total":64,"free":4,"worktrees":9,"warning":true}' },
    hooks: { prepareDisk: [], onVmReady: [], onTick: [] },
    flags: {},
    session: { microvmId: 'fixture', vmState: 'RUNNING' },
    now: () => 1000,
    log: (s) => messages.push(s),
  };
  register(api);
  await api.hooks.onTick[0](api);
  await api.hooks.onTick[0](api);
  assert.deepEqual(messages, ['RAM WARNING used=60 total=64 free=4 worktrees=9']);
});

test('policy stops producers before configuration and restarts T3 if configuration fails', async () => {
  const { api, calls } = fixture();
  await api.hooks.onVmReady[0](api);
  assert.equal(calls[0].script, STOP_T3);
  assert.equal(calls[1].script, resourceScript({ catalog: true }));
  assert.ok(Buffer.byteLength(resourceScript({ catalog: true })) > 16384);
  const requests = [];
  const runtime = {
    deps: {
      shell: async (request) => {
        requests.push(request);
        if (request.script === STOP_T3) return 'T3POC_T3_STOPPED';
        if (request.script === RESOURCE_START) return 'T3POC_T3_STARTED';
        return 'T3POC_SHELL_DONE';
      },
    },
    hooks: { prepareDisk: [], onVmReady: [], onTick: [] },
    session: { microvmId: 'fixture' },
    flags: {},
    now: () => 0,
    log() {},
  };
  register(runtime);
  await assert.rejects(runtime.hooks.onVmReady[0](runtime), /catalog policy failed/);
  assert.deepEqual(
    requests.map((x) => x.script),
    [STOP_T3, resourceScript({ catalog: true }), RESOURCE_START],
  );
  assert.equal(runtime.flags.t3Stopped, false);
});
