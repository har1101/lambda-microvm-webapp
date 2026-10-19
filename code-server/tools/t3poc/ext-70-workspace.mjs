import { cloneRepos } from './workspace.mjs';

export function register(api) {
  api.hooks.onVmReady.push((runtime) => cloneRepos(runtime));
  api.hooks.beforeStop.push(async (runtime) => {
    const backup = await runtime.backupHistory();
    if (backup?.aborted) throw new Error(`stop aborted: ${backup.reason}`);
    if (backup?.skipped) throw new Error('stop aborted: history backup module is not installed');
    if (!backup?.ok && !backup?.empty) throw new Error('stop aborted: history was not backed up');
  });
}
