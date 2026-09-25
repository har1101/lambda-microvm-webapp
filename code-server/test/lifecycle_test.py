"""Behavior tests for artifact/base-image/lifecycle.py, run by `npm test` via Jest.

A fake `aws` executable on PATH emulates the two S3 calls lifecycle.py makes,
including ETag preconditions, so the tests exercise real subprocess timeouts,
exit codes, error parsing, and conditional writes.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

LIFECYCLE = Path(__file__).resolve().parent.parent / "artifact" / "base-image" / "lifecycle.py"

FAKE_AWS = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import hashlib, json, os, shutil, sys, time
    from pathlib import Path

    args = sys.argv[1:]
    operation = args[1]
    key = args[args.index("--key") + 1]
    with open(os.environ["FAKE_AWS_LOG"], "a") as log:
        log.write(f"{operation} {key}\\n")
    mode = os.environ.get("FAKE_AWS_" + operation.replace("-", "_").upper(), "ok")
    if mode == "hang":
        time.sleep(30)
    if mode == "fail":
        print("An error occurred (AccessDenied) when calling the operation: denied", file=sys.stderr)
        sys.exit(254)
    stored = Path(os.environ["FAKE_S3_DIR"]) / key.replace("/", "__")
    if operation == "get-object" and key == os.environ.get("FAKE_AWS_SLOW_GET_KEY"):
        time.sleep(float(os.environ["FAKE_AWS_SLOW_GET_SECONDS"]))
    if operation == "get-object" and key == os.environ.get("FAKE_AWS_HANG_GET_KEY"):
        time.sleep(30)
    etag = lambda path: '"' + hashlib.md5(path.read_bytes()).hexdigest() + '"'
    if operation == "get-object":
        if not stored.exists():
            print("An error occurred (NoSuchKey) when calling the GetObject operation: none", file=sys.stderr)
            sys.exit(254)
        shutil.copy(stored, args[args.index("--key") + 2])
        print(json.dumps({"ETag": etag(stored), "VersionId": "v-get"}))
    else:
        if_match = args[args.index("--if-match") + 1] if "--if-match" in args else None
        if_none_match = "--if-none-match" in args
        if (if_match and (not stored.exists() or etag(stored) != if_match)) or (if_none_match and stored.exists()):
            print("An error occurred (PreconditionFailed) when calling the PutObject operation: x", file=sys.stderr)
            sys.exit(254)
        shutil.copy(args[args.index("--body") + 1], stored)
        print(json.dumps({"ETag": etag(stored), "VersionId": "v-put"}))
    """
)


class LifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="lifecycle-test-"))
        self.home = self.root / "home"
        self.s3 = self.root / "s3"
        bin_dir = self.root / "bin"
        for directory in (self.home, self.s3, bin_dir):
            directory.mkdir()
        (bin_dir / "aws").write_text(FAKE_AWS)
        (bin_dir / "aws").chmod(0o755)
        self.aws_log = self.root / "aws.log"
        self.aws_log.touch()
        self.saved_env = dict(os.environ)
        os.environ.update(
            HOME=str(self.home),
            PI_CODING_AGENT_DIR=str(self.home / ".omp" / "agent"),
            AUTH_STATE_BUCKET="test-bucket",
            PATH=f"{bin_dir}:{os.environ['PATH']}",
            FAKE_S3_DIR=str(self.s3),
            FAKE_AWS_LOG=str(self.aws_log),
        )
        spec = importlib.util.spec_from_file_location("lifecycle_under_test", LIFECYCLE)
        self.lifecycle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.lifecycle)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved_env)

    def aws_calls(self) -> list[str]:
        return self.aws_log.read_text().splitlines()

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
            (self.s3 / ("personal__" + key.replace("/", "__"))).write_text(f"saved {key}\n")
        os.environ["FAKE_AWS_SLOW_GET_KEY"] = "personal/omp/agent.db"
        os.environ["FAKE_AWS_SLOW_GET_SECONDS"] = "1.8"

        self.lifecycle.restore_state(self.lifecycle.Deadline(2.5))

        self.assertEqual(self.status()["restoreFailed"], [])
        for key, target in self.lifecycle.STATE_FILES.items():
            self.assertEqual(target.read_text(), f"saved {key}\n")

    def test_timed_out_download_only_blocks_its_own_auth_file(self) -> None:
        for key in ("omp/agent.db", "omp/install-id", "github/hosts.yml"):
            (self.s3 / ("personal__" + key.replace("/", "__"))).write_text(f"saved {key}\n")
        os.environ["FAKE_AWS_HANG_GET_KEY"] = "personal/omp/agent.db"
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
        (self.s3 / "personal__github__hosts.yml").write_text("good: token\n")
        os.environ["FAKE_AWS_GET_OBJECT"] = "fail"
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        self.assertIn("github/hosts.yml", self.status()["restoreFailed"])

        # An unauthenticated local file must not overwrite the good S3 copy.
        self.write_hosts("fresh: unauthenticated\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "blocked-after-restore-failure")
        self.assertEqual((self.s3 / "personal__github__hosts.yml").read_text(), "good: token\n")
        self.assertEqual(self.status()["failed"], ["github/hosts.yml"])

        # After logging in again, the explicit command saves and lifts the block.
        self.write_hosts("new: token\n")
        self.assertEqual(self.lifecycle.manual_sync(), 0)
        self.assertEqual((self.s3 / "personal__github__hosts.yml").read_text(), "new: token\n")
        # Keys that are still absent locally stay blocked: S3 may hold their only good copy.
        self.assertEqual(self.status()["restoreFailed"], ["omp/agent.db", "omp/install-id"])
        self.assertEqual(self.status()["failed"], [])

    def test_stale_vm_does_not_overwrite_newer_state_from_another_vm(self) -> None:
        s3_hosts = self.s3 / "personal__github__hosts.yml"
        s3_hosts.write_text("token: v1\n")
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))
        # Another MicroVM refreshes the credential after this VM restored it.
        s3_hosts.write_text("token: v2-from-other-vm\n")

        self.write_hosts("token: v1-changed-here\n")
        results = self.lifecycle.persist_state("suspend", self.lifecycle.Deadline(10), wait_for_lock=True)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual(s3_hosts.read_text(), "token: v2-from-other-vm\n")
        self.assertEqual(self.status()["conflicts"], ["github/hosts.yml"])

        # Automatic syncs keep reporting the conflict without retrying the write.
        calls = len(self.aws_calls())
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual(len(self.aws_calls()), calls)

        # A plain manual save is still conditional; only --overwrite replaces S3.
        self.assertEqual(self.lifecycle.manual_sync(), 1)
        self.assertEqual(s3_hosts.read_text(), "token: v2-from-other-vm\n")
        self.assertEqual(self.lifecycle.manual_sync(overwrite=True), 0)
        self.assertEqual(s3_hosts.read_text(), "token: v1-changed-here\n")
        self.assertEqual(self.status()["conflicts"], [])
        # After overwriting, this VM owns the latest ETag again and saves normally.
        self.write_hosts("token: v3\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "uploaded")

    def test_first_save_does_not_replace_an_object_created_by_another_vm(self) -> None:
        self.lifecycle.restore_state(self.lifecycle.Deadline(25))  # nothing in S3 yet
        (self.s3 / "personal__github__hosts.yml").write_text("token: other-vm\n")
        self.write_hosts("token: here\n")
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "conflict")
        self.assertEqual((self.s3 / "personal__github__hosts.yml").read_text(), "token: other-vm\n")

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

        os.environ["FAKE_AWS_PUT_OBJECT"] = "fail"
        self.write_hosts("token: b\n")
        self.assertEqual(self.lifecycle.manual_sync(), 1)
        status = self.status()
        self.assertEqual(status["failed"], ["github/hosts.yml"])
        self.assertEqual(status["lastSuccessAt"], last_success)
        # The next attempt must retry rather than treat the failed content as saved.
        del os.environ["FAKE_AWS_PUT_OBJECT"]
        results = self.lifecycle.persist_state("periodic", self.lifecycle.Deadline(10), wait_for_lock=False)
        self.assertEqual(results["github/hosts.yml"], "uploaded")

    def test_hook_budget_bounds_a_hanging_upload(self) -> None:
        self.write_hosts("token: a\n")
        os.environ["FAKE_AWS_PUT_OBJECT"] = "hang"
        started = time.monotonic()
        results = self.lifecycle.persist_state("terminate", self.lifecycle.Deadline(3), wait_for_lock=True)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(results["github/hosts.yml"], "Timeout")
        self.assertEqual(self.status()["failed"], ["github/hosts.yml"])

    def test_waiting_hook_preempts_periodic_upload(self) -> None:
        self.write_hosts("token: a\n")
        os.environ["FAKE_AWS_PUT_OBJECT"] = "hang"
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
