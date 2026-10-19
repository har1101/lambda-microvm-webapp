"""T3 PoC: autopush.py pushes WIP/task branches, never main, never without a token."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUTOPUSH = Path(__file__).resolve().parent.parent / "artifact" / "base-image" / "autopush.py"


def sh(*args: str, cwd: Path) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class AutopushTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.remote = self.tmp / "remote.git"
        sh("git", "init", "-q", "--bare", "-b", "main", str(self.remote), cwd=self.tmp)
        self.ws = self.tmp / "workspace"
        self.repo = self.ws / "proj"
        self.repo.mkdir(parents=True)
        for cmd in (
            ["git", "init", "-q", "-b", "main"],
            ["git", "config", "user.email", "t@example.com"],
            ["git", "config", "user.name", "t"],
            ["git", "remote", "add", "origin", str(self.remote)],
        ):
            sh(*cmd, cwd=self.repo)
        (self.repo / "a.txt").write_text("1\n")
        sh("git", "add", "-A", cwd=self.repo)
        sh("git", "commit", "-qm", "init", cwd=self.repo)
        sh("git", "push", "-q", "origin", "main", cwd=self.repo)
        self.main_sha = sh("git", "rev-parse", "main", cwd=self.remote)
        self.session = self.tmp / "session.json"
        self.session.write_text(json.dumps({"microvmId": "mvm-0123456789abcdef", "expiresAt": 1}))
        self.token = self.tmp / "gh-token"
        self.status = self.tmp / "status.json"
        bindir = self.tmp / "bin"
        bindir.mkdir()
        fake_gh = bindir / "gh"
        fake_gh.write_text("#!/bin/sh\necho \"$@\" >> \"$FAKE_GH_LOG\"\necho https://example/pr/1\n")
        fake_gh.chmod(0o755)
        self.gh_log = self.tmp / "gh.log"
        self.env = dict(
            os.environ,
            HOME=str(self.tmp),
            PATH=f"{bindir}:{os.environ['PATH']}",
            AUTOPUSH_WORKSPACE=str(self.ws),
            AUTOPUSH_SESSION_FILE=str(self.session),
            AUTOPUSH_STATUS_FILE=str(self.status),
            GH_TOKEN_FILE=str(self.token),
            FAKE_GH_LOG=str(self.gh_log),
            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@e", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@e",
        )

    def run_once(self, kind: str) -> dict:
        subprocess.run([sys.executable, str(AUTOPUSH), "--once", kind], env=self.env, check=True, capture_output=True)
        return json.loads(self.status.read_text())

    def remote_refs(self) -> dict[str, str]:
        out = sh("git", "for-each-ref", "--format=%(refname) %(objectname)", cwd=self.remote)
        return dict(line.split(" ")[::-1][::-1] for line in out.splitlines()) if out else {}

    def test_no_token_skips_push(self) -> None:
        (self.repo / "a.txt").write_text("2\n")
        status = self.run_once("wip")
        self.assertIn("no token", status["error"])
        self.assertEqual(list(self.remote_refs()), ["refs/heads/main"])

    def test_wip_push_goes_to_wip_branch_and_leaves_tree_untouched(self) -> None:
        self.token.write_text("tok")
        (self.repo / "a.txt").write_text("2\n")
        (self.repo / "new.txt").write_text("n\n")
        status = self.run_once("wip")
        self.assertEqual(status["results"][str(self.repo)], "wip/89abcdef")
        refs = self.remote_refs()
        self.assertEqual(refs["refs/heads/main"], self.main_sha)
        self.assertIn("refs/heads/wip/89abcdef", refs)
        files = sh("git", "ls-tree", "--name-only", "wip/89abcdef", cwd=self.remote)
        self.assertIn("new.txt", files)
        # working tree / index unchanged
        self.assertIn("?? new.txt", sh("git", "status", "--porcelain", cwd=self.repo))
        self.assertEqual(sh("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=self.repo), "main")

    def test_pr_never_pushes_main(self) -> None:
        self.token.write_text("tok")
        (self.repo / "a.txt").write_text("3\n")
        self.run_once("pr")
        refs = self.remote_refs()
        self.assertEqual(refs["refs/heads/main"], self.main_sha)
        self.assertIn("refs/heads/task/89abcdef", refs)
        self.assertIn("pr create --draft", self.gh_log.read_text())


if __name__ == "__main__":
    unittest.main()
