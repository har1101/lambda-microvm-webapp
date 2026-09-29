// Pure parsing of `git status --porcelain=v1 --branch` output, kept free of the
// vscode module so it can be unit tested.

/**
 * Summarizes one repository. `localOnly` is the number of commits reachable
 * from HEAD but from no remote-tracking ref (`git rev-list --count HEAD --not
 * --remotes`), which also covers detached HEAD and branches whose upstream was
 * deleted. `unpushed` is true when such commits exist, the branch is ahead, its
 * upstream is gone, or it has commits but no upstream at all.
 */
function summarizeRepository(porcelain, localOnly = 0) {
  const lines = porcelain.split('\n').filter(Boolean);
  const branch = lines[0]?.startsWith('## ') ? lines[0].slice(3) : '';
  const changed = lines.filter((line) => !line.startsWith('## ')).length;
  const ahead = Math.max(Number(/\[(?:[^\]]*\s)?ahead (\d+)/.exec(branch)?.[1] ?? 0), localOnly);
  // "## No commits yet on main" has nothing to push; "## main" alone has no upstream.
  const hasCommits = branch !== '' && !branch.startsWith('No commits yet');
  const detached = branch.startsWith('HEAD (no branch)');
  const upstreamGone = /\[gone\]$/.test(branch);
  const noUpstream = hasCommits && !detached && (!branch.includes('...') || upstreamGone);
  return { changed, ahead, noUpstream, unpushed: ahead > 0 || noUpstream };
}

/** Status-bar text, severity and tooltip for all repositories under the workspace. */
function describeWorkspace(repos) {
  const dirty = repos.filter((repo) => repo.changed > 0);
  const unpushed = repos.filter((repo) => repo.unpushed);
  if (repos.length === 0) {
    return {
      text: '$(git-branch) Gitなし',
      level: 'warning',
      detail: 'workspace配下にGitリポジトリがありません。成果物はVM終了で失われます。',
    };
  }
  if (dirty.length === 0 && unpushed.length === 0) {
    return {
      text: '$(check) Git同期済み',
      level: 'normal',
      detail: `${repos.length}個のリポジトリはすべてcommit・push済みです。`,
    };
  }
  const parts = [];
  if (dirty.length) parts.push(`未commit ${dirty.length}`);
  if (unpushed.length) parts.push(`未push ${unpushed.length}`);
  const lines = repos
    .filter((repo) => repo.changed > 0 || repo.unpushed)
    .map((repo) => {
      const notes = [];
      if (repo.changed > 0) notes.push(`変更${repo.changed}件`);
      if (repo.ahead > 0) notes.push(`未push commit ${repo.ahead}件`);
      if (repo.noUpstream) notes.push('upstream未設定');
      return `${repo.name}: ${notes.join(', ')}`;
    });
  return {
    text: `$(git-commit) ${parts.join(' / ')}`,
    level: 'warning',
    detail: `VM終了で失われる変更があります。\n${lines.join('\n')}`,
  };
}

module.exports = { describeWorkspace, summarizeRepository };
