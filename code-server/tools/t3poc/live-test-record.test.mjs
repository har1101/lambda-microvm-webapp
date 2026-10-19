import assert from 'node:assert/strict';
import test from 'node:test';
import { recordStartedVm } from './live-test-record.mjs';

test('recording errors never hide a created VM from lifecycle journal', async () => {
  const run = { microvmId: 'synthetic' };
  for (const record of [
    () => JSON.parse('{'),
    () => {
      throw Error('disk write failed');
    },
  ]) {
    let warnings = 0;
    assert.equal(
      await recordStartedVm(
        async () => run,
        record,
        () => warnings++,
      )({}),
      run,
    );
    assert.equal(warnings, 1);
  }
});
test('Run failure propagates without recording a nonexistent VM', async () => {
  let records = 0;
  await assert.rejects(
    recordStartedVm(
      async () => {
        throw Error('Run failed');
      },
      () => records++,
    )({}),
    /Run failed/,
  );
  assert.equal(records, 0);
});
