import { mintInstallationToken, pushToVm, REFRESH_EVERY_MS } from './ghapp.mjs';

export { REFRESH_EVERY_MS };

export function register(api) {
  let timer = null;
  const push = () =>
    pushToVm({
      shell: (input) => api.deps.shell(input),
      mint: () =>
        api.deps.mintToken
          ? api.deps.mintToken()
          : mintInstallationToken({ keychain: api.deps.keychain('t3poc-ghapp') }),
      log: (message) => api.log(message),
    });
  api.hooks.onVmReady.push(async () => {
    await push();
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      push().catch((error) => api.log(`gh token refresh failed: ${error.message}`));
    }, REFRESH_EVERY_MS);
    timer.unref?.();
  });
}
