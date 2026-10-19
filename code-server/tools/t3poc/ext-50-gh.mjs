import { mintInstallationToken, pushToVm, REFRESH_EVERY_MS } from './ghapp.mjs';

export { REFRESH_EVERY_MS };
export const RETRY_MS = 60_000;

export function register(api) {
  let nextRefreshAt = 0;
  const push = async () => {
    try {
      const result = await pushToVm({
        shell: (input) => api.deps.shell(input),
        mint: () =>
          api.deps.mintToken
            ? api.deps.mintToken()
            : mintInstallationToken({ keychain: api.deps.keychain('t3poc-ghapp') }),
        log: (message) => api.log(message),
      });
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires) || expires <= api.now()) throw new Error('invalid token expiry');
      nextRefreshAt = Math.min(api.now() + REFRESH_EVERY_MS, expires - 10 * 60_000);
    } catch (error) {
      nextRefreshAt = api.now() + RETRY_MS;
      throw error;
    }
  };
  api.hooks.onVmReady.push(push);
  api.hooks.onResume.push(push);
  api.hooks.onTick.push(() =>
    api.exclusive(async () => {
      // Never wake an idle VM just to refresh an unused token. Resume refreshes it.
      if (api.session.vmState !== 'RUNNING' || api.now() < nextRefreshAt) return;
      try {
        await push();
      } catch {
        api.log('gh token refresh failed; retry within one minute');
      }
    }),
  );
}
