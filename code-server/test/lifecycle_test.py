"""Behavior tests for artifact/base-image/lifecycle.py, run by `npm test` via Jest.

A local HTTP server emulates IMDSv2 and the two S3 calls lifecycle.py makes,
including ETag preconditions and XML error codes, so the tests exercise real
sockets, timeouts, retries, error parsing, and conditional writes.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LIFECYCLE = Path(__file__).resolve().parent.parent / "artifact" / "base-image" / "lifecycle.py"
IMDS_TOKEN = "imds-token"


class FakeAws:
    """In-memory S3 bucket plus IMDSv2 credentials with injectable faults."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.calls: list[str] = []
        self.token_requests = 0
        self.get_mode = "ok"  # ok | fail
        self.put_mode = "ok"  # ok | fail | hang | busy-once
        self.slow_get: dict[str, float] = {}
        self.hang_get_key: str | None = None
        self.release = threading.Event()

    def store(self, key: str, text: str) -> None:
        self.objects[f"personal/{key}"] = text.encode()

    def read(self, key: str) -> str:
        return self.objects[f"personal/{key}"].decode()


def fake_handler(aws: FakeAws) -> type[BaseHTTPRequestHandler]:
    etag = lambda data: '"' + hashlib.md5(data).hexdigest() + '"'  # noqa: E731

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            return

        def reply(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def error(self, status: int, code: str) -> None:
            self.reply(status, f"<Error><Code>{code}</Code></Error>".encode())

        def do_PUT(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/latest/api/token":
                aws.token_requests += 1
                self.reply(200, IMDS_TOKEN.encode())
                return
            key = self.path.lstrip("/")
            aws.calls.append(f"put-object {key}")
            if not self.headers.get("Authorization", "").startswith("AWS4-HMAC-SHA256 Credential=AKIDTEST/"):
                self.error(403, "AccessDenied")
                return
            if aws.put_mode == "hang":
                aws.release.wait(30)
            if aws.put_mode == "fail":
                self.error(403, "AccessDenied")
                return
            if aws.put_mode == "busy-once":
                aws.put_mode = "ok"
                self.error(503, "SlowDown")
                return
            stored = aws.objects.get(key)
            if_match = self.headers.get("If-Match")
            if (if_match and (stored is None or etag(stored) != if_match)) or (
                self.headers.get("If-None-Match") == "*" and stored is not None
            ):
                self.error(412, "PreconditionFailed")
                return
            aws.objects[key] = body
            self.reply(200, headers={"ETag": etag(body), "x-amz-version-id": "v-put"})

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/latest/meta-data/"):
                if self.headers.get("X-aws-ec2-metadata-token") != IMDS_TOKEN:
                    self.reply(401)
                elif self.path.endswith("/security-credentials/"):
                    self.reply(200, b"execution_role")
                else:
                    expires = time.gmtime(time.time() + 3600)
                    document = {
                        "AccessKeyId": "AKIDTEST",
                        "SecretAccessKey": "secret",
                        "Token": "session",
                        "Expiration": time.strftime("%Y-%m-%dT%H:%M:%SZ", expires),
                    }
                    self.reply(200, json.dumps(document).encode())
                return
            key = self.path.lstrip("/")
            aws.calls.append(f"get-object {key}")
            if key in aws.slow_get:
                time.sleep(aws.slow_get[key])
            if key == aws.hang_get_key:
                aws.release.wait(30)
            if aws.get_mode == "fail":
                self.error(403, "AccessDenied")
            elif key not in aws.objects:
                self.error(404, "NoSuchKey")
            else:
                self.reply(200, aws.objects[key], {"ETag": etag(aws.objects[key]), "x-amz-version-id": "v-get"})

    return Handler


class FakeAwsServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # Timeout/preemption tests cut sockets mid-reply on purpose.
        if not isinstance(sys.exc_info()[1], ConnectionError):
            super().handle_error(request, client_address)


class LifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="lifecycle-test-"))
        self.home = self.root / "home"
        self.home.mkdir()
        self.aws = FakeAws()
        self.server = FakeAwsServer(("127.0.0.1", 0), fake_handler(self.aws))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.saved_env = dict(os.environ)
        os.environ.update(
            HOME=str(self.home),
            PI_CODING_AGENT_DIR=str(self.home / ".omp" / "agent"),
            AUTH_STATE_BUCKET="test-bucket",
            AWS_REGION="ap-northeast-1",
        )
        spec = importlib.util.spec_from_file_location("lifecycle_under_test", LIFECYCLE)
        self.lifecycle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lifecycle)
        self.lifecycle.S3_ENDPOINT = endpoint
        self.lifecycle.IMDS_ENDPOINT = endpoint

    def tearDown(self) -> None:
        self.aws.release.set()
        self.server.shutdown()
        self.server.server_close()
        os.environ.clear()
        os.environ.update(self.saved_env)

    def aws_calls(self) -> list[str]:
        return list(self.aws.calls)

    def status(self) -> dict:
        return json.loads(self.lifecycle.STATUS_FILE.read_text())

    def write_hosts(self, text: str) -> Path:
        hosts = self.home / ".config" / "gh" / "hosts.yml"
        hosts.parent.mkdir(parents=True, exist_ok=True)
        hosts.write_text(text)
        return hosts

    def test_missing_objects_on_first_run_are_not_failures(self) -> None:
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        status = self.status()
        self.assertEqual(status["restoreFailed"], [])
        self.assertIsInstance(status["lastSuccessAt"], int)

    def test_slow_first_download_does_not_starve_other_auth_files(self) -> None:
        for key in ("omp/agent.db", "omp/install-id", "github/hosts.yml"):
            self.aws.store(key, f"saved {key}\n")
        self.aws.slow_get["personal/omp/agent.db"] = 1.8

        self.lifecycle.restore_state(self.lifecycle.Deadline(2.5))

        self.assertEqual(self.status()["restoreFailed"], [])
        for key, target in self.lifecycle.STATE_FILES.items():
            self.assertEqual(target.read_text(), f"saved {key}\n")

    def test_timed_out_download_only_blocks_its_own_auth_file(self) -> None:
        for key in ("omp/agent.db", "omp/install-id", "github/hosts.yml"):
            self.aws.store(key, f"saved {key}\n")
        self.aws.hang_get_key = "personal/omp/agent.db"
        started = time.monotonic()

        self.lifecycle.restore_state(self.lifecycle.Deadline(2.5))

        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(self.status()["restoreFailed"], ["omp/agent.db"])
        self.assertIsNone(self.status()["lastSuccessAt"])
        self.assertFalse(self.lifecycle.STATE_FILES["omp/agent.db"].exists())
        for key in ("omp/install-id", "github/hosts.yml"):
            self.assertEqual(self.lifecycle.STATE_FILES[key].read_text(), f"saved {key}\n")

    def test_failed_restore_blocks_automatic_uploads_until_manual_save(self) -> None:
        # Stored state exists in S3 but cannot be read (e.g. KMS/S3 outage).
        self.aws.store("github/hosts.yml", "good: token\n")
        self.aws.get_mode = "fail"
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        self.assertIn("github/hosts.yml", self.status()["restoreFailed"])

        # An unauthenticated local file must not overwrite the good S3 copy.
        self.write_hosts("fresh: unauthenticated\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "blocked-after-restore-failure")
        self.assertEqual(self.aws.read("github/hosts.yml"), "good: token\n")
        self.assertEqual(self.status()["failed"], ["github/hosts.yml"])

        # After logging in again, the explicit command saves and lifts the block.
        self.write_hosts("new: token\n")
        self.assertEqual(self.lifecycle.manual_sync(), 0)
        self.assertEqual(self.aws.read("github/hosts.yml"), "new: token\n")
        # Keys that are still absent locally stay blocked: S3 may hold their only good copy.
        self.assertEqual(self.status()["restoreFailed"], ["omp/agent.db", "omp/install-id"])
        self.assertEqual(self.status()["failed"], [])

    def test_stale_vm_does_not_overwrite_newer_state_from_another_vm(self) -> None:
        self.aws.store("github/hosts.yml", "token: v1\n")
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        # Another MicroVM refreshes the credential after this VM restored it.
        self.aws.store("github/hosts.yml", "token: v2-from-other-vm\n")

        self.write_hosts("token: v1-changed-here\n")
        results = self.lifecycle.persist_state("suspend", self.lifecycle.Deadline(10), wait_for_lock=True)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual(self.aws.read("github/hosts.yml"), "token: v2-from-other-vm\n")
        self.assertEqual(self.status()["conflicts"], ["github/hosts.yml"])

        # Automatic syncs keep reporting the conflict without retrying the write.
        calls = len(self.aws_calls())
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual(len(self.aws_calls()), calls)

        # A plain manual save is still conditional; only --overwrite replaces S3.
        self.assertEqual(self.lifecycle.manual_sync(), 1)
        self.assertEqual(self.aws.read("github/hosts.yml"), "token: v2-from-other-vm\n")
        self.assertEqual(self.lifecycle.manual_sync(overwrite=True), 0)
        self.assertEqual(self.aws.read("github/hosts.yml"), "token: v1-changed-here\n")
        self.assertEqual(self.status()["conflicts"], [])
        # After overwriting, this VM owns the latest ETag again and saves normally.
        self.write_hosts("token: v3\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "uploaded")

    def test_first_save_does_not_replace_an_object_created_by_another_vm(self) -> None:
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))  # nothing in S3 yet
        self.aws.store("github/hosts.yml", "token: other-vm\n")
        self.write_hosts("token: here\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual(self.aws.read("github/hosts.yml"), "token: other-vm\n")

    def test_unchanged_files_are_not_reuploaded(self) -> None:
        agent_db = self.home / ".omp" / "agent" / "agent.db"
        agent_db.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(agent_db) as db:
            db.execute("create table auth (token text)")
            db.execute("insert into auth values ('a')")
        self.write_hosts("token: a\n")

        first = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(set(first.values()) - {"absent"}, {"uploaded"})
        uploads = len(self.aws_calls())

        second = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(set(second.values()) - {"absent"}, {"unchanged"})
        self.assertEqual(len(self.aws_calls()), uploads)

        with sqlite3.connect(agent_db) as db:
            db.execute("update auth set token = 'b'")
        third = self.lifecycle.persist_state("suspend", self.lifecycle.Deadline(10), wait_for_lock=True)
        self.assertEqual(third["omp/agent.db"], "uploaded")
        self.assertEqual(third["github/hosts.yml"], "unchanged")

    def test_failed_upload_is_reported_and_keeps_last_success(self) -> None:
        self.write_hosts("token: a\n")
        self.assertEqual(self.lifecycle.manual_sync(), 0)
        last_success = self.status()["lastSuccessAt"]

        self.aws.put_mode = "fail"
        self.write_hosts("token: b\n")
        self.assertEqual(self.lifecycle.manual_sync(), 1)
        status = self.status()
        self.assertEqual(status["failed"], ["github/hosts.yml"])
        self.assertEqual(status["lastSuccessAt"], last_success)
        # The next attempt must retry rather than treat the failed content as saved.
        self.aws.put_mode = "ok"
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "uploaded")

    def test_transient_s3_error_is_retried_within_the_same_sync(self) -> None:
        self.write_hosts("token: a\n")
        self.aws.put_mode = "busy-once"
        results = self.lifecycle.persist_state("suspend", self.lifecycle.Deadline(10), wait_for_lock=True)
        self.assertEqual(results["github/hosts.yml"], "uploaded")
        self.assertEqual(self.aws.read("github/hosts.yml"), "token: a\n")

    def test_role_credentials_are_reused_until_close_to_expiry(self) -> None:
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        self.assertEqual(self.aws.token_requests, 1)

        # Credentials inside the refresh margin must not be used for another call.
        self.lifecycle._credentials["expires"] = time.time() + 60
        self.write_hosts("token: a\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "uploaded")
        self.assertEqual(self.aws.token_requests, 2)

    def test_hook_budget_bounds_a_hanging_upload(self) -> None:
        self.write_hosts("token: a\n")
        self.aws.put_mode = "hang"
        started = time.monotonic()
        results = self.lifecycle.persist_state("terminate", self.lifecycle.Deadline(3), wait_for_lock=True)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(results["github/hosts.yml"], "Timeout")
        self.assertEqual(self.status()["failed"], ["github/hosts.yml"])

    def test_waiting_hook_preempts_periodic_upload(self) -> None:
        self.write_hosts("token: a\n")
        self.aws.put_mode = "hang"
        abort = self.lifecycle.threading.Event()
        abort.set()
        started = time.monotonic()
        results = self.lifecycle.persist_state(
            "periodic", self.lifecycle.Deadline(20), wait_for_lock=False, abort=abort
        )
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(results["github/hosts.yml"], "Preempted")

    def test_run_hook_records_deadline_from_lambda_envelope_only(self) -> None:
        session_file = self.lifecycle.SESSION_FILE
        # A bare payload (not wrapped by Lambda) must not be mistaken for a deadline.
        self.lifecycle.record_session(json.dumps({"expiresAt": 1_800_028_800_000}).encode())
        self.lifecycle.record_session(b"not json")
        self.assertFalse(session_file.exists())

        payload = json.dumps({"sessionId": "7d041485-dff5-4033-bdbc-a921757e217b", "expiresAt": 1_800_028_800_000})
        self.lifecycle.record_session(json.dumps({"microvmId": "mvm-test", "runHookPayload": payload}).encode())
        # The session ID is a bearer cookie value, so it stays out of the VM file.
        self.assertEqual(
            json.loads(session_file.read_text()), {"microvmId": "mvm-test", "expiresAt": 1_800_028_800_000}
        )


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], "-v"])
