import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { macKeychain as lockedMacKeychain, rawMacKeychain as macKeychain } from './keychain.mjs';

function fake() {
  const values = new Map();
  const lines = [];
  let failAt = Infinity;
  let writes = 0;
  let truncateAt = Infinity;
  let failRead = false;
  let failDelete = false;
  let partialAt = Infinity;
  const io = {
    spawnSync(command, args, opts) {
      assert.equal(command, '/usr/bin/security');
      assert.deepEqual(args, ['-i']);
      const line = opts.input;
      lines.push(line);
      assert.ok(Buffer.byteLength(line) < 1024, 'security -i line stays below its parser limit');
      const match = line.match(/^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/);
      assert.ok(match);
      assert.equal(match[1], 'test');
      if (++writes === failAt) return { status: 1 };
      values.set(match[2], writes === truncateAt ? match[3].slice(0, 8) : match[3]);
      if (writes === partialAt) return { status: 1 };
      return { status: 0 };
    },
    execFileSync(command, args, opts) {
      assert.equal(command, '/usr/bin/security');
      assert.ok(opts.stdio.includes('pipe'));
      assert.equal(args[args.indexOf('-s') + 1], 'test');
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'delete-generic-password') {
        if (failDelete && account === 'bundle') throw Error('delete unavailable');
        values.delete(account);
        return '';
      }
      assert.equal(args[0], 'find-generic-password');
      if (failRead) {
        failRead = false;
        throw Error('temporary failure');
      }
      if (!values.has(account)) {
        const error = Error('missing');
        error.status = 44;
        throw error;
      }
      return `${values.get(account)}\n`;
    },
  };
  return {
    values,
    lines,
    partialPublishDeleteFailure() {
      partialAt = writes + 2;
      failDelete = true;
    },
    failReadNext() {
      failRead = true;
    },
    keychain: macKeychain('test', io),
    truncateNext(offset = 1) {
      truncateAt = writes + offset;
    },
    failNext(offset = 1) {
      failAt = writes + offset;
    },
  };
}
test('large pairing bundle round-trips with short stdin lines and cleans prior chunks', () => {
  const f = fake();
  const value = Buffer.from('synthetic-pairing-data'.repeat(1500));
  f.keychain.set('bundle', value);
  assert.deepEqual(f.keychain.get('bundle'), value);
  const oldAccounts = [...f.values.keys()].filter((x) => x !== 'bundle');
  f.keychain.set('bundle', Buffer.from('replacement'));
  assert.equal(f.keychain.get('bundle').toString(), 'replacement');
  assert.ok(oldAccounts.every((x) => !f.values.has(x)));
});
test('chunk write failure preserves previous complete generation', () => {
  const f = fake();
  f.keychain.set('bundle', Buffer.from('prior'));
  const accounts = [...f.values.keys()].sort();
  f.failNext(2);
  assert.throws(() => f.keychain.set('bundle', Buffer.alloc(4000, 120)), /write failed/);
  assert.equal(f.keychain.get('bundle').toString(), 'prior');
  assert.deepEqual([...f.values.keys()].sort(), accounts);
});
test('manifest write failure preserves previous complete generation', () => {
  const f = fake();
  f.keychain.set('bundle', Buffer.from('prior'));
  f.failNext(2);
  assert.throws(() => f.keychain.set('bundle', Buffer.from('replacement')), /write failed/);
  assert.equal(f.keychain.get('bundle').toString(), 'prior');
});
test('missing and corrupt chunks fail closed', () => {
  for (const corrupt of [false, true]) {
    const f = fake();
    f.keychain.set('bundle', Buffer.from('payload'));
    const key = [...f.values.keys()].find((x) => x !== 'bundle');
    if (corrupt) f.values.set(key, Buffer.from('modified').toString('base64'));
    else f.values.delete(key);
    assert.throws(
      () => f.keychain.get('bundle'),
      (error) => error.code === undefined && /chunk unavailable|integrity/.test(error.message),
    );
  }
});
test('legacy values and empty values remain supported', () => {
  const f = fake();
  f.values.set('bundle', Buffer.from('legacy').toString('base64'));
  assert.equal(f.keychain.get('bundle').toString(), 'legacy');
  f.keychain.set('bundle', Buffer.alloc(0));
  assert.equal(f.keychain.get('bundle').length, 0);
});
test('oversized input is rejected before mutation', () => {
  const f = fake();
  assert.throws(() => f.keychain.set('bundle', Buffer.alloc(16 * 1024 * 1024 + 1)), /too large/);
  assert.equal(f.values.size, 0);
});

