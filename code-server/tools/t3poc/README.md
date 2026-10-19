# t3poc (run on your Mac)

Connect your local **T3 Code Desktop** to `t3 serve` in a throwaway t3poc Lambda MicroVM.
No code-server, CloudFront, Cognito, T3 Connect, or SSH.

```
T3 Desktop ──http://127.0.0.1:8787──> t3poc relay (loopback only; adds the MicroVM X-aws-proxy-auth token, refreshes it)
          ──https──> MicroVM endpoint :8080 ──> t3-shim ──> t3 serve (127.0.0.1:3773, T3 pairing auth)
```

Requirements: Node 22+, `aws sso login --profile fukuchi`, the `T3pocMicrovmStack` image `t3poc-task`.

```bash
cd code-server/tools/t3poc && npm ci
aws sso login --profile fukuchi
node t3poc.mjs start                 # RunMicrovm (8h max); --max-duration-sec 3600 for the expiry test
node t3poc.mjs relay                 # keep running
node t3poc.mjs pair                  # prints http://127.0.0.1:8787/pair#token=... (one-time, 5 min)
# T3 Desktop: Settings → Connections → Add environment → paste the link
node t3poc.mjs status
node t3poc.mjs stop                  # terminate; RAM-only logins are discarded
```

If `pair` cannot read the link from the MicroVM shell, it prints the command to run from
Lambda console → MicroVM → **Connect**.

Logins (inside the VM, from T3; all stored only in /dev/shm):
- Codex: T3 Settings → Providers → Codex → sign in (if the final localhost page fails, paste its full URL into the sign-in panel).
- Claude: T3 terminal (mod+G) → `claude auth login`.
- GitHub: use the GitHub App flow below (no long-lived PAT).

Only `~/.t3poc/state.json` (MicroVM id + endpoint, no secrets) is written on the Mac.

`relay` listens on 127.0.0.1:8787 immediately. If no MicroVM is running, the first request starts one and holds the connection (up to 120s). Startup and resume latency are printed as `startup latency <ms>` / `resume latency <ms>`.

```bash
node t3poc.mjs install      # ~/Library/LaunchAgents/com.t3poc.relay.plist (launchctl on macOS)
node t3poc.mjs uninstall
```

After 5 minutes with no relay traffic the MicroVM is paused (Suspend, not terminate). The next request resumes it. Paused time still counts toward the 8h lifetime. At 7.5h the relay WIP-pushes, backs up T3 history, starts a new MicroVM, restores, and switches the relay to it.

GitHub: on VM ready the relay pushes a 1h installation token into `/dev/shm/gh-token` and refreshes it every 50 minutes (`ext-50-gh.mjs`). `ghapp.mjs refresh` is disabled; use the relay for suspend-aware refresh and one-minute retries.

Pairing material (userdata/secrets and auth_* tables) is snapshotted into the macOS keychain (`t3poc-pairing`) and restored into a new VM so the existing T3 Desktop environment keeps working. It is not written to disk or S3.

History (threads) is stored in `s3://t3poc-auth-<account>-ap-northeast-1/t3-history/latest.tar` with SSE-KMS `alias/t3poc-auth-state`. The exclusion list drops secrets, `/dev/shm/claude`, `/dev/shm/codex`, `/dev/shm/gh-token`, and auth tables. If a history file still contains credential material, the backup stops and nothing is uploaded.

Repos in `T3POC_REPOS` (default `ai-native-factory/t3poc-sandbox`) are cloned into the VM workspace on start. `stop` WIP-pushes, then backs up history, and refuses to terminate if that backup cannot separate secrets.

Claude/Codex login injection is off unless you pass `--inject-logins` or set `T3POC_INJECT_LOGINS=1`. Import a tar on stdin into the keychain, then the relay writes it only under `/dev/shm/claude` or `/dev/shm/codex`:

```bash
node t3poc.mjs logins --kind claude < claude.tar
node t3poc.mjs relay --inject-logins
```

## GitHub (short-lived App tokens)

`ghapp.mjs` mints 1-hour installation tokens for the GitHub App on `ai-native-factory-ltd.ghe.com`,
scoped to `ai-native-factory/t3poc-sandbox` only (Contents + Pull requests write).
The App private key lives only in the macOS keychain (service `t3poc-ghapp`); it never reaches disk or the VM.

```bash
AWS_PROFILE=fukuchi node ghapp.mjs setup    # once: create the App via manifest, store key in keychain, then Install on t3poc-sandbox
AWS_PROFILE=fukuchi node ghapp.mjs push     # mint a 1h token and write it to VM /dev/shm/gh-token via SHELL_INGRESS (stdin, not argv)
# Keep t3poc relay running for token refresh; standalone refresh is disabled.
AWS_PROFILE=fukuchi node ghapp.mjs status   # mint test only (token discarded)
```

In the VM, `~/.bashrc` exports `GH_HOST` and `GH_TOKEN` (from `/dev/shm/gh-token`); gh needs `GH_TOKEN`
(not `GH_ENTERPRISE_TOKEN`) for `*.ghe.com`.

## Deploying the t3poc stack (operator)

t3poc never uses the account's shared cdkd buckets. Its cdkd state/assets live in
`t3poc-cdkd-state-<account>` and `t3poc-cdkd-assets-<account>-ap-northeast-1`
(`npm run t3poc:bootstrap`, once). Always deploy through the scripts, which select them;
`T3_POC_ONLY=1` refuses to synthesize with any other `CDKD_STATE_BUCKET`:

```bash
cd code-server
npm run t3poc:diff      # must show changes to T3pocMicrovmStack only
npm run t3poc:deploy
npm run t3poc:destroy   # teardown
```


Operational decisions: idle means five minutes since the last relayed byte, including silent open WebSockets and HTTP requests. Such connections may be suspended while awaiting output. WIP push or history backup failure blocks stop/swap to avoid losing state; resolve the failure and retry. WIP runs first. Pairing snapshot failure is a warning and retains the last successful Keychain bundle; re-pair if needed. During stop, token refresh failure is a warning, while an actual WIP push failure still prevents termination. Failed replacement cleanup retains its journal and cannot prevent primary termination; retry stop to reclaim the remaining VM. Failed pause/swap and readiness hooks retry no sooner than one minute. An unfinished replacement ID is journaled alongside the old primary, and reclaimed before subsequent lifecycle work. Disk restoration is checkpointed separately from token/clone/login hooks.

Guest Python is pinned to 3.14.4 in the PoC overlay only. Shared base git identity and GH shell settings are intentionally retained byte-for-byte to preserve existing stack assets. START_T3 confirms shell launch, not service health. Ownership and actual port readiness still need real-VM checks. An empty workspace has no repositories to snapshot and is a successful WIP no-op. RAM writes use atomic rename; persistence requires successful history upload.


Pause retains RAM: history upload/separation failure is logged and does not prevent Suspend; stop/swap require successful WIP/history preservation. If stop is requested while the VM is still booting and its shell cannot save WIP yet, stop fails closed; retry once RUNNING. For emergency manual termination, open the AWS Lambda console → MicroVMs, verify the recorded VM ID, and choose Terminate. This bypasses preservation and discards RAM-only state; use only after assessing that loss. No console operation was performed during this change.
