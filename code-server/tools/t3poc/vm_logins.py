"""Extract Claude/Codex login tarballs into VM /dev/shm only."""

from __future__ import annotations

import io
import os
import tarfile
from pathlib import Path

from vm_fs import secure_mkdir, secure_write

ALLOWED = {Path("/dev/shm/claude"), Path("/dev/shm/codex")}


class LoginRejected(Exception):
    pass


def extract_login(dest: Path, blob: bytes, allowed: set[Path] | None = None) -> None:
    permitted = {Path(os.path.abspath(path)) for path in (allowed or ALLOWED)}
    root = Path(os.path.abspath(dest))
    if root not in permitted:
        raise LoginRejected('dest rejected')
    validate_login(blob)
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:*') as archive:
        for member in archive.getmembers():
            if member.isdir():
                secure_mkdir(root, member.name)
            else:
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise LoginRejected('tar member rejected')
                secure_write(root, member.name, extracted.read())


def validate_login(blob: bytes) -> None:
    """Reject slip/links without writing the archive anywhere."""
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as archive:
        total = 0
        for member in archive.getmembers():
            total += member.size
            if total > 50 * 1024 * 1024 or not (member.isfile() or member.isdir()):
                raise LoginRejected('tar member rejected')
            if member.issym() or member.islnk() or member.isdev():
                raise LoginRejected("tar member rejected")
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise LoginRejected("tar member rejected")


def main(argv: list[str]) -> int:
    import sys

    cmd = argv[1] if len(argv) > 1 else ""
    try:
        if cmd == "validate":
            validate_login(sys.stdin.buffer.read())
            print("T3POC_LOGIN_TAR_OK")
            return 0
        if cmd == "extract":
            dest = Path(argv[2])
            blob = Path(argv[3]).read_bytes()
            extract_login(dest, blob)
            print("T3POC_LOGIN_OK")
            return 0
    except (LoginRejected, OSError, ValueError) as exc:
        print(f"T3POC_LOGIN_REJECTED {type(exc).__name__}")
        return 2
    print("usage: vm_logins.py validate | extract DEST TAR", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