test('silent chunk truncation refuses publish and retains previous generation', () => {
  const f = fake();
  f.keychain.set('bundle', Buffer.from('prior'));
  f.truncateNext();
  assert.throws(() => f.keychain.set('bundle', Buffer.alloc(2000, 120)), /write failed/);
  assert.equal(f.keychain.get('bundle').toString(), 'prior');
});
test('silent manifest truncation rolls back the previous pointer', () => {
  const f = fake();
  f.keychain.set('bundle', Buffer.from('prior'));
  f.truncateNext(2);
  assert.throws(() => f.keychain.set('bundle', Buffer.from('replacement')), /write failed/);
  assert.equal(f.keychain.get('bundle').toString(), 'prior');
});
test('invalid manifest errors never include stored content', () => {
  const f = fake();
  f.values.set('bundle', Buffer.from('T3POC_CHUNKED_V1:SYNTHETIC_PRIVATE').toString('base64'));
  assert.throws(
    () => f.keychain.get('bundle'),
    (error) => error.message === 'invalid keychain manifest',
  );
});

test('temporary read failure refuses all writes and preserves prior generation', () => {
  const f = fake();
  f.keychain.set('bundle', Buffer.from('prior'));
  const lines = f.lines.length;
  f.failReadNext();
  assert.throws(() => f.keychain.set('bundle', Buffer.from('replacement')), /read failed/);
  assert.equal(f.lines.length, lines);
  assert.equal(f.keychain.get('bundle').toString(), 'prior');
});
test('null manifest fails with fixed error', () => {
  const f = fake();
  f.values.set('bundle', Buffer.from('T3POC_CHUNKED_V1:null').toString('base64'));
  assert.throws(
    () => f.keychain.get('bundle'),
    (error) => error.message === 'invalid keychain manifest',
  );
});
test('Mac lockf serializes processes and a crashed command releases the lock', {
  skip: process.platform !== 'darwin',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-lock-test-'));
  const file = path.join(root, 'lock');
  try {
    const child = `const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/bin/lockf',['-k','-s','-t','0',process.argv[1],'/usr/bin/true']);process.exit(r.status===0?1:0);`;
    execFileSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, process.execPath, '-e', child, file], {
      stdio: 'pipe',
    });
    assert.throws(() =>
      execFileSync(
        '/usr/bin/lockf',
        ['-k', '-s', '-t', '0', file, process.execPath, '-e', 'process.kill(process.pid,"SIGKILL")'],
        { stdio: 'pipe' },
      ),
    );
    execFileSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/usr/bin/true'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('truncated worker input aborts before any Keychain operation', () => {
  const worker = new URL('./keychain-worker.mjs', import.meta.url);
  assert.throws(
    () =>
      execFileSync(process.execPath, [worker.pathname, 'set', 'synthetic', 'probe'], {
        input: '{"b64":"cGFydGlhbA=="',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    (error) => error.status === 1,
  );
});

test('first publish partial success and failed delete retain referenced chunks', () => {
  const f = fake();
  f.partialPublishDeleteFailure();
  assert.throws(() => f.keychain.set('bundle', Buffer.from('preserved')), /write failed/);
  assert.equal(f.keychain.get('bundle').toString(), 'preserved');
});

test('public worker boundary preserves notfound while distinguishing temporary failure', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-boundary-'));
  const root = path.join(parent, 'locks');
  try {
    for (const status of [44, 1]) {
      const keychain = lockedMacKeychain('test', { spawnSync: () => ({ status }) }, root);
      assert.throws(
        () => keychain.get('bundle'),
        (error) => (status === 44 ? error.code === 'KEYCHAIN_NOT_FOUND' : error.code === undefined),
      );
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
