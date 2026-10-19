import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('T3 image repeat WIP snapshots fast-forward without altering the user index', () => {
  const result = spawnSync('python3.14', ['vm_wip_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
