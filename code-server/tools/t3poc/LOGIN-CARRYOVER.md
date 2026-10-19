# Harness login carry-over

Claude/Codex login carry-over is **off by default**. `--inject-logins` or `T3POC_INJECT_LOGINS=1` enables capture, refresh, and injection together. Enable it on every lifecycle command, including `stop`. For the launchd relay (requires the #2 launchd extension), the install option persists the flag in ProgramArguments:

```sh
node login-launchd.mjs --inject-logins --port 8787
# foreground alternative
node t3poc.mjs relay --inject-logins --port 8787
# capture immediately from the recorded RUNNING VM, without restarting T3
node login-capture.mjs --inject-logins
# stop must also explicitly opt in
node t3poc.mjs stop --inject-logins
```

The relay checks guest-computed SHA256 hashes every 60 seconds while RUNNING, and captures changes before swap/stop. An explicit capture reports only `captured`, `unchanged`, or `retained`. No bundle is printed. Missing/logged-out files retain the last good Keychain bundle; transport, validation-race, or Keychain failure blocks swap/stop. Structural checks cannot prove that a remote provider has not revoked a token. Logout intentionally does not erase the saved bundle; disable carry-over if you want logout to persist.

Only macOS Keychain service `t3poc-logins` persists credentials. No S3/history/cloud copy is made. Codex stores only `auth.json` (ChatGPT OAuth with access/refresh/ID tokens and refresh/account metadata). Claude stores only `.credentials.json` (`claudeAiOauth`) plus `.claude.json` containing `oauthAccount` account UUID/email/organization UUID/display name, `hasCompletedOnboarding`, and `lastOnboardingVersion`. Projects, trust decisions, MCP configuration, settings, sessions, caches and other credential types are excluded. Unsupported login types remain uncaptured.

Guest snapshots and hashes use a deterministic minimal tar. Unchanged bundles stay in the VM; only a changed snapshot is streamed over the existing authenticated shell channel into relay memory and Keychain stdin. The hash is rechecked on capture to reject rotation between probe and capture. Transfer waits for raw-mode acknowledgement, including small bundles, to prevent PTY echo. Secrets never enter subprocess argv or diagnostic output.

Injection runs only for a newly prepared VM. The relay stops T3, restores into `/dev/shm/codex` and `/dev/shm/claude`, and restarts T3 before admitting requests. Existing-VM relay attachment captures its current state instead of overwriting rotated credentials. Writes reject links, use atomic file replacement, set owner `vscode:vscode`, files `0600`, directories `0700`; transient transfer scripts/payloads stay in private RAM directories and are removed. No image change is required.

Manual import remains available, but accepts only the same minimal, validated OAuth files (uncompressed tar) over stdin:

```sh
node t3poc.mjs logins --kind codex < minimal-codex.tar
node t3poc.mjs logins --kind claude < minimal-claude.tar
```

See [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage), [Claude authentication](https://code.claude.com/docs/en/authentication#credential-management), and [Claude configuration](https://code.claude.com/docs/en/settings). The pinned Claude 2.1.303 CLI maps `CLAUDE_CONFIG_DIR` to `<dir>/.claude.json` and uses account/onboarding state there.
