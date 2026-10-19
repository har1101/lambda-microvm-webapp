import { pythonInvocation, START_T3, STOP_T3, VM_PYTHON } from './vm-shell.mjs';

import { withWorktrees } from './worktree-code.mjs';

export const DEFAULT_REPOS = ['ai-native-factory/t3poc-sandbox'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function parseRepos(value) {
  const repos = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const list = repos.length ? repos : DEFAULT_REPOS;
  const names = new Set();
  for (const repo of list) {
    if (!REPO_RE.test(repo) || repo.split('/').some((part) => ['.', '..'].includes(part)))
      throw new Error('invalid repo name');
    const name = repo.split('/')[1];
    if (names.has(name)) throw new Error('duplicate repo directory');
    names.add(name);
  }
  return list;
}

export function cloneScript(repos) {
  const lines = [
    'set -eu',
    'test -s /dev/shm/gh-token',
    'export GH_HOST=ai-native-factory-ltd.ghe.com',
    'GH_TOKEN="$(cat /dev/shm/gh-token)"',
    'export GH_TOKEN',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=/usr/local/bin/git-credential-shm',
    'mkdir -p /home/vscode/workspace',
  ];
  for (const repo of parseRepos(repos.join(','))) {
    const target = `/home/vscode/workspace/${repo.split('/')[1]}`;
    lines.push(
      `if [ -d "${target}/.git" ]; then git -C "${target}" fetch --depth 1 origin; else gh repo clone ${repo} "${target}" -- --depth 1; fi`,
    );
  }
  lines.push('unset GH_TOKEN', 'echo T3POC_CLONE_OK');
  return `su -s /bin/sh vscode -c ${quote(lines.join('\n'))}\necho T3POC_SHELL_DONE\n`;
}

export const WIP_PROGRAM = `import os, runpy, sys
os.environ["AUTOPUSH_WORKSPACE"] = "/home/vscode/workspace"
os.environ["AUTOPUSH_STATUS_FILE"] = "/dev/shm/t3poc-wip-status.json"
os.environ["GIT_CONFIG_COUNT"] = "1"
os.environ["GIT_CONFIG_KEY_0"] = "credential.helper"
os.environ["GIT_CONFIG_VALUE_0"] = "/usr/local/bin/git-credential-shm"
result = runpy.run_path("/opt/cloud-ide/autopush.py")["run_once"]("wip")
values = result.get("results", {}).values()
if result.get("error") or any(value != "clean" and not value.startswith("wip/") for value in values):
    sys.exit(1)
print("T3POC_WIP_OK")
`;

export function wipScript() {
  return `su -s /bin/sh vscode -c ${quote(`${VM_PYTHON} -c ${quote(WIP_PROGRAM)}`)}\necho T3POC_SHELL_DONE\n`;
}

export async function pushWip(api) {
  const out = await api.deps.shell({ script: wipScript() });
  if (!/^T3POC_WIP_OK\r?$/m.test(out)) throw new Error('WIP push failed; refusing to terminate or swap');
  api.log('WIP push finished');
  return { ok: true };
}

export async function cloneRepos(api) {
  const repos = parseRepos(api.deps.repos ?? process.env.T3POC_REPOS);
  const out = await api.deps.shell({ script: cloneScript(repos) });
  if (!/^T3POC_CLONE_OK\r?$/m.test(out)) throw new Error('workspace clone failed');
  const probe = await api.deps.shell({
    script: pythonInvocation(
      "from pathlib import Path\nprint('T3POC_WORKTREES_PENDING' if any(Path('/dev/shm/t3/worktree-state').glob('*/*.json')) else 'T3POC_WORKTREES_NONE')",
      'restore',
    ),
  });
  if (/^T3POC_WORKTREES_NONE\r?$/m.test(probe)) {
    api.log('workspace clone finished');
    return { ok: true };
  }
  if (!/^T3POC_WORKTREES_PENDING\r?$/m.test(probe)) throw new Error('thread worktree inventory failed');
  // Only a fresh restore needs to change git registrations. Reattaching a
  // relay with no pending snapshots must leave the running T3 process alone.
  const stopped = await api.deps.shell({ script: STOP_T3 });
  if (!stopped.includes('T3POC_T3_STOPPED')) throw new Error('T3 did not stop for workspace restoration');
  let failure;
  try {
    const source = withWorktrees('from vm_worktrees import main\nmain()', { history: true });
    const restored = await api.deps.shell({ script: pythonInvocation(source, 'restore') });
    if (!/^T3POC_WORKTREES_OK\r?$/m.test(restored)) throw new Error('thread worktree restore failed');
  } catch (error) {
    failure = error;
  }
  const started = await api.deps.shell({ script: START_T3 });
  if (!started.includes('T3POC_T3_STARTED')) throw new Error('T3 restart failed after workspace restoration');
  if (failure) throw failure;
  api.log('workspace clone finished');
  return { ok: true };
}
