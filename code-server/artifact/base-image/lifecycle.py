#!/usr/bin/env python3
"""Lambda MicroVM hooks and encrypted S3 persistence for local auth state."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"
HOME = Path(os.environ.get("HOME", "/home/vscode"))
AGENT_DIR = Path(os.environ.get("PI_CODING_AGENT_DIR", HOME / ".omp" / "agent"))
BUCKET = os.environ.get("AUTH_STATE_BUCKET", "")
PREFIX = os.environ.get("AUTH_STATE_PREFIX", "personal").strip("/")
SYNC_INTERVAL = max(60, int(os.environ.get("AUTH_SYNC_INTERVAL_SECONDS", "300")))
STATE_DIR = HOME / ".cache" / "omp-cloud-ide"
SESSION_FILE = STATE_DIR / "session.json"
# Read by the code-server controls extension; written only while holding LOCK_FILE.
STATUS_FILE = STATE_DIR / "auth-sync.json"
LOCK_FILE = STATE_DIR / "auth-sync.lock"

# The image hook timeouts are run=30s and suspend/terminate=45s. Every hook
# answers within its budget, leaving margin for the HTTP reply.
HOOK_BUDGET_SECONDS = {"run": 25.0, "suspend": 40.0, "terminate": 40.0}
PERIODIC_BUDGET_SECONDS = 120.0
MANUAL_BUDGET_SECONDS = 120.0
AWS_CALL_TIMEOUT_SECONDS = 25.0

STATE_FILES = {
    "omp/agent.db": AGENT_DIR / "agent.db",
    "omp/install-id": HOME / ".omp" / "install-id",
    "github/hosts.yml": HOME / ".config" / "gh" / "hosts.yml",
}

# Set while a lifecycle hook waits for the sync lock; the periodic sync aborts
# its in-flight AWS call so Suspend/Terminate are not starved by routine work.
hook_waiting = threading.Event()
active_hooks = 0
active_hooks_lock = threading.Lock()


class SyncError(Exception):
    """A persistence step failed; `code` is safe to log and show (no secrets)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Deadline:
    def __init__(self, seconds: float) -> None:
        self._end = time.monotonic() + seconds

    def remaining(self) -> float:
        return self._end - time.monotonic()


def log(message: str) -> None:
    print(f"[lifecycle] {message}", flush=True)


def now_ms() -> int:
    return int(time.time() * 1000)


