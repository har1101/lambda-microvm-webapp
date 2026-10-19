import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ensureVm } from './ext-15-lazy.mjs';
import { installLaunchAgent, renderLaunchAgent, uninstallLaunchAgent } from './launchd.mjs';
import { createRelay, createRuntime, parseArgs } from './t3poc.mjs';

test('boolean flag does not consume the next argument', () => {
  assert.deepEqual(parseArgs(['relay', '--inject-logins', '--port', '9000']), {
    command: 'relay',
    opts: { 'inject-logins': true, port: '9000' },
  });
});

test('holds the client until the MicroVM is ready', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let upstreamCalled = false;
  const server = createRelay({
    getEndpoint: async () => 'vm.example',
    getToken: async () => 'tok',
    clientHost: '127.0.0.1:8787',
    ensureReady: () => gate,
    request(_opts, cb) {
      upstreamCalled = true;
      const req = new PassThrough();
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 204;
        res.headers = {};
        cb(res);
        res.end();
      });
      return req;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const pending = fetch(`http://127.0.0.1:${server.address().port}/health`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(upstreamCalled, false);
  release();
  const response = await pending;
  assert.equal(response.status, 204);
  server.close();
  await once(server, 'close');
});

test('lazy start boots a missing VM and logs startup latency', async () => {
  const logs = [];
  let now = 1_000;
  const api = createRuntime({
    now: () => now,
    holdMs: 120_000,
    log: (message) => logs.push(message),
    readState: () => null,
    writeState: () => {},
    async getMicrovm() {
      return null;
    },
    async startMicrovm() {
      now += 2500;
      return { microvmId: 'mvm-new', endpoint: 'mvm.example', expiresAt: now + 8 * 3600 * 1000 };
    },
    async waitUntil() {},
    async shell() {
      return 'T3POC_SHELL_DONE';
    },
  });
  await ensureVm(api);
  assert.equal(api.session.microvmId, 'mvm-new');
  assert.match(logs.join('\n'), /startup latency 2500ms/);
});

test('overlapping requests share one boot', async () => {
  let starts = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = createRuntime({
    now: () => 0,
    holdMs: 1_000,
    log: () => {},
    readState: () => null,
    writeState: () => {},
  });
  api.hooks.beforeRequest.push(async () => {
    starts += 1;
    await gate;
    api.attach({ microvmId: 'mvm', endpoint: 'vm.example', vmState: 'RUNNING', diskPrepared: true });
  });
  const first = api.ensureReady();
  const second = api.ensureReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(starts, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(api.session.diskPrepared, true);
});

test('launchd plist runs the relay and can be removed', () => {
  const home = '/tmp/t3poc-launchd-test';
  const written = [];
  const plist = renderLaunchAgent({
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/t3poc.mjs',
    port: '8787',
    home,
    awsProfile: 'fukuchi',
  });
  assert.match(plist, /com\.t3poc\.relay/);
  assert.match(plist, /<string>relay<\/string>/);
  assert.match(plist, /8787/);
  assert.doesNotMatch(plist, /0\.0\.0\.0/);
  const { dest } = installLaunchAgent({
    home,
    scriptPath: '/opt/t3poc.mjs',
    platform: 'linux',
    writeFileSync: (_dest, body) => written.push(body),
    mkdirSync: () => {},
  });
  assert.equal(dest, `${home}/Library/LaunchAgents/com.t3poc.relay.plist`);
  assert.match(written[0], /AWS_PROFILE/);
  let removed = '';
  uninstallLaunchAgent({
    home,
    platform: 'linux',
    rmSync: (target) => {
      removed = target;
    },
  });
  assert.equal(removed, dest);
});
