"""Metadata-only RAM checks; no auth, filenames, or file contents are emitted."""
import os
import stat
import pwd
import tomllib
import json
import datetime
import math
import secrets
import shutil
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
def disable_remote_catalog(root, public_cache=Path('/tmp/t3poc-public-catalog-vscode')):
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
    # Do not invoke Codex here: even a configuration command can hydrate plugins
    # before executing its subcommand. Preserve all TOML values semantically.
    directory = os.open(codex, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.catalog-config-' + secrets.token_hex(8)
    try:
        try:
            fd = os.open('config.toml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            fd = None
        config = {}
        if fd is not None:
            with os.fdopen(fd, 'rb') as stream:
                meta = os.fstat(stream.fileno())
                if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_size > MIB:
                    raise ValueError('unsafe Codex configuration file')
                raw = stream.read(MIB + 1)
                if len(raw) > MIB:
                    raise ValueError('Codex configuration too large')
                config = tomllib.loads(raw.decode())
        features = config.setdefault('features', {})
        if not isinstance(features, dict):
            raise ValueError('invalid Codex features configuration')
        features.update(remote_plugin=False, plugins=False)
        data = ('\n'.join(json.dumps(k, ensure_ascii=False) + ' = ' + toml_value(v)
                          for k, v in config.items()) + '\n').encode()
        if len(data) > MIB or tomllib.loads(data.decode()) != config:
            raise ValueError('Codex configuration cannot be preserved')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, 'wb') as stream:
            if owner:
                os.fchown(stream.fileno(), owner.pw_uid, owner.pw_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, 'config.toml', src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)
    setup_public_catalog_cache(root, public_cache)
    clean_plugin_clone_temps(root)


def setup_public_catalog_cache(root, public_cache):
    """Only public catalog JSON may leave RAM; never relocate mixed cache/tmp roots."""
    owner = pwd.getpwnam('vscode') if root == Path('/dev/shm') else None
    uid, gid = (owner.pw_uid, owner.pw_gid) if owner else (os.getuid(), os.getgid())
    for folder in (root / 'codex', root / 'codex/cache', public_cache):
        created = not folder.exists() and not folder.is_symlink()
        if folder.is_symlink():
            raise ValueError('unsafe public catalog cache directory')
        folder.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if created:
                os.fchown(fd, uid, gid)
            meta = os.fstat(fd)
            if meta.st_uid != uid:
                raise ValueError('unsafe public catalog cache ownership')
            # Tighten directory metadata only; no auth/history file is opened.
            os.fchmod(fd, 0o700)
            if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
                raise ValueError('unsafe public catalog cache ownership')
        finally:
            os.close(fd)
    if root == Path('/dev/shm') and public_cache.stat().st_dev == root.stat().st_dev:
        raise ValueError('public catalog cache must be outside RAM')
    link = root / 'codex/cache/remote_plugin_catalog'
    if link.is_symlink():
        if os.readlink(link) != str(public_cache):
            raise ValueError('unexpected catalog cache link')
        return
    if link.exists():
        if not link.is_dir() or any(link.iterdir()):
            raise ValueError('existing catalog cache must be reviewed before relocation')
        link.rmdir()
    link.symlink_to(public_cache, target_is_directory=True)


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('nonfinite Codex configuration value')
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{' + ', '.join(json.dumps(k, ensure_ascii=False) + ' = ' + toml_value(v)
                               for k, v in value.items()) + '}'
    raise ValueError('unsupported Codex configuration value')


def clean_plugin_clone_temps(root):
    """Call only after T3 stops and plugin initialization is disabled."""
    folder = root / 'codex/.tmp'
    try:
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    try:
        if not shutil.rmtree.avoids_symlink_attacks:
            raise ValueError('safe plugin temporary cleanup is unavailable')
        for name in os.listdir(directory):
            if not name.startswith('plugins-clone-'):
                continue
            meta = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISDIR(meta.st_mode):
                raise ValueError('unsafe plugin clone temporary directory')
            shutil.rmtree(name, dir_fd=directory)
    finally:
        os.close(directory)
