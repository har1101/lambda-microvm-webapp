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
  const history = spawnSync('python3.14', ['vm_history_test.py'], { encoding: 'utf8' });
  assert.equal(history.status, 0, history.stdout + history.stderr);
});

test('WIP error and traversal names are fail-closed', async () => {
  const { pushWip, WIP_PROGRAM } = await import('./workspace.mjs');
  await assert.rejects(pushWip({ deps: { shell: async () => 'T3POC_SHELL_DONE' }, log() {} }), /refusing/);
  for (const repo of ['org/..', '../repo', 'org/.']) assert.throws(() => parseRepos(repo));
  const { spawnSync } = await import('node:child_process');
  const program = `import runpy; runpy.run_path=lambda p:{'run_once':lambda kind:{'results':{'repo':'error: push denied'}}}\n${WIP_PROGRAM}`;
  const result = spawnSync('python3.14', ['-c', program], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('T3POC_WIP_OK'), false);
  assert.match(cloneScript(['org/repo']), /su -s \/bin\/sh vscode/);
});

test('stop resumes suspended VM but never terminates on WIP or history failure', async (context) => {
  const { createRuntime, stop } = await import('./t3poc.mjs');
  const extension = await import('./ext-70-workspace.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
  if (!extension) return context.skip('stop extension is provided by PR #8');
  const { register } = extension;
  for (const failed of ['wip', 'history']) {
    const calls = [];
    const api = createRuntime({
      now: () => 0,
      log() {},
      readState: () => ({ microvmId: 'vm', endpoint: 'vm.example' }),
      writeState() {},
      getMicrovm: async () => ({ state: 'SUSPENDED' }),
      resume: async () => calls.push('resume'),
      waitUntil: async () => {},
      terminate: async () => calls.push('terminate'),
      shell: async () => (failed === 'wip' ? 'T3POC_SHELL_DONE' : 'T3POC_WIP_OK\nT3POC_SHELL_DONE'),
    });
    register(api);
    api.backupHistory = async () => ({ aborted: true, reason: 'dummy separation failure' });
    await assert.rejects(stop(api));
    assert.deepEqual(calls, ['resume']);
  }
});

test('backup separation failure does not upload and restarts the old T3', async () => {
  const { backupHistory } = await import('./t3-history.mjs');
  const { START_T3, STOP_T3 } = await import('./vm-shell.mjs');
  const calls = [];
  const result = await backupHistory({
    log() {},
    deps: {
      shell: async ({ script }) => {
        if (script === STOP_T3) {
          calls.push('stop');
          return 'T3POC_T3_STOPPED';
        }
        if (script === START_T3) {
          calls.push('start');
          return 'T3POC_T3_STARTED';
        }
        calls.push('emit');
        return 'T3POC_BACKUP_ABORT credential marker';
      },
      s3Put: async () => calls.push('upload'),
    },
  });
  assert.equal(result.aborted, true);
  assert.deepEqual(calls, ['stop', 'emit', 'start']);
});

test('S3 write failure restarts old T3 and does not report backup success', async () => {
  const { backupHistory } = await import('./t3-history.mjs');
  const { START_T3, STOP_T3 } = await import('./vm-shell.mjs');
  const { spawnSync } = await import('node:child_process');
  const tar = spawnSync('python3.14', [
    '-c',
    'import io,tarfile,sys; b=io.BytesIO(); t=tarfile.open(fileobj=b,mode="w"); t.close(); sys.stdout.buffer.write(b.getvalue())',
  ]).stdout;
  const calls = [];
  await assert.rejects(
    backupHistory({
      log() {},
      deps: {
        shell: async ({ script }) => {
          if (script === STOP_T3) {
            calls.push('stop');
            return 'T3POC_T3_STOPPED';
          }
          if (script === START_T3) {
            calls.push('start');
            return 'T3POC_T3_STARTED';
          }
          return `T3POC_HISTORY_B64\n${tar.toString('base64')}\nT3POC_HISTORY_END\n`;
        },
        accountId: async () => '123456789012',
        s3Put: async () => {
          calls.push('upload');
          throw Error('Put denied');
        },
      },
    }),
    /Put denied/,
  );
  assert.deepEqual(calls, ['stop', 'upload', 'start']);
});

test('workspace restore clones the base, stops T3 for pending linked worktrees, then restarts T3', async () => {
  const { cloneRepos } = await import('./workspace.mjs');
  const { STOP_T3, START_T3 } = await import('./vm-shell.mjs');
  for (const fail of [false, true]) {
    const calls = [];
    const task = cloneRepos({
      deps: {
        repos: 'org/repo',
        shell: async ({ script }) => {
          if (script === STOP_T3) {
            calls.push('stop');
            return 'T3POC_T3_STOPPED';
          }
          if (script === START_T3) {
            calls.push('start');
            return 'T3POC_T3_STARTED';
          }
          if (script.includes('gh repo clone')) {
            calls.push('clone');
            return 'T3POC_CLONE_OK';
          }
          if (!calls.includes('probe')) {
            calls.push('probe');
            return 'T3POC_WORKTREES_PENDING';
          }
          calls.push('restore');
          assert.match(script, / restore/);
          return fail ? 'T3POC_BACKUP_ABORT' : 'T3POC_WORKTREES_OK';
        },
      },
      log() {},
    });
    if (fail) await assert.rejects(task, /worktree restore failed/);
    else await task;
    assert.deepEqual(calls, ['clone', 'probe', 'stop', 'restore', 'start']);
  }
});

test('real git worktrees survive loss of the base checkout and RAM', () => {
  const result = spawnSync('python3.14', ['-m', 'unittest', 'vm_worktrees_test'], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('reattaching without pending worktrees leaves the running T3 process alone', async () => {
  const { cloneRepos } = await import('./workspace.mjs');
  const calls = [];
  await cloneRepos({
    deps: {
      repos: 'org/repo',
      shell: async ({ script }) => {
        if (script.includes('gh repo clone')) {
          calls.push('clone');
          return 'T3POC_CLONE_OK';
        }
        calls.push('probe');
        return 'T3POC_WORKTREES_NONE';
      },
    },
    log() {},
  });
  assert.deepEqual(calls, ['clone', 'probe']);
});
