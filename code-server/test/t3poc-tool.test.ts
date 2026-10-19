import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

test('t3poc unit tests', () => {
  const result = spawnSync('npm', ['test'], {
    cwd: path.join(__dirname, '..', 'tools', 't3poc'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
  }
  expect(result.status).toBe(0);
});
