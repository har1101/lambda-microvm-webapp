# OMP Cloud IDE on Lambda MicroVM

Personal browser IDE for `har1101`. CloudFront authenticates the browser before Lambda@Edge can start a Tokyo-region Lambda MicroVM. The MicroVM runs code-server and OMP as an unprivileged `vscode` user.

## Architecture

```text
Browser
  -> CloudFront + Lambda@Edge password form (us-east-1)
     -> signed, HttpOnly access cookie
     -> suspend/resume/confirmed terminate control page
  -> Lambda MicroVM endpoint token injection
  -> code-server :8080 (ap-northeast-1)
  -> OMP / gh / development toolchain

Lifecycle hooks
  <-> KMS-encrypted, versioned S3 objects
      personal/omp/agent.db
      personal/omp/install-id
      personal/github/hosts.yml
```

The SQLite database is copied with Python's SQLite backup API, never as a live-file byte copy. State is restored on `/run`, saved every five minutes (unchanged files are skipped), saved on `/suspend` and `/terminate`, and can be saved immediately with `persist-auth-state`, which prints a per-file result and exits non-zero if any file failed. Hooks run under deadlines shorter than their image timeouts and always answer 200 so they never block Run/Suspend/Terminate; the outcome is recorded in `~/.cache/omp-cloud-ide/auth-sync.json` and shown in the status bar (`認証 N分前`, `認証保存失敗`, `認証復元失敗`, or `認証競合`). Clicking it runs `persist-auth-state`. If a restore failed for a file, automatic saves skip that file so an unauthenticated local copy cannot overwrite good state in S3; log in again and save manually to lift the block.

Several MicroVMs share the same S3 keys, so every save is conditional on the ETag this VM last restored or wrote. If another MicroVM saved newer state first, the write is refused and the status bar shows `認証競合` instead of silently replacing the newer credentials. Run `persist-auth-state --overwrite` only when this VM's credentials should win.

Check the auth status bar after each new MicroVM starts and before terminating it. A previous run failed to restore `omp/install-id` and `github/hosts.yml`: three sequential S3 downloads shared a 25-second `/run` budget, so a slow first download could exhaust the time left for the others. The downloads now run concurrently; a delayed-first-download regression test passes, and two deployed fresh VMs restored all three files. The original VM's exact error codes were not captured, so other S3/KMS failures remain possible. On a failed VM, automatic saves of affected keys stay blocked; reauthenticate and run `persist-auth-state` only when you intend that VM's credentials to become the saved state.

## Deployment boundary

`cdkd` is currently intended for development and test use by its maintainers. This personal IDE is treated as a dev environment. It is split into two CDK stacks because Lambda@Edge must live in `us-east-1` while the MicroVM and its auth-state bucket live in `ap-northeast-1`.

| Stack | Region | Purpose |
| --- | --- | --- |
| `OmpCloudIdeMicrovmStack` | `ap-northeast-1` | MicroVM image, KMS key, retained S3 state, runtime IAM role |
| `OmpCloudIdeEdgeStack` | `us-east-1` | CloudFront, Lambda@Edge, access password, session table |

## Deploy with cdkd

Prerequisites: Node.js 22.12+, npm, AWS CLI, and direct permissions to create every resource. `cdkd` calls AWS APIs directly and does not deploy through a CloudFormation execution role.

```bash
aws sso login --profile fukuchi
cd code-server
npm ci

AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npm run build
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npm test
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npm run synth
AWS_PROFILE=fukuchi npm run bootstrap
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npm run deploy:dry-run
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npm run deploy
```

The normal deploy uses `--full-wait` so the MicroVM image build and CloudFront distribution are ready before it returns.

## First access

1. Read `DistributionUrl`, `BasicAuthUsername`, and `AccessPasswordSecretArn` from the edge stack outputs.
2. Open the distribution URL.
3. Enter the output username and reveal the access password manually in the AWS Secrets Manager console. The form issues a signed, `HttpOnly`, `SameSite=Strict` access cookie for the MicroVM session lifetime. Do not print the password into build logs or commit it.
4. In the code-server terminal, start OMP and log in:

   ```text
   omp
   /login anthropic
   /login openai-codex
   /login opencode-go
   ```

5. Authenticate normal GitHub with the GitHub CLI OAuth web/device flow (no PAT):

   ```bash
   gh auth login --hostname github.com --git-protocol https --web
   gh auth setup-git
   ```

6. Save the new OAuth state immediately:

   ```bash
   persist-auth-state
   ```

Later MicroVMs restore OMP's `agent.db`, its installation ID, and GitHub CLI's OAuth credential file before code-server traffic is served.

The image also installs a global OMP configuration with interactive goal continuation and the ask tool enabled. Tool approvals default to `yolo`, while `rm -rf *` and `git push --force*` are denied by `bash.patterns`. These patterns govern OMP's `bash` tool; they are approval rules rather than operating-system sandboxing.

OMP's Puppeteer browser prelude is enabled in headless mode. A checksum-pinned arm64 Chromium build is expanded into `/opt/chromium` during the image build and selected with `PUPPETEER_EXECUTABLE_PATH`, so the first E2E run does not depend on a browser download. `tab.screenshot()` evidence is saved under `/home/vscode/workspace/.artifacts/screenshots` by default.

