"""Split T3 /dev/shm state into history (S3) and pairing secrets (Keychain).

History and secrets that cannot be separated abort the backup. Nothing here
writes credential material to a path outside the given root/scratch, and the
Mac relay keeps the pairing bundle in memory and the keychain only.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import sqlite3
import tarfile

from vm_fs import secure_write
from pathlib import Path

# Paths relative to the scan root (the VM's /dev/shm). A match is omitted from
# the history archive. Pairing secrets are a subset stored separately.
EXCLUDED_ROOTS = ("claude", "codex", "gh-token")
SECRET_NAME_PARTS = ("token", "secret", "credential", "password")
EXCLUDED_FILE_NAMES = {"clerk-tokens.json", "hosts.yml"}
AUTH_TABLE_RE = re.compile(r"^(auth_.*|.*secret.*|.*credential.*)$", re.I)
SECRET_COLUMN_RE = re.compile(r"token|secret|credential|password|private_key|cookie", re.I)
# T3 0.1.0 always creates these nullable columns, even with no webhooks.
# Preserve their schema only while every value is NULL. Configured webhook
# credentials still fail closed before SELECT * can load them into history.
NULL_ONLY_SECRET_COLUMNS = {"scheduled_tasks": frozenset({"webhook_token", "webhook_secret"})}

MARKERS = (
    b'"refresh_token"',
    b'"access_token"',
    b'"id_token"',
    b'"client_secret"',
    b"BEGIN PRIVATE KEY",
    b"BEGIN RSA PRIVATE KEY",
    b"ghp_",
    b"ghs_",
    b"ghu_",
    b"ghr_",
    b"sk-proj-",
    b"github_pat_",
    b"sk-ant-",
)
SECRET_PATH_RE = re.compile(r"^t3/userdata/secrets/[A-Za-z0-9._-]+\.bin$")
MAX_SCAN_BYTES = 50 * 1024 * 1024


class HistoryNotSeparable(Exception):
    """History and secrets are mixed. Callers must not upload anything."""


def path_excluded(rel: str) -> bool:
    """True when `rel` is on the explicit exclusion list (not history)."""
    parts = [p for p in Path(rel).parts if p not in (".",)]
    if not parts or ".." in parts:
        return True
    if parts[0] in EXCLUDED_ROOTS:
        return True
    if "secrets" in parts:
        return True
    name = parts[-1]
    if name in EXCLUDED_FILE_NAMES:
        return True
    lowered = name.lower()
    if any(part in lowered for part in SECRET_NAME_PARTS):
        return True
    if lowered.endswith((".sqlite-wal", ".sqlite-shm", ".db-wal", ".db-shm")):
        return True
    return False


def is_pairing_secret(rel: str) -> bool:
    return SECRET_PATH_RE.fullmatch(rel) is not None


def _marker_hit(data: bytes) -> bool:
    return any(marker in data for marker in MARKERS)


def scan_bytes(data: bytes, where: str) -> None:
    if len(data) > MAX_SCAN_BYTES:
        raise HistoryNotSeparable(f"{where} is too large to separate from secrets")
    if _marker_hit(data):
        raise HistoryNotSeparable(f"{where} contains a credential marker")


def qident(name: str) -> str:
    if "\x00" in name or name == "":
        raise HistoryNotSeparable("invalid sqlite identifier")
    return '"' + name.replace('"', '""') + '"'


def _tables(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return [row[0] for row in rows]


def _is_auth_table(name: str) -> bool:
    return AUTH_TABLE_RE.match(name) is not None


def assert_secret_columns_empty(con: sqlite3.Connection, table: str) -> None:
    for info in con.execute(f"PRAGMA table_info({qident(table)})"):
        column = info[1]
        if not SECRET_COLUMN_RE.search(column):
            continue
        default_is_null = info[4] is None or str(info[4]).strip().upper() == "NULL"
        allowed = column in NULL_ONLY_SECRET_COLUMNS.get(table, ()) and not info[3] and default_is_null
        if allowed and con.execute(
            f"SELECT 1 FROM {qident(table)} WHERE {qident(column)} IS NOT NULL LIMIT 1"
        ).fetchone() is None:
            continue
        raise HistoryNotSeparable(f"sqlite table {table} column {column} cannot be separated from secrets")


def export_auth_table(con: sqlite3.Connection, table: str) -> dict:
    if not _is_auth_table(table):
        raise HistoryNotSeparable(f"refusing to export non-auth table {table}")
    create = con.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if not create or not create[0] or ";" in create[0]:
        raise HistoryNotSeparable(f"auth table {table} has no separable schema")
    columns = [row[1] for row in con.execute(f"PRAGMA table_info({qident(table)})")]
    exported = []
    for rec in con.execute(f"SELECT * FROM {qident(table)}"):
        row = []
        for value in rec:
            if isinstance(value, bytes):
                row.append({"b64": base64.b64encode(value).decode()})
            else:
                row.append(value)
        exported.append(row)
    return {"name": table, "create": create[0], "columns": columns, "rows": exported}


def sanitize_sqlite(src: Path, dest: Path) -> list[dict]:
    """Copy non-auth tables to `dest`. Return auth-table payloads for the keychain."""
    src_con = sqlite3.connect(src)
    try:
        src_con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # Validate and copy one read snapshot, even if another process writes.
        src_con.execute("BEGIN")
        auth: list[dict] = []
        keep: list[str] = []
        for table in _tables(src_con):
            if _is_auth_table(table):
                auth.append(export_auth_table(src_con, table))
                continue
            assert_secret_columns_empty(src_con, table)
            for rec in src_con.execute(f"SELECT * FROM {qident(table)}"):
                for value in rec:
                    if isinstance(value, str):
                        raw = value.encode()
                    elif isinstance(value, bytes):
                        raw = value
                    else:
                        continue
                    if _marker_hit(raw):
                        raise HistoryNotSeparable(f"sqlite table {table} contains a credential marker")
            keep.append(table)
        if dest.exists():
            dest.unlink()
        dest_con = sqlite3.connect(dest)
        try:
            dest_con.execute("PRAGMA foreign_keys = OFF")
            for table in keep:
                create = src_con.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
                ).fetchone()[0]
                dest_con.execute(create)
                rows = src_con.execute(f"SELECT * FROM {qident(table)}").fetchall()
                if rows:
                    placeholders = ",".join("?" for _ in rows[0])
                    dest_con.executemany(
                        f"INSERT INTO {qident(table)} VALUES ({placeholders})", rows
                    )
            if src_con.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
                for table, seq in src_con.execute("SELECT name, seq FROM sqlite_sequence"):
                    if table in keep:
                        dest_con.execute("DELETE FROM sqlite_sequence WHERE name=?", (table,))
                        dest_con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)", (table, seq))
            for kind, name, table, sql in src_con.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL"
            ):
                if kind != 'view' and table not in keep:
                    continue
                if any(_is_auth_table(word) for word in re.findall(r'[A-Za-z_][A-Za-z0-9_]*', sql)):
                    continue
                dest_con.execute(sql)
            user_version = src_con.execute('PRAGMA user_version').fetchone()[0]
            application_id = src_con.execute('PRAGMA application_id').fetchone()[0]
            dest_con.execute(f'PRAGMA user_version = {user_version}')
            dest_con.execute(f'PRAGMA application_id = {application_id}')
            dest_con.commit()
        finally:
            dest_con.close()
        return auth
    finally:
        src_con.close()


def pairing_only(root: Path) -> dict:
    """Auth tables and secret files only. Does not read history rows into the bundle."""
    secrets = []
    auth_tables: list[dict] = []
    environment_id = None
    for path in sorted(p for p in root.rglob("*") if p.is_file() or p.is_symlink()):
        rel = path.relative_to(root).as_posix()
        if not rel.startswith("t3/"):
            continue
        if path.is_symlink():
            raise HistoryNotSeparable("symlink under the state root cannot be separated")
        rel = path.relative_to(root).as_posix()
        if is_pairing_secret(rel):
            secrets.append({"path": rel, "b64": base64.b64encode(path.read_bytes()).decode()})
            continue
        if rel == "t3/userdata/environment-id":
            environment_id = path.read_bytes().decode("utf-8")
            continue
        if path.name.endswith(".sqlite") and not path_excluded(rel):
            con = sqlite3.connect(path)
            try:
                con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                for table in _tables(con):
                    if _is_auth_table(table):
                        auth_tables.append(export_auth_table(con, table))
            finally:
                con.close()
    return {"secrets": secrets, "auth_tables": auth_tables, "environment_id": environment_id}


def build_split(root: Path, scratch: Path) -> tuple[bytes, dict]:
    """Return (history tar, pairing bundle). Raises HistoryNotSeparable and writes no tar."""
    scratch.mkdir(parents=True, exist_ok=True)
    pairing = {"secrets": [], "auth_tables": [], "environment_id": None}
    entries: list[tuple[str, bytes]] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() or p.is_symlink()):
        rel = path.relative_to(root).as_posix()
        if not rel.startswith("t3/"):
            continue
        if path.is_symlink():
            raise HistoryNotSeparable("symlink under the state root cannot be separated")
        rel = path.relative_to(root).as_posix()
        if is_pairing_secret(rel):
            data = path.read_bytes()
            pairing["secrets"].append({"path": rel, "b64": base64.b64encode(data).decode()})
            continue
        if path_excluded(rel):
            continue
        if rel == "t3/userdata/environment-id":
            environment_id = path.read_bytes().decode("utf-8")
            pairing["environment_id"] = environment_id
            scan_bytes(environment_id.encode(), rel)
            entries.append((rel, environment_id.encode()))
            continue
        if path.name.endswith(".sqlite"):
            dest = scratch / (rel.replace("/", "_") + ".sanitized")
            pairing["auth_tables"].extend(sanitize_sqlite(path, dest))
            blob = dest.read_bytes()
            entries.append((rel, blob))
            continue
        blob = path.read_bytes()
        scan_bytes(blob, rel)
        entries.append((rel, blob))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, blob in entries:
            info = tarfile.TarInfo(name)
            info.size = len(blob)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(blob))
    tar_bytes = buffer.getvalue()
    check_tar(tar_bytes)
    return tar_bytes, pairing


def check_tar(tar_bytes: bytes) -> None:
    """Reject a history archive that contains excluded paths or credential markers."""
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        for member in archive.getmembers():
            if member.issym() or member.islnk() or member.isdev():
                raise HistoryNotSeparable("history archive contains a link")
            name = member.name
            if name.startswith("/") or ".." in Path(name).parts:
                raise HistoryNotSeparable("history archive path escapes the root")
            if not name.startswith("t3/") or path_excluded(name):
                raise HistoryNotSeparable(f"history archive contains excluded path {name}")
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            data = extracted.read()
            scan_bytes(data, name)
            if name.endswith(".sqlite"):
                _assert_sqlite_has_no_auth(data, name)


def _assert_sqlite_has_no_auth(blob: bytes, where: str) -> None:
    # In memory only. A history archive that still has auth tables is rejected
    # before upload; the bytes are not written to disk to inspect them.
    con = sqlite3.connect(":memory:")
    try:
        con.deserialize(blob)
        for table in _tables(con):
            if _is_auth_table(table):
                raise HistoryNotSeparable(f"{where} still contains auth table {table}")
            assert_secret_columns_empty(con, table)
    finally:
        con.close()


def apply_pairing(root: Path, pairing: dict) -> None:
    environment_id = pairing.get("environment_id")
    # T3 writes an ID followed by a newline. Preserve its exact file bytes,
    # accepting only the canonical ID and at most one LF/CRLF terminator.
    if environment_id is not None and (
        not isinstance(environment_id, str)
        or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}(?:\r?\n)?", environment_id)
    ):
        raise HistoryNotSeparable("environment-id rejected")
    for item in pairing.get("secrets") or []:
        rel = item.get("path", "")
        if not is_pairing_secret(rel):
            raise HistoryNotSeparable("pairing secret path rejected")
        secure_write(root, rel, base64.b64decode(item["b64"]))
    db_path = root / "t3/userdata/statev2.sqlite"
    tables = pairing.get("auth_tables") or []
    if tables:
        con = sqlite3.connect(':memory:')
        if db_path.exists():
            # Reject symlinks on every component before opening an existing DB.
            from vm_fs import _directories
            parent = _directories(root, ('t3', 'userdata'), None)
            try:
                fd = os.open('statev2.sqlite', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                with os.fdopen(fd, 'rb') as stream:
                    con.deserialize(stream.read())
            finally:
                os.close(parent)
        try:
            for table in tables:
                name = table.get("name", "")
                create = table.get("create", "")
                if not _is_auth_table(name) or ";" in create or not create.upper().startswith("CREATE TABLE"):
                    raise HistoryNotSeparable("pairing table rejected")
                if name not in create:
                    raise HistoryNotSeparable("pairing table schema does not match its name")
                con.execute(f"DROP TABLE IF EXISTS {qident(name)}")
                con.execute(create)
                rows = []
                for row in table.get("rows") or []:
                    decoded = []
                    for value in row:
                        if isinstance(value, dict) and "b64" in value:
                            decoded.append(base64.b64decode(value["b64"]))
                        else:
                            decoded.append(value)
                    rows.append(decoded)
                if rows:
                    placeholders = ",".join("?" for _ in rows[0])
                    con.executemany(f"INSERT INTO {qident(name)} VALUES ({placeholders})", rows)
            con.commit()
            secure_write(root, 't3/userdata/statev2.sqlite', con.serialize())
        finally:
            con.close()
    if environment_id is not None:
        secure_write(root, 't3/userdata/environment-id', environment_id.encode())


def restore_history(root: Path, tar_bytes: bytes) -> None:
    check_tar(tar_bytes)
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            assert extracted is not None
            secure_write(root, member.name, extracted.read())


def _emit(root: Path) -> None:
    scratch = root / "t3poc-scratch"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir()
    try:
        tar_bytes, pairing = build_split(root, scratch)
    except HistoryNotSeparable as exc:
        print(f"T3POC_BACKUP_ABORT {exc}")
        return
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("T3POC_HISTORY_B64")
    print(base64.b64encode(tar_bytes).decode())
    print("T3POC_HISTORY_END")
    print("T3POC_PAIRING_B64")
    print(base64.b64encode(json.dumps(pairing).encode()).decode())
    print("T3POC_PAIRING_END")


def _payload(argv: list[str]) -> bytes:
    if len(argv) > 2:
        # VM path: the relay placed bytes in /dev/shm (RAM), never on the Mac disk.
        return Path(argv[2]).read_bytes()
    return sys_stdin()


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ""
    root = Path("/dev/shm")
    try:
        if cmd == "emit":
            _emit(root)
            return 0
        if cmd == "emit-pairing":
            print("T3POC_PAIRING_B64")
            print(base64.b64encode(json.dumps(pairing_only(root)).encode()).decode())
            print("T3POC_PAIRING_END")
            return 0
        if cmd == "check-tar":
            check_tar(_payload(argv))
            print("T3POC_TAR_OK")
            return 0
        if cmd == "restore":
            restore_history(root, _payload(argv))
            print("T3POC_RESTORE_OK")
            return 0
        if cmd == "apply-pairing":
            apply_pairing(root, json.loads(_payload(argv)))
            print("T3POC_PAIRING_OK")
            return 0
    except (HistoryNotSeparable, OSError, ValueError, sqlite3.Error) as exc:
        print(f"T3POC_BACKUP_ABORT {type(exc).__name__}")
        return 2
    print("usage: vm_history.py emit|emit-pairing|check-tar|restore|apply-pairing", flush=True)
    return 2


def sys_stdin() -> bytes:
    import sys

    return sys.stdin.buffer.read()


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
