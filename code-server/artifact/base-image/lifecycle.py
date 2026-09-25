#!/usr/bin/env python3
"""Lambda MicroVM hooks and encrypted S3 persistence for local auth state."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1"
HOME = Path(os.environ.get("HOME", "/home/vscode"))
AGENT_DIR = Path(os.environ.get("PI_CODING_AGENT_DIR", HOME / ".omp" / "agent"))
BUCKET = os.environ.get("AUTH_STATE_BUCKET", "")
PREFIX = os.environ.get("AUTH_STATE_PREFIX", "personal").strip("/")
SYNC_INTERVAL = max(60, int(os.environ.get("AUTH_SYNC_INTERVAL_SECONDS", "300")))
SESSION_FILE = HOME / ".cache" / "omp-cloud-ide" / "session.json"

STATE_FILES = {
    "omp/agent.db": AGENT_DIR / "agent.db",
    "omp/install-id": HOME / ".omp" / "install-id",
    "github/hosts.yml": HOME / ".config" / "gh" / "hosts.yml",
}

sync_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[lifecycle] {message}", flush=True)


def s3_uri(relative_key: str) -> str:
    return f"s3://{BUCKET}/{PREFIX}/{relative_key}"


def run_aws(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["aws", *args],
        check=False,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=25,
    )


def restore_state() -> None:
    if not BUCKET:
        log("AUTH_STATE_BUCKET is unset; restore skipped")
        return

    with sync_lock:
        restored = 0
        for key, target in STATE_FILES.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
                temp_path = Path(tmp.name)
            try:
                result = run_aws("s3", "cp", s3_uri(key), str(temp_path), "--only-show-errors")
                if result.returncode != 0:
                    continue
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, target)
                restored += 1
            finally:
                temp_path.unlink(missing_ok=True)
        log(f"restored {restored} auth-state file(s)")


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

    session = {"microvmId": str(envelope.get("microvmId", "")), "expiresAt": expires_at}
    try:
        SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", dir=SESSION_FILE.parent, delete=False) as tmp:
            json.dump(session, tmp)
        os.replace(tmp.name, SESSION_FILE)
    except OSError as error:
        log(f"could not record session deadline: {type(error).__name__}")
        return
    log("recorded session deadline")


def sqlite_snapshot(source: Path, destination: Path) -> None:
    source_uri = f"file:{source}?mode=ro"
    with sqlite3.connect(source_uri, uri=True, timeout=5) as source_db:
        with sqlite3.connect(destination) as backup_db:
            source_db.backup(backup_db)


def upload_file(key: str, source: Path) -> bool:
    if not source.is_file():
        return False

    with tempfile.TemporaryDirectory(prefix="omp-auth-") as temp_dir:
        snapshot = Path(temp_dir) / source.name
        if source.name == "agent.db":
            sqlite_snapshot(source, snapshot)
        else:
            shutil.copy2(source, snapshot)
        os.chmod(snapshot, 0o600)
        result = run_aws("s3", "cp", str(snapshot), s3_uri(key), "--only-show-errors")
        if result.returncode != 0:
            raise RuntimeError(f"upload failed for {key}")
    return True


def persist_state() -> None:
    if not BUCKET:
        return

    with sync_lock:
        uploaded = 0
        for key, source in STATE_FILES.items():
            try:
                uploaded += int(upload_file(key, source))
            except (OSError, sqlite3.Error, subprocess.SubprocessError, RuntimeError) as error:
                log(f"state sync error for {key}: {type(error).__name__}")
        if uploaded:
            log(f"persisted {uploaded} auth-state file(s)")


def code_server_ready() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/healthz", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def periodic_sync() -> None:
    while True:
        time.sleep(SYNC_INTERVAL)
        persist_state()


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
            restore_state()
            self.respond(200)
            return

        if self.path == f"{HOOK_PREFIX}/resume":
            self.respond(200)
            return

        if self.path in {f"{HOOK_PREFIX}/suspend", f"{HOOK_PREFIX}/terminate"}:
            persist_state()
            self.respond(200)
            return

        self.respond(404)

    def log_message(self, format: str, *args: object) -> None:
        return

    def respond(self, status: int) -> None:
        self.send_response(status)
        self.send_header("content-length", "0")
        self.end_headers()


if __name__ == "__main__":
    AGENT_DIR.mkdir(parents=True, exist_ok=True)
    for target in STATE_FILES.values():
        target.parent.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) == 2 and sys.argv[1] == "--sync":
        persist_state()
        raise SystemExit(0)
    threading.Thread(target=periodic_sync, daemon=True).start()
    log(f"hook server listening on port 9000; sync interval={SYNC_INTERVAL}s")
    ThreadingHTTPServer(("0.0.0.0", 9000), HookHandler).serve_forever()
