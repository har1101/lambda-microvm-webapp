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