Opening `/login` only renders the access form; it does not call `RunMicrovm`. After successful login, `/session/select` lists running and suspended MicroVMs. The user explicitly chooses an existing session to connect or resume, or starts a new MicroVM. Temporary origin `502`/`504` responses preserve the browser's `mvm-session` association and return to the chooser instead of orphaning a live workspace.

New starts use a form UUID and a conditional DynamoDB claim to avoid duplicate MicroVMs. If registration fails after `RunMicrovm`, Edge requests compensation termination. The chooser lists MicroVMs without a session row; because a newly starting VM can briefly appear there, verify its ID and use the AWS API/Console for manual cleanup rather than an in-page untracked termination button.

## Suspend and resume

The editor status bar contains **Suspend Cloud IDE**. It opens `/session/control` through code-server's HTTPS URL opener; press **Suspend Cloud IDE** there to suspend the current browser's MicroVM. This two-step control is deliberate: the suspend API must be called outside the MicroVM, and the control plane marks the session paused before requesting the snapshot so code-server WebSocket reconnects cannot immediately wake it again.

Next to it, the status bar shows the remaining MicroVM lifetime (`残り H:MM`). The Edge passes a deadline in the `/run` hook payload, because a MicroVM cannot look up its own `startedAt`; the lifetime counts both RUNNING and SUSPENDED time. The item turns yellow at 30 minutes and red at 10 minutes, and a notification at 60, 15, and 5 minutes asks you to commit and push. MicroVMs started before this feature was deployed show `残り時間不明`.

While paused, regular editor requests are blocked at Lambda@Edge. Press **Resume editor** on the control page to resume explicitly. A suspended MicroVM incurs snapshot storage and snapshot operation charges, but no compute charge. The current idle policy also automatically suspends a session after five minutes without endpoint traffic and terminates it after eight suspended hours; an open code-server tab can generate traffic, so use the explicit button when you are finished for now.

## Terminate a session

Commit and push all workspace changes first; termination destroys the VM's local disk and RAM. From `/session/select` or `/session/control`, choose **Terminate permanently...**, inspect the MicroVM ID and state, then type its full ID into the confirmation form. Edge blocks editor traffic before requesting termination. If the API result is uncertain, the session stays blocked and can be retried from the chooser. The current `mvm-session` cookie is cleared when termination is accepted, and the matching DynamoDB row is removed only after `TERMINATED` or NotFound is observed. The `/terminate` hook tries to save auth state but is fail-open; check its status bar before ending the VM.

## Implementation status

The deployable personal-IDE path is implemented: Tokyo MicroVM image, CloudFront/Lambda@Edge access control, code-server, pinned OMP, Bun/Node/Python/uv, GitHub CLI OAuth without PAT, AWS CLI, language servers, `ripgrep`, headless Chromium for OMP browser E2E, encrypted lifecycle persistence, explicit suspend/resume, and `cdkd` deployment.

The original design document is not implemented literally in these intentionally superseded areas:

- The Auth Broker and its always-on EC2 host were replaced by lifecycle-hook snapshots of the single-user OMP `agent.db` in KMS-encrypted S3.
- GitHub Enterprise support was replaced by normal `github.com` OAuth using `gh auth login --web`.
- The workspace remains MicroVM-local and ephemeral. Clone a repository after startup; authentication state persists, repository contents do not.

OMP sign-in for Anthropic and OpenAI Codex and the code-server browser flow have been exercised. OpenCode Go login/model calls and a full private-repository clone/edit/test/push/PR workflow are still manual verification items. Base-image dependency updates are pinned and deployed manually; no recurring image-update automation is configured.

## Operations

Inspect cdkd state and deployment events:

```bash
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npx cdkd state show OmpCloudIdeMicrovmStack --stack-region ap-northeast-1
AWS_PROFILE=fukuchi AWS_REGION=us-east-1 npx cdkd state show OmpCloudIdeEdgeStack --stack-region us-east-1
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npx cdkd events OmpCloudIdeMicrovmStack --stack-region ap-northeast-1
AWS_PROFILE=fukuchi AWS_REGION=us-east-1 npx cdkd events OmpCloudIdeEdgeStack --stack-region us-east-1
```

The S3 bucket and KMS key use `Retain`; destroying the stacks does not delete persisted OAuth state. Review retained data separately before any manual deletion.

## Security notes

- The browser must pass the Lambda@Edge password form before `RunMicrovm` is called. Legacy HTTP Basic credentials remain accepted for non-browser smoke checks, but unauthenticated browsers are redirected to `/login` instead of relying on a native Basic-auth dialog.
- code-server has no independent password because it is reachable only through the AWS MicroVM proxy token injected by the authenticated edge function.
- Edge removes its own access and session cookies before forwarding to code-server while preserving code-server cookies. This does not isolate same-origin `/proxy/<port>/` apps from session control routes or credentials readable inside the VM.
- The MicroVM execution role can access only its auth-state prefix and its log group.
- OMP, GitHub, and access credentials are not included in the Docker image or Git repository.
- The MicroVM container runs as UID 1000, not root.
- `gh auth login --web` uses GitHub OAuth. PAT-based setup is intentionally not documented or required.
