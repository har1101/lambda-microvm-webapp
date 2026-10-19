import { STOP_T3 } from './vm-shell.mjs';

export function register(api) {
  api.hooks.prepareDisk.push(async (runtime) => {
    if (runtime.flags.historyRestored) return;
    await runtime.deps.shell({ script: STOP_T3 });
    runtime.flags.t3Stopped = true;
    const restored = await runtime.restoreHistory();
    if (restored?.aborted) throw new Error(restored.reason);
    runtime.flags.historyRestored = true;
  });
}
