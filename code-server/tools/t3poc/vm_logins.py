"""Extract Claude/Codex login tarballs into VM /dev/shm only."""

from __future__ import annotations

import io
import os
import tarfile
from pathlib import Path

ALLOWED = {Path("/dev/shm/claude"), Path("/dev/shm/codex")}


class LoginRejected(Exception):
    pass


def extract_login(dest: Path, blob: bytes, allowed: set[Path] | None = None) -> None:
    permitted = {path.resolve() for path in (allowed or ALLOWED)}
    root = dest.resolve()
    if root not in permitted:
        raise LoginRejected("dest rejected")
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as archive:
        for member in archive.getmembers():
            if member.issym() or member.islnk() or member.isdev():
                raise LoginRejected("tar member rejected")
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise LoginRejected("tar member rejected")
            target = (root / member.name).resolve()
            if target != root and not str(target).startswith(f"{root}{os.sep}"):
                raise LoginRejected("tar member rejected")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise LoginRejected("tar member rejected")
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = archive.extractfile(member)
            if extracted is None:
                raise LoginRejected("tar member rejected")
            target.write_bytes(extracted.read())
            os.chmod(target, 0o600)


def validate_login(blob: bytes) -> None:
    """Reject slip/links without writing the archive anywhere."""
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as archive:
        for member in archive.getmembers():
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
    except LoginRejected as exc:
        print(f"T3POC_LOGIN_REJECTED {exc}")
        return 2
    print("usage: vm_logins.py validate | extract DEST TAR", flush=True)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
