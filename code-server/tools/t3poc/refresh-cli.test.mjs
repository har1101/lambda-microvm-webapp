import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('standalone refresh rejects before accessing keychain or AWS', () => {
  const result = spawnSync(process.execPath, ['ghapp.mjs', 'refresh'], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Standalone refresh is disabled/);
});
