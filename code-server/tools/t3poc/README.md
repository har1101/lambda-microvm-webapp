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
- GitHub: T3 terminal → `gh-token-login` (fine-grained PAT, one repo, Contents + Pull requests write, shortest expiry).

Only `~/.t3poc/state.json` (MicroVM id + endpoint, no secrets) is written on the Mac.
