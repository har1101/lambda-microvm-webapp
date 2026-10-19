import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GIT_DEFAULTS } from './ghapp.mjs';

test('a restored no-upstream branch can use plain git push with a scoped RAM helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-plain-push-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (cwd, ...args) => {
    const out = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  try {
    git(root, 'init', '--bare', 'remote.git');
    git(root, 'clone', path.join(root, 'remote.git'), 'repo');
    const repo = path.join(root, 'repo');
    git(repo, 'checkout', '-b', 'smoke/plain-push');
    fs.writeFileSync(path.join(repo, 'fixture.txt'), 'fixture\n');
    git(repo, 'add', 'fixture.txt');
    git(repo, 'commit', '-m', 'fixture');
    const missing = spawnSync('git', ['push'], { cwd: repo, env, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    const configured = spawnSync('/bin/sh', ['-c', GIT_DEFAULTS], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    git(repo, 'push');
    assert.equal(git(repo, 'rev-parse', '--symbolic-full-name', '@{upstream}'), 'refs/remotes/origin/smoke/plain-push');
    assert.equal(
      git(root, '--git-dir=remote.git', 'rev-parse', 'refs/heads/smoke/plain-push'),
      git(repo, 'rev-parse', 'HEAD'),
    );
    assert.equal(
      git(repo, 'config', '--global', '--get', 'credential.https://ai-native-factory-ltd.ghe.com.helper'),
      '/usr/local/bin/git-credential-shm',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
