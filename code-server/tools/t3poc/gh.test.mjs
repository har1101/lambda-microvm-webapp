import assert from 'node:assert/strict';
import test from 'node:test';
import { pushScript, pushToVm, REFRESH_EVERY_MS } from './ghapp.mjs';

test('gh push script never contains the token and refresh is 50 minutes', async () => {
  const token = 'ghs_exampletokenvalue1234567890';
  const script = pushScript();
  assert.equal(script.includes(token), false);
  assert.match(script, /\/dev\/shm\/gh-token/);
  assert.equal(REFRESH_EVERY_MS, 50 * 60 * 1000);
  const seen = [];
  await pushToVm({
    mint: async () => ({ token, expires_at: '2099-01-01T00:00:00Z' }),
    shell: async ({ script: sent, stdin }) => {
      seen.push(sent, stdin);
      return 'T3RES:ai-native-factory/t3poc-sandbox\nT3POC_SHELL_DONE';
    },
    log: (message) => seen.push(message),
  });
  assert.equal(seen[0].includes(token), false);
  assert.equal(seen[1], Buffer.from(token).toString('base64'));
  assert.equal(
    seen.some((line) => String(line).includes(token)),
    false,
  );
});

test('failed token write cannot be confirmed by a successful API using the old token', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-gh-failure-'));
  fs.writeFileSync(path.join(dir, 'gh-token'), 'old-dummy');
  fs.writeFileSync(path.join(dir, 'python'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const local = pushScript()
    .replaceAll('/dev/shm', dir)
    .replace('/usr/local/bin/python3.14', path.join(dir, 'python'))
    .replace('su -s /bin/sh vscode -c', 'bash -c');
  const out = spawnSync(
    '/bin/bash',
    ['-c', `function gh(){ echo ai-native-factory/t3poc-sandbox; }; export -f gh; ${local}`],
    { input: Buffer.from('new-dummy').toString('base64') + '\n', encoding: 'utf8' },
  );
  assert.equal(out.stdout.includes('T3RES:ai-native-factory/t3poc-sandbox'), false);
  assert.equal(fs.readFileSync(path.join(dir, 'gh-token'), 'utf8'), 'old-dummy');
  fs.writeFileSync(path.join(dir, 'python'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o700 });
  const successful = spawnSync(
    '/bin/bash',
    ['-c', `function gh(){ echo ai-native-factory/t3poc-sandbox; }; export -f gh; ${local}`],
    { input: `${Buffer.from('new-dummy').toString('base64')}\n`, encoding: 'utf8' },
  );
  assert.equal(successful.stdout.includes('T3RES:ai-native-factory/t3poc-sandbox'), true, successful.stderr);
});

test('refresh retries before expiry and suspended VMs refresh on resume', async () => {
  const { createRuntime } = await import('./t3poc.mjs');
  const { register, RETRY_MS } = await import('./ext-50-gh.mjs');
  let now = 0,
    calls = 0,
    fail = false;
  const api = createRuntime({
    now: () => now,
    readState: () => null,
    writeState() {},
    log() {},
    mintToken: async () => {
      calls++;
      if (fail) throw Error('temporary');
      return { token: 'ghs_dummy_token_01234567890123456789', expires_at: new Date(now + 3600000).toISOString() };
    },
    shell: async () => 'T3RES:ai-native-factory/t3poc-sandbox\nT3POC_SHELL_DONE',
  });
  register(api);
  api.attach({ microvmId: 'vm', vmState: 'RUNNING' });
  await api.emitVmReady();
  assert.equal(calls, 1);
  now = REFRESH_EVERY_MS;
  fail = true;
  await api.tick();
  assert.equal(calls, 2);
  fail = false;
  now += RETRY_MS;
  await api.tick();
  assert.equal(calls, 3);
  api.session.vmState = 'SUSPENDED';
  now += REFRESH_EVERY_MS;
  await api.tick();
  assert.equal(calls, 3);
  api.session.vmState = 'RUNNING';
  for (const fn of api.hooks.onResume) await fn(api);
  assert.equal(calls, 4);
});
