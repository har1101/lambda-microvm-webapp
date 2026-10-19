#!/usr/bin/env python3
"""T3 PoC: push work to GitHub before the MicroVM lifetime ends.

Runs only in T3 task VMs (CLOUD_IDE_KIND=t3). Never pushes to main/master,
never force-pushes, never stores credentials: the token lives in
/dev/shm/gh-token (RAM) and is passed to git via a credential helper.

Schedule (expiresAt from ~/.cache/omp-cloud-ide/session.json):
  every WIP_INTERVAL seconds : WIP snapshot -> refs/heads/wip/<id>
  expiresAt - 30 min         : push current branch + `gh pr create --draft`
  expiresAt - 10 min         : final WIP snapshot
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("HOME", "/home/vscode"))
WORKSPACE = Path(os.environ.get("AUTOPUSH_WORKSPACE", HOME / "workspace"))
SESSION_FILE = Path(os.environ.get("AUTOPUSH_SESSION_FILE", HOME / ".cache" / "omp-cloud-ide" / "session.json"))
STATUS_FILE = Path(os.environ.get("AUTOPUSH_STATUS_FILE", HOME / ".cache" / "omp-cloud-ide" / "autopush.json"))
TOKEN_FILE = Path(os.environ.get("GH_TOKEN_FILE", "/dev/shm/gh-token"))
WIP_INTERVAL = int(os.environ.get("AUTOPUSH_WIP_INTERVAL_SECONDS", "900"))
PR_LEAD = int(os.environ.get("AUTOPUSH_PR_LEAD_SECONDS", "1800"))
FINAL_LEAD = int(os.environ.get("AUTOPUSH_FINAL_LEAD_SECONDS", "600"))
PROTECTED = {"main", "master", "HEAD"}


def log(msg: str) -> None:
    print(f"[autopush] {msg}", flush=True)


def git(repo: Path, *args: str, check: bool = True, env: dict | None = None) -> str:
    out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=120, env=env)
    if check and out.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {out.stderr.strip()[:200]}")
    return out.stdout.strip()


def token() -> str | None:
    try:
        value = TOKEN_FILE.read_text().strip()
        return value or None
    except OSError:
        return None


def repos() -> list[Path]:
    """Git repos at depth 0-2 under the workspace (same depth as git-status.js)."""
    candidates = [WORKSPACE, *WORKSPACE.glob("*"), *WORKSPACE.glob("*/*")]
    return sorted({c for c in candidates if c.is_dir() and (c / ".git").exists()})


def session_id() -> str:
    try:
        return json.loads(SESSION_FILE.read_text()).get("microvmId", "")[-8:] or "local"
    except (OSError, ValueError):
        return "local"


def expires_at_ms() -> int | None:
    try:
        value = json.loads(SESSION_FILE.read_text()).get("expiresAt")
        return value if isinstance(value, int) else None
    except (OSError, ValueError):
        return None


def wip_push(repo: Path, sid: str) -> str:
    """Snapshot the working tree (tracked + untracked, .gitignore respected) without touching it."""
    head = git(repo, "rev-parse", "HEAD", check=False) or None
    env = dict(os.environ, GIT_INDEX_FILE=str(repo / ".git" / "autopush-index"))
    if head:
        git(repo, "read-tree", "HEAD", env=env)
    git(repo, "add", "-A", env=env)
    tree = git(repo, "write-tree", env=env)
    if head and tree == git(repo, "rev-parse", "HEAD^{tree}"):
        return "clean"
    parents = ["-p", head] if head else []
    commit = git(repo, "commit-tree", tree, *parents, "-m", f"WIP autopush {time.strftime('%Y-%m-%dT%H:%M:%S%z')}")
    ref = f"wip/{sid}"
    assert ref.split("/")[0] == "wip"
    git(repo, "push", "--no-verify", "origin", f"{commit}:refs/heads/{ref}")
    return ref


def branch_push_and_pr(repo: Path, sid: str) -> str:
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if branch in PROTECTED:
        branch = f"task/{sid}"
        git(repo, "switch", "-c", branch)
    if branch in PROTECTED:  # defensive, never reached
        raise RuntimeError("refusing to push protected branch")
    if git(repo, "status", "--porcelain"):
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "autopush: work in progress before MicroVM expiry")
    git(repo, "push", "--no-verify", "-u", "origin", f"HEAD:refs/heads/{branch}")
    pr = subprocess.run(
        ["gh", "pr", "create", "--draft", "--fill", "--head", branch],
        cwd=repo, capture_output=True, text=True, timeout=120,
        env=dict(os.environ, GH_TOKEN=token() or ""),
    )
    if pr.returncode != 0 and "already exists" not in pr.stderr:
        raise RuntimeError(f"gh pr create failed: {pr.stderr.strip()[:200]}")
    return pr.stdout.strip() or branch


def write_status(status: dict) -> None:
    try:
        STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATUS_FILE.write_text(json.dumps(status))
    except OSError:
        pass


def run_once(kind: str) -> dict:
    status = {"at": int(time.time()), "kind": kind, "results": {}}
    if not token():
        status["error"] = "no token (/dev/shm/gh-token); push skipped"
        log(status["error"])
        write_status(status)
        return status
    sid = session_id()
    for repo in repos():
        try:
            result = branch_push_and_pr(repo, sid) if kind == "pr" else wip_push(repo, sid)
        except Exception as error:  # noqa: BLE001 - keep looping
            result = f"error: {error}"
        status["results"][str(repo)] = result
        log(f"{kind} {repo}: {result}")
    write_status(status)
    return status


def loop() -> None:
    done_pr = done_final = False
    last_wip = time.time()
    while True:
        time.sleep(30)
        now = time.time()
        exp = expires_at_ms()
        if exp and not done_pr and now >= exp / 1000 - PR_LEAD:
            run_once("pr")
            done_pr = True
        if exp and not done_final and now >= exp / 1000 - FINAL_LEAD:
            run_once("wip")
            done_final = True
            last_wip = now
        if now - last_wip >= WIP_INTERVAL:
            run_once("wip")
            last_wip = now


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--once" and sys.argv[2] in {"wip", "pr"}:
        run_once(sys.argv[2])
    else:
        loop()
