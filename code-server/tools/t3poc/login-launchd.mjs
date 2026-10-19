import fs from 'node:fs';

// The launchd implementation belongs to #2. Decorate its writer so the opt-in
// also works after the shared lifecycle/launchd branch is integrated.
export function loginPlist(plist, enabled) {
  if (!enabled) return plist;
  const anchor = '    <string>relay</string>';
  if (!plist.includes(anchor)) throw new Error('launchd relay argument not found');
  return plist.replace(anchor, `${anchor}\n    <string>--inject-logins</string>`);
}
export function loginLaunchdOptions(enabled, writeFileSync = fs.writeFileSync) {
  return {
    writeFileSync(dest, plist, options) {
      return writeFileSync(dest, loginPlist(plist, enabled), options);
    },
  };
}

// Run only during the follow-up verification. #2 supplies launchd.mjs.
async function main() {
  const { installLaunchAgent } = await import('./launchd.mjs');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { parseArgs } = await import('./t3poc.mjs');
  const { injectEnabled } = await import('./ext-40-logins.mjs');
  const { opts } = parseArgs(['install', ...process.argv.slice(2)]);
  const enabled = injectEnabled(opts, process.env);
  installLaunchAgent({
    scriptPath: fileURLToPath(new URL('./t3poc.mjs', import.meta.url)),
    port: String(opts.port ?? 8787),
    execFileSync,
    ...loginLaunchdOptions(enabled),
  });
  console.log(`installed launchd relay; login carry-over ${enabled ? 'enabled' : 'disabled'}`);
}
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch(() => {
    console.error('login launchd install failed; requires the #2 launchd extension');
    process.exitCode = 1;
  });
}
