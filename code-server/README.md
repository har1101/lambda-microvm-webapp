# OMP Cloud IDE on Lambda MicroVM

Personal browser IDE for `har1101`. CloudFront authenticates the browser before Lambda@Edge can start a Tokyo-region Lambda MicroVM. The MicroVM runs code-server and OMP as an unprivileged `vscode` user.

## Architecture

```text
Browser
  -> CloudFront + Lambda@Edge (us-east-1)
     -> Cognito Managed Login (password + TOTP MFA, authorization code + PKCE)
     -> opaque, HttpOnly access cookie (hash stored in DynamoDB)
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

Check the auth status bar after each new MicroVM starts and before terminating it. Restores used to fail on freshly booted VMs: the MicroVM root disk reads never-touched blocks lazily at about 4 MB/s, and every `aws s3api` call has to read more than 110 MB of AWS CLI files, so on a cold VM the CLI alone overran the 25-second `/run` budget and all three downloads timed out. `lifecycle.py` now calls S3 directly from its already-running Python process (IMDSv2 execution-role credentials, SigV4, stdlib HTTP), which reads no new files; a warm restore of all three files takes about 0.3 s. Other S3/KMS failures remain possible. On a failed VM, automatic saves of affected keys stay blocked; reauthenticate and run `persist-auth-state` only when you intend that VM's credentials to become the saved state.

## Deployment boundary

`cdkd` is currently intended for development and test use by its maintainers. This personal IDE is treated as a dev environment. It is split into two CDK stacks because Lambda@Edge must live in `us-east-1` while the MicroVM and its auth-state bucket live in `ap-northeast-1`.

| Stack | Region | Purpose |
| --- | --- | --- |
| `OmpCloudIdeMicrovmStack` | `ap-northeast-1` | MicroVM image, KMS key, retained S3 state, runtime IAM role |
| `OmpCloudIdeEdgeStack` | `us-east-1` | CloudFront, Lambda@Edge, Cognito User Pool / Managed Login, auth-session table, MicroVM session table |

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

`npm run deploy` first runs `predeploy` (`npm run update-versions`), which rewrites `ARG CODE_SERVER_VERSION` and `ARG OMP_VERSION` in `artifact/base-image/Dockerfile` to the latest code-server GitHub release (with an arm64 RPM) and the npm `latest` of `@oh-my-pi/pi-coding-agent`. A changed Dockerfile changes the image asset hash, so the MicroVM image is rebuilt; if both are already current, nothing is rewritten and the image is not rebuilt. New versions apply to MicroVMs started after the deploy. `deploy:dry-run` does not run the updater. The script fails the deploy if either lookup fails.

## First access

1. Read `DistributionUrl` and `UserPoolId` from the edge stack outputs (`ManagedLoginDomain` and `SessionsTableName` are also exported).
2. Create the single user (self sign-up is disabled):

   ```bash
   aws cognito-idp admin-create-user --region us-east-1 \
     --user-pool-id <UserPoolId> --username <email> \
     --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
     --desired-delivery-mediums EMAIL
   ```

   Cognito emails a temporary password. Do not paste it into build logs or commit it.
3. Open the distribution URL. Edge redirects to Cognito Managed Login; the first sign-in forces a new password and TOTP authenticator registration. After the callback, Edge issues an opaque `HttpOnly`, `SameSite=Strict` access cookie valid for 8 hours.
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

Opening `/auth/login` only redirects to Cognito Managed Login; it does not call `RunMicrovm`. After a successful sign-in, `/session/select` lists running and suspended MicroVMs. The user explicitly chooses an existing session to connect or resume, or starts a new MicroVM. The chooser and control pages have a **Sign out** button (`POST /auth/logout`) that deletes the Edge session and ends the Cognito session. Temporary origin `502`/`504` responses preserve the browser's `mvm-session` association and return to the chooser instead of orphaning a live workspace.

New starts use a form UUID and a conditional DynamoDB claim to avoid duplicate MicroVMs. If registration fails after `RunMicrovm`, Edge requests compensation termination. The chooser lists MicroVMs without a session row; because a newly starting VM can briefly appear there, verify its ID and use the AWS API/Console for manual cleanup rather than an in-page untracked termination button.

## Suspend and resume

The editor status bar contains **Suspend Cloud IDE**. It opens `/session/control` through code-server's HTTPS URL opener; press **Suspend Cloud IDE** there to suspend the current browser's MicroVM. This two-step control is deliberate: the suspend API must be called outside the MicroVM, and the control plane marks the session paused before requesting the snapshot so code-server WebSocket reconnects cannot immediately wake it again. The control URL is not baked into the image: the Edge builds it from the CloudFront distribution domain and passes it in the `/run` hook payload, and the hook records it in `~/.cache/omp-cloud-ide/session.json`. MicroVMs started before this was deployed have no control URL, so the button shows an error there.

Next to it, the status bar shows the remaining MicroVM lifetime (`残り H:MM`). The Edge passes a deadline in the `/run` hook payload, because a MicroVM cannot look up its own `startedAt`; the lifetime counts both RUNNING and SUSPENDED time. The item turns yellow at 30 minutes and red at 10 minutes, and a notification at 60, 15, and 5 minutes asks you to commit and push. MicroVMs started before this feature was deployed show `残り時間不明`.

While paused, regular editor requests are blocked at Lambda@Edge. Press **Resume editor** on the control page to resume explicitly. A suspended MicroVM incurs snapshot storage and snapshot operation charges, but no compute charge. The current idle policy also automatically suspends a session after five minutes without endpoint traffic and terminates it after eight suspended hours; an open code-server tab can generate traffic, so use the explicit button when you are finished for now.

## Terminate a session

Commit and push all workspace changes first; termination destroys the VM's local disk and RAM. From `/session/select` or `/session/control`, choose **Terminate permanently...**, inspect the MicroVM ID and state, then type its full ID into the confirmation form. Edge blocks editor traffic before requesting termination. If the API result is uncertain, the session stays blocked and can be retried from the chooser. The current `mvm-session` cookie is cleared when termination is accepted, and the matching DynamoDB row is removed only after `TERMINATED` or NotFound is observed. The `/terminate` hook tries to save auth state but is fail-open; check its status bar before ending the VM.

## Implementation status

The deployable personal-IDE path is implemented: Tokyo MicroVM image, CloudFront/Lambda@Edge access control, code-server, OMP, Bun/Node/Python/uv, GitHub CLI OAuth without PAT, AWS CLI, language servers, `ripgrep`, headless Chromium for OMP browser E2E, encrypted lifecycle persistence, explicit suspend/resume, and `cdkd` deployment.

The original design document is not implemented literally in these intentionally superseded areas:

- The Auth Broker and its always-on EC2 host were replaced by lifecycle-hook snapshots of the single-user OMP `agent.db` in KMS-encrypted S3.
- GitHub Enterprise support was replaced by normal `github.com` OAuth using `gh auth login --web`.
- The workspace remains MicroVM-local and ephemeral. Clone a repository after startup; authentication state persists, repository contents do not.

OMP sign-in for Anthropic and OpenAI Codex and the code-server browser flow have been exercised. OpenCode Go login/model calls and a full private-repository clone/edit/test/push/PR workflow are still manual verification items. code-server and OMP are bumped to their latest releases on every `npm run deploy` (the code-server RPM SHA-256 is updated from the release asset digest); other base-image dependencies are pinned and updated manually. Every directly downloaded artifact (code-server, Node.js, Bun, GitHub CLI, AWS CLI, uv, ripgrep, Chromium) is verified against a pinned SHA-256; dnf packages, VS Code extensions, npm transitive dependencies, and the base image digest are not pinned. No scheduled deploy is configured.

## Operations

Inspect cdkd state and deployment events:

```bash
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npx cdkd state show OmpCloudIdeMicrovmStack --stack-region ap-northeast-1
AWS_PROFILE=fukuchi AWS_REGION=us-east-1 npx cdkd state show OmpCloudIdeEdgeStack --stack-region us-east-1
AWS_PROFILE=fukuchi AWS_REGION=ap-northeast-1 npx cdkd events OmpCloudIdeMicrovmStack --stack-region ap-northeast-1
AWS_PROFILE=fukuchi AWS_REGION=us-east-1 npx cdkd events OmpCloudIdeEdgeStack --stack-region us-east-1
```

The S3 bucket and KMS key use `Retain`; destroying the stacks does not delete persisted OAuth state. Review retained data separately before any manual deletion. The Cognito User Pool is also retained with deletion protection; the auth-session table is destroyed, which signs out every browser.

Every user in the Cognito User Pool is fully authorized: pool membership is the access boundary, so any user an administrator creates (including a temporary test user) can reach every MicroVM and the shared OAuth state. Delete such users as soon as they are no longer needed.

Disabling a user or changing its password in Cognito does not end Cloud IDE sessions that were already issued (they last up to 8 hours). To revoke access immediately, end the Cognito sessions and delete every Edge session row:

```bash
aws cognito-idp admin-user-global-sign-out --region us-east-1 --user-pool-id <UserPoolId> --username <email>
aws dynamodb scan --region us-east-1 --table-name omp-cloud-ide-auth-sessions \
  --filter-expression 'begins_with(id, :p)' --expression-attribute-values '{":p":{"S":"sess#"}}' \
  --projection-expression id --query 'Items[].id.S' --output text | tr '\t' '\n' |
  while read -r id; do
    aws dynamodb delete-item --region us-east-1 --table-name omp-cloud-ide-auth-sessions --key "{\"id\":{\"S\":\"$id\"}}"
  done
