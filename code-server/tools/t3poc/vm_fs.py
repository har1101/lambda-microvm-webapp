"""Descriptor-relative writes: never follow existing links out of the RAM root."""
from __future__ import annotations
import os
import pwd
import stat
import uuid
from pathlib import Path


def guest_owner(root: Path):
    if str(root) == '/dev/shm' or str(root) in ('/dev/shm/claude', '/dev/shm/codex'):
        user = pwd.getpwnam('vscode')
        return user.pw_uid, user.pw_gid
    return None  # Local fixture roots never change another user's ownership.


def _directories(root: Path, parts, owner):
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if owner is not None and str(root) != '/dev/shm':
            os.fchown(fd, *owner)
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            if owner is not None:
                os.fchown(fd, *owner)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _parts(rel: str):
    path = Path(rel)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError('unsafe relative path')
    return path.parts


def secure_mkdir(root: Path, rel: str):
    fd = _directories(root, _parts(rel), guest_owner(root))
    os.close(fd)


def secure_write(root: Path, rel: str, data: bytes):
    parts = _parts(rel)
    owner = guest_owner(root)
    directory = _directories(root, parts[:-1], owner)
    temporary = '.t3poc-' + uuid.uuid4().hex
    try:
        try:
            current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode):
                raise ValueError('destination is not a regular file')
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            if owner is not None:
                os.fchown(stream.fileno(), *owner)
        # Atomic replacement cannot follow a link even if one was created after stat.
        os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)