def run_aws(deadline: Deadline, abort: threading.Event | None, *args: str) -> dict:
    """Runs an AWS CLI call bounded by the deadline and returns its JSON output."""
    timeout = min(AWS_CALL_TIMEOUT_SECONDS, deadline.remaining())
    if timeout < 1:
        raise SyncError("DeadlineExceeded")
    with subprocess.Popen(
        ["aws", *args, "--output", "json"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ) as process:
        end = time.monotonic() + timeout
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if abort is not None and abort.is_set():
                    process.kill()
                    process.communicate()
                    raise SyncError("Preempted") from None
                if time.monotonic() >= end:
                    process.kill()
                    process.communicate()
                    raise SyncError("Timeout") from None
    if process.returncode != 0:
        # AWS CLI errors read "An error occurred (Code) when calling ...".
        match = re.search(r"\(([A-Za-z0-9]+)\)", stderr)
        raise SyncError(match.group(1) if match else f"Exit{process.returncode}")
    return json.loads(stdout or "{}")


@contextlib.contextmanager
def sync_lock(deadline: Deadline | None) -> Iterator[None]:
    """Serializes daemon threads and the separate `persist-auth-state` process.

    With no deadline the caller does not wait (periodic sync skips a busy cycle).
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "a") as handle:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if deadline is None or deadline.remaining() < 2:
                    raise SyncError("LockBusy") from None
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load_status() -> dict:
    try:
        status = json.loads(STATUS_FILE.read_text())
    except (OSError, ValueError):
        return {}
    return status if isinstance(status, dict) else {}


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as tmp:
        json.dump(value, tmp)
    os.replace(tmp.name, path)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def restore_state(deadline: Deadline) -> None:
    """Restores auth files on /run. Fail-open: the IDE starts even if S3 is unreachable.

    A key whose restore failed is marked `restoreFailed`, and automatic syncs will
    not upload it, so an unauthenticated local file never overwrites good state in
    S3. `persist-auth-state` (after logging in again) lifts the block.
    """
    if not BUCKET:
        log("AUTH_STATE_BUCKET is unset; restore skipped")
        return

    with sync_lock(deadline):
        files: dict[str, dict] = {}
        failed: list[str] = []
        restored = 0
        for key, target in STATE_FILES.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
                temp_path = Path(tmp.name)
            try:
                meta = run_aws(
                    deadline,
                    None,
                    "s3api",
                    "get-object",
                    "--bucket",
                    BUCKET,
                    "--key",
                    f"{PREFIX}/{key}",
                    str(temp_path),
                )
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, target)
                files[key] = {
                    "sha256": file_sha256(target),
                    "etag": meta.get("ETag"),
                    "versionId": meta.get("VersionId"),
                }
                restored += 1
            except SyncError as error:
                if error.code == "NoSuchKey":
                    # First save must then create the object, not replace one another VM wrote.
                    files[key] = {"missing": True}
                else:
                    failed.append(key)
                    log(f"restore failed for {key}: {error.code}")
            except OSError as error:
                failed.append(key)
                log(f"restore failed for {key}: {type(error).__name__}")
            finally:
                temp_path.unlink(missing_ok=True)

        attempted_at = now_ms()
        write_json_atomic(
            STATUS_FILE,
            {
                "files": files,
                "lastTrigger": "run",
                "lastAttemptAt": attempted_at,
                "lastSuccessAt": None if failed else attempted_at,
                "failed": [],
                "conflicts": [],
                "restoreFailed": failed,
            },
        )
        log(f"restored {restored} auth-state file(s); restore failures={failed}")


def sqlite_snapshot(source: Path, destination: Path) -> None:
    source_uri = f"file:{source}?mode=ro"
    with sqlite3.connect(source_uri, uri=True, timeout=5) as source_db:
        with sqlite3.connect(destination) as backup_db:
            source_db.backup(backup_db)


def upload_file(
    key: str, source: Path, record: dict, deadline: Deadline, mode: str, abort: threading.Event | None
) -> str:
    """Uploads a consistent snapshot unless it matches the last confirmed upload.

    Writes are conditional on the S3 object still being the one this VM last
    restored or wrote (ETag), so a stale VM cannot silently replace credentials
    another MicroVM refreshed. Only "overwrite", or a key whose ETag is unknown
    because its restore failed, writes unconditionally.
    """
    with tempfile.TemporaryDirectory(prefix="omp-auth-") as temp_dir:
        snapshot = Path(temp_dir) / source.name
        if source.name == "agent.db":
            sqlite_snapshot(source, snapshot)
        else:
            shutil.copy2(source, snapshot)
        os.chmod(snapshot, 0o600)
        digest = file_sha256(snapshot)
        if mode != "overwrite" and record.get("sha256") == digest:
            return "unchanged"
        precondition: list[str] = []
        if mode != "overwrite":
            if record.get("etag"):
                precondition = ["--if-match", record["etag"]]
            elif record.get("missing"):
                precondition = ["--if-none-match", "*"]
        try:
            meta = run_aws(
                deadline,
                abort,
                "s3api",
                "put-object",
                "--bucket",
                BUCKET,
                "--key",
                f"{PREFIX}/{key}",
                "--body",
                str(snapshot),
                *precondition,
            )
        except SyncError as error:
            # Only a failed precondition proves another writer won; a 409
            # ConditionalRequestConflict is transient and is retried next sync.
            if error.code == "PreconditionFailed":
                return "conflict"
            raise
    record.clear()
    record.update(sha256=digest, etag=meta.get("ETag"), versionId=meta.get("VersionId"), savedAt=now_ms())
    return "uploaded"


def persist_state(
    trigger: str,
    deadline: Deadline,
    *,
    wait_for_lock: bool,
    mode: str = "auto",
    abort: threading.Event | None = None,
) -> dict[str, str]:
    """Saves auth files to S3 and records the outcome in STATUS_FILE.

    mode: "auto" (periodic/hooks) skips keys blocked by a failed restore or a
    conflict; "manual" also saves restore-blocked keys (the user logged in again);
    "overwrite" unconditionally replaces S3 with this VM's files.
    Returns {key: outcome}; outcomes other than uploaded/unchanged/absent are failures.
    """
    if not BUCKET:
        return {}

    with sync_lock(deadline if wait_for_lock else None):
        status = load_status()
        files = status.setdefault("files", {})
        blocked = set(status.get("restoreFailed", []))
        conflicts = set(status.get("conflicts", []))
        results: dict[str, str] = {}
        for key, source in STATE_FILES.items():
            if not source.is_file():
                results[key] = "absent"
                continue
            if mode == "auto" and key in blocked:
                results[key] = "blocked-after-restore-failure"
                continue
            if mode == "auto" and key in conflicts:
                results[key] = "conflict"
                continue
            try:
                results[key] = upload_file(key, source, files.setdefault(key, {}), deadline, mode, abort)
            except SyncError as error:
                results[key] = error.code
            except (OSError, sqlite3.Error) as error:
                results[key] = type(error).__name__
            if results[key] == "uploaded":
                blocked.discard(key)
                conflicts.discard(key)
            elif results[key] == "conflict":
                conflicts.add(key)

        failed = sorted(key for key, outcome in results.items() if outcome not in {"uploaded", "unchanged", "absent"})
        attempted_at = now_ms()
        status.update(
            lastTrigger=trigger,
            lastAttemptAt=attempted_at,
            failed=failed,
            restoreFailed=sorted(blocked),
            conflicts=sorted(conflicts),
        )
        if not failed:
            status["lastSuccessAt"] = attempted_at
        write_json_atomic(STATUS_FILE, status)

    changed = {key: outcome for key, outcome in results.items() if outcome not in {"unchanged", "absent"}}
    if changed or trigger != "periodic":
        log(f"{trigger} sync: {changed or 'no changes'}")
    return results


def record_session(body: bytes) -> None:
    """Write the MicroVM lifetime deadline read by the IDE status bar.

    Lambda wraps RunMicrovm's runHookPayload string as
    {"microvmId": ..., "runHookPayload": "..."}; the Edge puts expiresAt
    (epoch ms) inside that string. The VM itself cannot query GetMicrovm.
    """
    try:
        envelope = json.loads(body)
        payload = json.loads(envelope.get("runHookPayload") or "{}")
        expires_at = payload.get("expiresAt")
    except (json.JSONDecodeError, AttributeError, TypeError):
        log("run hook body did not contain a JSON runHookPayload")
        return
    if not isinstance(expires_at, int) or isinstance(expires_at, bool) or expires_at <= 0:
        log("run hook payload has no expiresAt; session deadline unknown")
        return

    try:
        write_json_atomic(SESSION_FILE, {"microvmId": str(envelope.get("microvmId", "")), "expiresAt": expires_at})
    except OSError as error:
        log(f"could not record session deadline: {type(error).__name__}")
        return
    log("recorded session deadline")


def code_server_ready() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/healthz", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def periodic_sync() -> None:
    while True:
        time.sleep(SYNC_INTERVAL)
        if hook_waiting.is_set():
            continue
        try:
            persist_state("periodic", Deadline(PERIODIC_BUDGET_SECONDS), wait_for_lock=False, abort=hook_waiting)
        except SyncError as error:
            if error.code != "LockBusy":
                log(f"periodic sync skipped: {error.code}")
        except Exception as error:  # noqa: BLE001 - keep the daemon thread alive
            log(f"periodic sync crashed: {type(error).__name__}")


def run_hook(name: str, action) -> None:
    """Runs a hook action within its budget. Fail-open: errors are logged and recorded,
    never turned into a hook failure that could block Run/Suspend/Terminate."""
    global active_hooks
    with active_hooks_lock:
        active_hooks += 1
        hook_waiting.set()
    try:
        action(Deadline(HOOK_BUDGET_SECONDS[name]))
    except SyncError as error:
        log(f"{name} hook could not sync: {error.code}")
    except Exception as error:  # noqa: BLE001 - the hook must still answer
        log(f"{name} hook crashed: {type(error).__name__}")
    finally:
        with active_hooks_lock:
            active_hooks -= 1
            # Concurrent hooks share the flag; only the last one may release it.
            if active_hooks == 0:
                hook_waiting.clear()


class HookHandler(BaseHTTPRequestHandler):
    server_version = "omp-cloud-ide-hooks/1"

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        content_length = int(self.headers.get("content-length", "0"))
        payload = self.rfile.read(content_length) if content_length else b""

        if self.path in {f"{HOOK_PREFIX}/ready", f"{HOOK_PREFIX}/validate"}:
            self.respond(200 if code_server_ready() else 503)
            return

        if self.path == f"{HOOK_PREFIX}/run":
            record_session(payload)
            run_hook("run", restore_state)
            self.respond(200)
            return

        if self.path == f"{HOOK_PREFIX}/resume":
            self.respond(200)
            return

        for name in ("suspend", "terminate"):
            if self.path == f"{HOOK_PREFIX}/{name}":
                run_hook(name, lambda deadline, trigger=name: persist_state(trigger, deadline, wait_for_lock=True))
                self.respond(200)
                return

        self.respond(404)

    def log_message(self, format: str, *args: object) -> None:
        return

    def respond(self, status: int) -> None:
        self.send_response(status)
        self.send_header("content-length", "0")
        self.end_headers()


def manual_sync(overwrite: bool = False) -> int:
    """`persist-auth-state [--overwrite]`: save changed files and report per-file results."""
    if not BUCKET:
        print("AUTH_STATE_BUCKET is unset; nothing was saved.", file=sys.stderr)
        return 1
    mode = "overwrite" if overwrite else "manual"
    try:
        results = persist_state("manual", Deadline(MANUAL_BUDGET_SECONDS), wait_for_lock=True, mode=mode)
    except SyncError as error:
        print(f"auth state was not saved: {error.code}", file=sys.stderr)
        return 1
    for key, outcome in results.items():
        print(f"{key}: {outcome}")
    failed = [key for key, outcome in results.items() if outcome not in {"uploaded", "unchanged", "absent"}]
    if any(results[key] == "conflict" for key in failed):
        print(
            "CONFLICT: another MicroVM saved newer auth state to S3, so this VM's copy was not written.\n"
            "Keep using the other VM's credentials (log in again here if needed), or run\n"
            "`persist-auth-state --overwrite` to replace S3 with this VM's files.",
            file=sys.stderr,
        )
    if failed:
        print(f"FAILED: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("auth state saved to S3")
    return 0


if __name__ == "__main__":
    AGENT_DIR.mkdir(parents=True, exist_ok=True)
    for target in STATE_FILES.values():
        target.parent.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) >= 2 and sys.argv[1] == "--sync":
        extra = sys.argv[2:]
        if extra not in ([], ["--overwrite"]):
            print("usage: persist-auth-state [--overwrite]", file=sys.stderr)
            raise SystemExit(2)
        raise SystemExit(manual_sync(overwrite=extra == ["--overwrite"]))
    threading.Thread(target=periodic_sync, daemon=True).start()
    log(f"hook server listening on port 9000; sync interval={SYNC_INTERVAL}s")
    ThreadingHTTPServer(("0.0.0.0", 9000), HookHandler).serve_forever()
