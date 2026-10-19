import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LAUNCHD_LABEL = 'com.t3poc.relay';

export function renderLaunchAgent({ nodePath, scriptPath, port, home, awsProfile }) {
  const log = `${home}/.t3poc/relay.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>relay</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AWS_PROFILE</key>
    <string>${awsProfile}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

export function launchAgentPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function installLaunchAgent({
  home = os.homedir(),
  nodePath = process.execPath,
  scriptPath,
  port = '8787',
  awsProfile = process.env.AWS_PROFILE ?? 'fukuchi',
  platform = process.platform,
  execFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
} = {}) {
  const plist = renderLaunchAgent({ nodePath, scriptPath, port, home, awsProfile });
  const dest = launchAgentPath(home);
  mkdirSync(path.dirname(dest), { recursive: true });
  mkdirSync(path.join(home, '.t3poc'), { recursive: true });
  writeFileSync(dest, plist, { mode: 0o644 });
  if (platform === 'darwin' && execFileSync) {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync('launchctl', ['bootout', domain, dest], { stdio: 'ignore' });
    } catch {
      // bootout fails when the agent was not loaded yet.
    }
    execFileSync('launchctl', ['bootstrap', domain, dest]);
  }
  return { dest, plist, loaded: platform === 'darwin' };
}

export function uninstallLaunchAgent({
  home = os.homedir(),
  platform = process.platform,
  execFileSync,
  rmSync = fs.rmSync,
} = {}) {
  const dest = launchAgentPath(home);
  if (platform === 'darwin' && execFileSync) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, dest], { stdio: 'ignore' });
    } catch {
      // already unloaded
    }
  }
  rmSync(dest, { force: true });
  return dest;
}