```

## Security notes

- The browser must sign in through Cognito Managed Login (password + TOTP MFA; Cognito's built-in lockout limits guessing) before `RunMicrovm` is called. Edge uses the authorization code flow with PKCE, state and nonce, verifies the ID token, and then discards the tokens. The browser only holds a random session cookie; DynamoDB stores its SHA-256 hash with an 8-hour expiry. Unauthenticated HTML navigation is redirected to `/auth/login`; other requests receive `401`. HTTP Basic and the former password form have been removed.
- The design is single-user. Sessions are not scoped to a Cognito `sub`, and all MicroVMs restore the shared `personal/` OAuth state; per-user session ownership and per-user S3 prefixes/roles are required before adding a second user.
- code-server has no independent password because it is reachable only through the AWS MicroVM proxy token injected by the authenticated edge function.
- Edge removes its own access and session cookies before forwarding to code-server while preserving code-server cookies. This does not isolate same-origin `/proxy/<port>/` apps from session control routes or credentials readable inside the VM.
- The MicroVM execution role can access only its auth-state prefix and its log group.
- OMP, GitHub, and access credentials are not included in the Docker image or Git repository.
- The MicroVM container runs as UID 1000, not root.
- `gh auth login --web` uses GitHub OAuth. PAT-based setup is intentionally not documented or required.
