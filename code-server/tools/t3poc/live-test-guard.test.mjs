import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveTestGuard } from './live-test-guard.mjs';

test('parallel calls and harness restarts cannot create a second replacement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-once-'));
  let calls = 0;
  const options = {
    directory,
    startMicrovm: async () => {
      calls++;
      return {};
    },
  };
  try {
    const guard = createLiveTestGuard(options);
    await guard.start();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => guard.start({ allowExisting: true })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(calls, 2);
    await assert.rejects(createLiveTestGuard(options).start({ allowExisting: true }), /EEXIST/);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('failed Run and failed swap still consume their one attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't3poc-once-'));
  let calls = 0;
  const guard = createLiveTestGuard({
    directory,
    startMicrovm: async () => {
      calls++;
      throw Error('Run failed');
    },
  });
  try {
    await assert.rejects(guard.start({ allowExisting: true }), /Run failed/);
    await assert.rejects(guard.start({ allowExisting: true }), /EEXIST/);
    assert.equal(calls, 1);
    await assert.rejects(
      guard.swapOnce(async () => {
        throw Error('swap failed');
      }),
      /swap failed/,
    );
    await assert.rejects(
      guard.swapOnce(async () => {}),
      /EEXIST/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
