// Test harness only: persistent claims prevent retries across relay restarts.
import fs from 'node:fs';
import path from 'node:path';
export function createLiveTestGuard({ directory, startMicrovm }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const claim = (name) => {
    const fd = fs.openSync(path.join(directory, `${name}.claim`), 'wx', 0o600);
    fs.closeSync(fd);
  };
  return {
    async start(input = {}) {
      claim(input.allowExisting ? 'replacement' : 'initial');
      return startMicrovm(input);
    },
    async swapOnce(fn) {
      claim('swap-attempt');
      return fn();
    },
  };
}
