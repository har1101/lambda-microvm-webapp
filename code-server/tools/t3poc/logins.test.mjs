import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { injectEnabled, injectScript, LOGIN_DIRS } from './ext-40-logins.mjs';

test('login injection is off unless the flag is set, and only targets /dev/shm', () => {
  assert.equal(injectEnabled({}, {}), false);
  assert.equal(injectEnabled({ 'inject-logins': true }, {}), true);
  assert.equal(injectEnabled({}, { T3POC_INJECT_LOGINS: '1' }), true);
  const script = injectScript('claude', Buffer.from('not-a-real-tar'));
  assert.match(script, new RegExp(LOGIN_DIRS.claude));
  assert.doesNotMatch(script, /\/home\/vscode\/\.claude/);
  assert.equal(LOGIN_DIRS.codex, '/dev/shm/codex');
});

test('login tar extraction stays under /dev/shm and rejects escapes', () => {
  const result = spawnSync('python3', ['vm_logins_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
