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
  const result = spawnSync('python3', ['vm_history_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
