"""Metadata-only RAM checks; no auth, filenames, or file contents are emitted."""
import os
import stat
import subprocess
import pwd
from pathlib import Path

MIB = 1024 * 1024
RESERVE = 8 * MIB
WORKTREE_LIMIT = 8 * MIB


def usage(root):
    info = os.statvfs(root)
    total = info.f_blocks * info.f_frsize
    free = info.f_bavail * info.f_frsize
    size = 0
    count = 0
    folder = root / 't3/worktrees'
    if folder.is_symlink():
        raise ValueError('unsafe worktree root')
    for base, dirs, files in os.walk(folder, followlinks=False):
        for name in dirs + files:
            item = Path(base) / name
            meta = item.lstat()
            count += 1
            if count > 100000:
                raise ValueError('worktree entry limit exceeded')
            if stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode):
                # Account conservatively for empty files and directory metadata.
                size += max(meta.st_size, meta.st_blocks * 512, 4096)
    return dict(total=total, free=free, used=total-free, worktrees=size,
                warning=free < RESERVE or free * 100 < total * 25 or size > WORKTREE_LIMIT)


def require_space(root, extra=0):
    state = usage(root)
    if state['free'] < RESERVE + extra:
        raise ValueError('RAM reserve insufficient; old VM must be retained')
    if state['worktrees'] > WORKTREE_LIMIT:
        raise ValueError('thread worktree RAM budget exceeded; old VM must be retained')
    return state


def clean_logs(root):
    # Only called with T3 stopped. Never recurse into auth directories or follow links.
    logs = root / 't3/userdata/logs'
    for parent in (root / 't3', root / 't3/userdata', logs):
        if parent.is_symlink():
            raise ValueError('unsafe log directory')
    paths = [root / 't3-serve.log', logs / 'server.trace.ndjson']
    paths += [logs / ('server.trace.ndjson.' + str(n)) for n in range(1, 101)]
    for path in paths:
        try:
            meta = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1:
            raise ValueError('unsafe runtime log')
        path.unlink()


# https://learn.chatgpt.com/docs/config-file/config-reference: features.remote_plugin
def disable_remote_catalog(root):
    """Disable the optional large catalog in RAM; never read or remove auth/history."""
    codex = root / 'codex'
    if root.is_symlink() or codex.is_symlink():
        raise ValueError('unsafe Codex configuration directory')
    created = not codex.exists()
    codex.mkdir(mode=0o700, exist_ok=True)
    owner = pwd.getpwnam('vscode') if root == Path('/dev/shm') else None
    fd = os.open(codex, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if created and owner:
            os.fchown(fd, owner.pw_uid, owner.pw_gid)
        try:
            config = os.open('config.toml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            config = None
        if config is not None:
            try:
                meta = os.fstat(config)
                if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1:
                    raise ValueError('unsafe Codex configuration file')
            finally:
                os.close(config)
    finally:
        os.close(fd)
    env = dict(os.environ, CODEX_HOME=str(codex))
    identity = {'user': owner.pw_uid, 'group': owner.pw_gid} if owner else {}
    try:
        disabled = subprocess.run(['codex', 'features', 'disable', 'remote_plugin'],
                                  cwd=codex, env=env, capture_output=True, timeout=30, **identity)
        if disabled.returncode:
            raise ValueError()
        checked = subprocess.run(['codex', 'features', 'list'], cwd=codex, env=env,
                                 capture_output=True, timeout=30, **identity)
        rows = [line.split() for line in checked.stdout.decode().splitlines()]
        if checked.returncode or not any(row[0] == 'remote_plugin' and row[-1] == 'false' for row in rows if row):
            raise ValueError()
    except Exception:
        raise ValueError('Codex remote catalog policy could not be verified') from None
