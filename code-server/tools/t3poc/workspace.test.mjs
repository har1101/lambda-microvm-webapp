import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { historyLocation, parseEmit } from './t3-history.mjs';
import { cloneScript, parseRepos } from './workspace.mjs';

test('clone script reads GH_TOKEN inside the VM and rejects odd repo names', () => {
  const script = cloneScript(['ai-native-factory/t3poc-sandbox']);
  assert.match(script, /\/dev\/shm\/gh-token/);
  assert.doesNotMatch(script, /ghp_|github_pat_|x-access-token/i);
  assert.throws(() => parseRepos('org/repo;rm'));
});

test('history upload uses the t3poc bucket and the t3poc KMS alias', () => {
  assert.deepEqual(historyLocation('064212132988'), {
    Bucket: 't3poc-auth-064212132988-ap-northeast-1',
    Key: 't3-history/latest.tar',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: 'alias/t3poc-auth-state',
  });
  const parsed = parseEmit(`noise\nT3POC_HISTORY_B64\n${Buffer.from('tar').toString('base64')}\nT3POC_HISTORY_END\n`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.history.toString(), 'tar');
  const aborted = parseEmit('T3POC_BACKUP_ABORT sqlite table notes contains a credential marker');
  assert.equal(aborted.aborted, true);
  assert.match(aborted.reason, /credential marker/);
});

test('vm history exclusion list', () => {
  const history = spawnSync('python3', ['vm_history_test.py'], { encoding: 'utf8' });
  assert.equal(history.status, 0, history.stdout + history.stderr);
});
