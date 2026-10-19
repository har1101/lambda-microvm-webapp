import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { captureLogins, captureScript, importLogin, injectScript, register, restoreLogins } from './ext-40-logins.mjs';
import { memoryKeychain } from './keychain.mjs';
import { captureNow } from './login-capture.mjs';
import { loginLaunchdOptions, loginPlist } from './login-launchd.mjs';
import { createRuntime } from './t3poc.mjs';

const fixture = (kind) => {
  const result = spawnSync('python3.14', [
    '-c',
    `from vm_logins_test import fixture\nfrom vm_logins import pack,minimal_files\nimport sys\nsys.stdout.buffer.write(pack(minimal_files('${kind}',fixture('${kind}'))))`,
  ]);
  assert.equal(result.status, 0);
  return result.stdout;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function runtime(shell, opts = { 'inject-logins': true }) {
  const keychain = memoryKeychain(),
    logs = [];
  const api = createRuntime({
    opts,
    env: {},
    shell,
    keychain: () => keychain,
    log: (line) => logs.push(line),
    now: () => 100_000,
    writeState() {},
    readState: () => null,
  });
  api.attach({ microvmId: 'fixture', endpoint: 'fixture', vmState: 'RUNNING' });
  register(api);
  return { api, keychain, logs };
}

test('hash first, export changes only, retain logged-out bundles and handle relay restart', async () => {
  let blob = fixture('codex'),
    exports = 0,
    probes = 0;
  const { api, keychain } = runtime(async ({ script, sensitive }) => {
    assert.equal(sensitive, true);
    if (script.includes('probe-claude')) return 'T3POC_LOGIN_EMPTY\n';
    if (script.includes('probe-codex')) {
      probes++;
      return `T3POC_LOGIN_HASH ${digest(blob)}\n`;
    }
    exports++;
    return `T3POC_LOGIN_BUNDLE ${blob.toString('base64')}\n`;
  });
  assert.equal((await captureLogins(api)).codex, 'captured');
  await captureLogins(api);
  assert.equal(exports, 1);
  assert.equal(probes, 2);
  await captureLogins(api);
  assert.equal(exports, 1);
  blob = Buffer.from(blob);
  blob[blob.indexOf('synthetic-access')] = 83;
  await captureLogins(api);
  assert.equal(exports, 2);
  const good = await keychain.get('codex');
  api.deps.shell = async () => 'T3POC_LOGIN_EMPTY\n';
  await captureLogins(api);
  assert.deepEqual(await keychain.get('codex'), good);
});

test('bad capture and Keychain/transport errors retain good bundle, sanitize logs and block swap/stop', async () => {
  const good = fixture('codex');
  for (const bad of ['invalid', 'mismatch', 'transport', 'keychain']) {
    const { api, keychain, logs } = runtime(async ({ script }) => {
      if (script.includes('probe-claude')) return 'T3POC_LOGIN_EMPTY\n';
      if (bad === 'transport') throw new Error('synthetic-secret');
      const next = bad === 'invalid' ? Buffer.from('invalid') : good;
      if (script.includes('probe-codex')) return `T3POC_LOGIN_HASH ${digest(next)}\n`;
      return `T3POC_LOGIN_BUNDLE ${(bad === 'mismatch' ? Buffer.from('wrong') : next).toString('base64')}\n`;
    });
    await keychain.set('codex', Buffer.from('previous-good'));
    if (bad === 'keychain')
      api.deps.keychain = () => ({
        get: keychain.get,
        set: () => {
          throw new Error('synthetic-secret');
        },
      });
    await assert.rejects(
      captureLogins(api),
      /^Error: login capture failed for codex; previous Keychain bundle retained$/,
    );
    assert.equal((await keychain.get('codex')).toString(), 'previous-good');
    await api.hooks.onTick[0](api);
    assert.doesNotMatch(logs.join('\n'), /synthetic-secret|synthetic-access/);
    await assert.rejects(api.hooks.beforeSwap[0](api));
    await assert.rejects(api.hooks.beforeStop[0](api));
  }
});

test('disabled hooks never touch credentials; periodic refresh is throttled; suspended VM rejected', async () => {
  let calls = 0;
  const { api } = runtime(async () => {
    calls++;
    return 'T3POC_LOGIN_EMPTY\n';
  }, {});
  await api.hooks.prepareDisk[0](api);
  await api.hooks.beforeSwap[0](api);
  await api.hooks.beforeStop[0](api);
  await api.hooks.onTick[0](api);
  assert.equal(calls, 0);
  await assert.rejects(captureLogins(api), /disabled/);
  api.deps.opts['inject-logins'] = true;
  await api.hooks.onTick[0](api);
  await api.hooks.onTick[0](api);
  assert.equal(calls, 2);
  api.session.vmState = 'SUSPENDED';
  await assert.rejects(captureLogins(api), /RUNNING/);
});

test('new VM injects before restart, existing VM never overwrites rotated tokens', async () => {
  const order = [];
  const { api, keychain } = runtime(async ({ script, sensitive }) => {
    if (script.includes('T3POC_T3_STOPPED')) {
      order.push('stop');
      return 'T3POC_T3_STOPPED';
    }
    if (script.includes('T3POC_T3_STARTED')) {
      order.push('start');
      return 'T3POC_T3_STARTED';
    }
    assert.equal(sensitive, true);
    order.push('inject');
    return 'T3POC_LOGIN_OK';
  });
  await keychain.set('codex', fixture('codex'));
  await restoreLogins(api);
  assert.deepEqual(order, []);
  api.flags.prepareDisk = true;
  await api.emitVmReady();
  assert.deepEqual(order, ['stop', 'inject', 'start']);
});

test('inject errors block readiness with sanitized errors', async () => {
  const { api, keychain } = runtime(async () => {
    throw new Error('synthetic-secret');
  });
  await keychain.set('codex', fixture('codex'));
  api.flags.prepareDisk = true;
  await assert.rejects(api.emitVmReady(), /^Error: login inject failed for codex$/);
});

test('secret payload is absent from executed argv and launchd injection needs opt-in', () => {
  const script = injectScript('codex', Buffer.from('synthetic-secret'));
  assert.doesNotMatch(
    script
      .split('\n')
      .filter((line) => line.includes('/usr/local/bin/python'))
      .join('\n'),
    /synthetic-secret|c3ludGhldGlj/,
  );
  assert.match(captureScript('codex'), /probe-codex/);
  const plist = '<array>\n    <string>relay</string>\n</array>';
  assert.equal(loginPlist(plist, false), plist);
  assert.match(loginPlist(plist, true), /--inject-logins/);
  let written;
  loginLaunchdOptions(true, (_dest, value) => {
    written = value;
  }).writeFileSync('/fixture', plist, {});
  assert.match(written, /--inject-logins/);
  assert.throws(() => loginPlist('bad plist', true));
});

test('capture-now CLI gate rejects before accessing VM or Keychain', async () => {
  await assert.rejects(
    captureNow(
      {},
      {
        readState() {
          throw new Error('should not read state');
        },
      },
      {},
    ),
    /requires --inject-logins/,
  );
  const keychain = memoryKeychain();
  const result = await captureNow(
    { 'inject-logins': true },
    {
      readState: () => ({ microvmId: 'fixture', endpoint: 'fixture' }),
      getMicrovm: async () => ({ state: 'RUNNING' }),
      keychain: () => keychain,
      shell: async () => 'T3POC_LOGIN_EMPTY\n',
    },
    {},
  );
  assert.deepEqual(result, { claude: 'retained', codex: 'retained' });
});

test('unchanged guest hash still requires a complete readable Keychain bundle before stop/swap', async () => {
  const blob = fixture('codex');
  const { api, keychain } = runtime(async ({ script }) => {
    if (script.includes('probe-claude')) return 'T3POC_LOGIN_EMPTY\n';
    if (script.includes('probe-codex')) return `T3POC_LOGIN_HASH ${digest(blob)}\n`;
    return `T3POC_LOGIN_BUNDLE ${blob.toString('base64')}\n`;
  });
  await captureLogins(api);
  api.deps.keychain = () => ({
    set: keychain.set,
    get: async () => {
      throw new Error('synthetic-secret');
    },
  });
  await assert.rejects(captureLogins(api), /login capture failed for codex/);
  await assert.rejects(api.hooks.beforeStop[0](api), /login capture failed for codex/);
  await assert.rejects(api.hooks.beforeSwap[0](api), /login capture failed for codex/);
});

test('relay restart recovers persisted diskPrepared:false before checkpointing readiness', async () => {
  const order = [];
  const { api, keychain } = runtime(async ({ script }) => {
    if (script.includes('T3POC_T3_STOPPED')) {
      order.push('stop');
      return 'T3POC_T3_STOPPED';
    }
    if (script.includes('T3POC_T3_STARTED')) {
      order.push('start');
      return 'T3POC_T3_STARTED';
    }
    order.push('inject');
    return 'T3POC_LOGIN_OK';
  });
  await keychain.set('codex', fixture('codex'));
  api.attach({ diskPrepared: false });
  assert.equal(api.flags.prepareDisk, false);
  await api.ensureReady();
  assert.deepEqual(order, ['stop', 'inject', 'start']);
  assert.equal(api.session.diskPrepared, true);
});

test('manual import strips unrelated credential and global state fields before Keychain persistence', async () => {
  const raw = spawnSync('python3.14', [
    '-c',
    "from vm_logins_test import fixture;from vm_logins import pack;import sys;sys.stdout.buffer.write(pack(fixture('claude')))",
  ]);
  assert.equal(raw.status, 0);
  assert.ok(raw.stdout.includes('omit'));
  const keychain = memoryKeychain();
  await importLogin('claude', raw.stdout, keychain);
  const stored = await keychain.get('claude');
  assert.ok(!stored.includes('omit'));
  assert.ok(!stored.includes('projects'));
  assert.deepEqual(stored, fixture('claude'));
});
