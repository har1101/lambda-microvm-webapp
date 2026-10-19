#!/usr/bin/env bash
set -euo pipefail

python3 /opt/cloud-ide/lifecycle.py &

CODE_SERVER_ARGS=(
  --auth none
  --disable-telemetry
  --user-data-dir /home/vscode/.vscode
  --extensions-dir /home/vscode/.local/share/code-server/extensions
  /home/vscode/workspace
)

if [ "${CLOUD_IDE_KIND:-ide}" != "t3" ]; then
  exec code-server --bind-addr 0.0.0.0:8080 "${CODE_SERVER_ARGS[@]}"
fi

# --- T3 task VM (PoC) ---------------------------------------------------
# All agent/T3 login state lives in RAM (/dev/shm) and dies with the VM.
# Nothing here is in lifecycle.py STATE_FILES, and the Edge starts T3 VMs with
# authState=false and the guest role (no S3/KMS), so it is never synced.
umask 077
export T3CODE_HOME=/dev/shm/t3 CLAUDE_CONFIG_DIR=/dev/shm/claude CODEX_HOME=/dev/shm/codex
mkdir -p "$T3CODE_HOME" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"
# git uses the RAM-only token through this helper (no `gh auth login`, so
# ~/.config/gh/hosts.yml is never written).
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=/usr/local/bin/git-credential-shm
export GIT_CONFIG_KEY_1=credential.https://ai-native-factory-ltd.ghe.com.helper GIT_CONFIG_VALUE_1=/usr/local/bin/git-credential-shm

t3 serve --host 127.0.0.1 --port 3773 --no-browser /home/vscode/workspace &
python3 /opt/cloud-ide/autopush.py &
# No code-server in T3 task VMs: the Mac connects with T3 Desktop through
# `t3poc relay`; logins happen in T3's own terminal / Settings → Providers.
exec node /opt/cloud-ide/t3-shim.cjs
