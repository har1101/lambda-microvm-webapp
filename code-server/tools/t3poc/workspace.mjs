export const DEFAULT_REPOS = ['ai-native-factory/t3poc-sandbox'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function parseRepos(value) {
  const repos = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const list = repos.length ? repos : DEFAULT_REPOS;
  for (const repo of list) {
    if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  }
  return list;
}

/** Clone script. The GitHub token is read inside the VM from /dev/shm, never embedded here. */
export function cloneScript(repos) {
  const lines = [
    'set -eu',
    'if [ ! -s /dev/shm/gh-token ]; then echo T3POC_CLONE_SKIP no-token; echo T3POC_SHELL_DONE; exit 0; fi',
    'export GH_HOST=ai-native-factory-ltd.ghe.com',
    'GH_TOKEN="$(cat /dev/shm/gh-token)"',
    'export GH_TOKEN',
    'mkdir -p "$HOME/workspace"',
  ];
  for (const repo of parseRepos(repos.join(','))) {
    const name = repo.split('/')[1];
    lines.push(
      `if [ -d "$HOME/workspace/${name}/.git" ]; then git -C "$HOME/workspace/${name}" fetch --depth 1 origin; else gh repo clone ${repo} "$HOME/workspace/${name}" -- --depth 1; fi`,
    );
  }
  lines.push('unset GH_TOKEN', 'echo T3POC_CLONE_OK', 'echo T3POC_SHELL_DONE');
  return lines.join('\n');
}

export function wipScript() {
  return 'python3 /opt/cloud-ide/autopush.py --once wip\necho T3POC_WIP_OK\necho T3POC_SHELL_DONE\n';
}

export async function pushWip(api) {
  const out = await api.deps.shell({ script: wipScript() });
  if (!out.includes('T3POC_WIP_OK')) api.log('WIP push did not confirm (fail-open)');
  else api.log('WIP push finished');
  return out;
}

export async function cloneRepos(api) {
  const repos = parseRepos(api.deps.repos ?? process.env.T3POC_REPOS);
  const script = cloneScript(repos);
  if (/ghp_|github_pat_|x-access-token/i.test(script)) throw new Error('clone script embedded a token');
  const out = await api.deps.shell({ script });
  if (/T3POC_CLONE_OK|T3POC_CLONE_SKIP/.test(out)) api.log('workspace clone finished');
  else api.log('workspace clone did not confirm');
  return out;
}
