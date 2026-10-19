"""Exclusion list: history archives must not contain pairing secrets or credentials."""

from __future__ import annotations

import base64
import io
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path

import vm_history


def _tar_names(blob: bytes) -> list[str]:
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as archive:
        return archive.getnames()


def _tar_sqlite_tables(blob: bytes, name: str) -> list[str]:
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as archive:
        raw = archive.extractfile(name).read()
    tmp = Path(tempfile.mkdtemp()) / "db"
    tmp.write_bytes(raw)
    con = sqlite3.connect(tmp)
    try:
        return [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    finally:
        con.close()


class ExclusionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "shm"
        self.scratch = self.tmp / "scratch"
        self.root.mkdir()
        (self.root / "t3/userdata/secrets").mkdir(parents=True)
        (self.root / "t3/userdata/secrets/server.bin").write_bytes(b"SECRETBIN-server")
        (self.root / "claude").mkdir()
        (self.root / "claude/credentials.json").write_text('{"refresh_token":"should-not-upload"}')
        (self.root / "codex").mkdir()
        (self.root / "codex/auth.json").write_text('{"access_token":"nope"}')
        (self.root / "gh-token").write_text("github_pat_should_not_upload")
        (self.root / "t3/userdata").mkdir(parents=True, exist_ok=True)
        (self.root / "t3/userdata/environment-id").write_text("env-123")
        db = self.root / "t3/userdata/statev2.sqlite"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE projection_threads (id TEXT, title TEXT)")
        con.execute("INSERT INTO projection_threads VALUES ('t1', 'hello')")
        con.execute(
            "CREATE TABLE auth_sessions (session_id TEXT, credential TEXT, expires_at TEXT)"
        )
        con.execute("INSERT INTO auth_sessions VALUES ('sess', 'PAIRING-SECRET', '2099')")
        con.execute("CREATE TABLE auth_pairing_links (id TEXT, credential TEXT)")
        con.execute("INSERT INTO auth_pairing_links VALUES ('p1', 'ONE-TIME-TOKEN')")
        con.commit()
        con.close()
        (self.root / "t3/userdata/settings.json").write_text('{"theme":"dark"}\n')

    def test_exclusion_list_drops_secrets_and_keeps_threads(self) -> None:
        blob, pairing = vm_history.build_split(self.root, self.scratch)
        names = _tar_names(blob)
        self.assertIn("t3/userdata/statev2.sqlite", names)
        self.assertIn("t3/userdata/settings.json", names)
        self.assertIn("t3/userdata/environment-id", names)
        for banned in (
            "t3/userdata/secrets/server.bin",
            "claude/credentials.json",
            "codex/auth.json",
            "gh-token",
        ):
            self.assertNotIn(banned, names)
        raw = blob
        self.assertNotIn(b"SECRETBIN-server", raw)
        self.assertNotIn(b"PAIRING-SECRET", raw)
        self.assertNotIn(b"ONE-TIME-TOKEN", raw)
        self.assertNotIn(b"github_pat_should_not_upload", raw)
        self.assertNotIn(b"should-not-upload", raw)
        tables = _tar_sqlite_tables(blob, "t3/userdata/statev2.sqlite")
        self.assertIn("projection_threads", tables)
        self.assertNotIn("auth_sessions", tables)
        self.assertNotIn("auth_pairing_links", tables)
        dumped = json_tables(pairing)
        self.assertIn("PAIRING-SECRET", dumped)
        self.assertIn("ONE-TIME-TOKEN", dumped)
        self.assertEqual(pairing["secrets"][0]["path"], "t3/userdata/secrets/server.bin")
        vm_history.check_tar(blob)

    def test_secret_column_outside_auth_tables_aborts(self) -> None:
        db = self.root / "t3/userdata/statev2.sqlite"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE projection_provider (id TEXT, refresh_token TEXT)")
        con.execute("INSERT INTO projection_provider VALUES ('p', 'rt')")
        con.commit()
        con.close()
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_credential_marker_in_a_history_file_aborts(self) -> None:
        (self.root / "t3/userdata/notes.txt").write_text('see "refresh_token" pasted in a transcript')
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_restore_rejects_an_archive_that_smuggles_secrets(self) -> None:
        blob, _pairing = vm_history.build_split(self.root, self.scratch)
        smuggled = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as src, tarfile.open(
            fileobj=smuggled, mode="w"
        ) as dst:
            for member in src.getmembers():
                dst.addfile(member, src.extractfile(member))
            payload = b"SECRETBIN-smuggled"
            info = tarfile.TarInfo("t3/userdata/secrets/extra.bin")
            info.size = len(payload)
            dst.addfile(info, io.BytesIO(payload))
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.restore_history(self.root, smuggled.getvalue())

    def test_apply_pairing_rejects_paths_outside_secrets(self) -> None:
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.apply_pairing(
                self.root,
                {"secrets": [{"path": "t3/userdata/statev2.sqlite", "b64": base64.b64encode(b"x").decode()}]},
            )

    def test_explicit_path_rules(self) -> None:
        for rel in (
            "claude/a",
            "codex/auth.json",
            "gh-token",
            "t3/userdata/secrets/server.bin",
            "t3/userdata/clerk-tokens.json",
            "t3/userdata/hosts.yml",
            "t3/userdata/statev2.sqlite-wal",
            "../etc/passwd",
        ):
            self.assertTrue(vm_history.path_excluded(rel), rel)
        for rel in ("t3/userdata/statev2.sqlite", "t3/userdata/settings.json", "t3/userdata/environment-id"):
            self.assertFalse(vm_history.path_excluded(rel), rel)


class RegressionTest(ExclusionTest):
    def test_cli_root_cannot_be_redirected_to_disk(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {'T3POC_SCAN_ROOT': str(self.tmp / 'disk')}), patch.object(vm_history, '_emit') as emit:
            vm_history.main(['vm_history.py','emit'])
            emit.assert_called_once_with(Path('/dev/shm'))

    def test_host_python314_provides_sqlite_deserialize(self):
        import sys
        self.assertGreaterEqual(sys.version_info[:2], (3, 14))
        self.assertTrue(hasattr(sqlite3.Connection, 'deserialize'))

    def test_root_log_is_not_history(self):
        (self.root / 't3-serve.log').write_text('normal startup')
        blob, _ = vm_history.build_split(self.root, self.scratch)
        self.assertNotIn('t3-serve.log', _tar_names(blob))

    def test_installation_token_in_history_aborts(self):
        (self.root / 't3/userdata/messages.json').write_text('{"body":"ghs_DUMMY_FOR_REVIEW"}')
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_preserves_indexes_triggers_views_and_metadata(self):
        con = sqlite3.connect(self.root / 't3/userdata/statev2.sqlite')
        con.executescript("CREATE UNIQUE INDEX thread_id ON projection_threads(id); CREATE VIEW titles AS SELECT title FROM projection_threads; CREATE TRIGGER thread_title AFTER INSERT ON projection_threads BEGIN UPDATE projection_threads SET title=upper(new.title) WHERE id=new.id; END; PRAGMA user_version=42; PRAGMA application_id=7;")
        con.close()
        blob, _ = vm_history.build_split(self.root, self.scratch)
        target = self.tmp / 'restored'
        vm_history.restore_history(target, blob)
        con = sqlite3.connect(target / 't3/userdata/statev2.sqlite')
        self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0],42)
        self.assertEqual(con.execute('PRAGMA application_id').fetchone()[0],7)
        self.assertEqual(con.execute("SELECT count(*) FROM sqlite_master WHERE name IN ('thread_id','titles','thread_title')").fetchone()[0],3)
        con.close()

    def test_restore_rejects_existing_parent_and_file_symlinks(self):
        blob, bundle = vm_history.build_split(self.root, self.scratch)
        target = self.tmp / 'restore-root'; target.mkdir()
        outside = self.tmp / 'disk'; outside.mkdir()
        (target / 't3').symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            vm_history.restore_history(target, blob)
        with self.assertRaises((OSError, ValueError)):
            vm_history.apply_pairing(target, bundle)
        self.assertEqual(list(outside.iterdir()), [])
        (target / 't3').unlink(); (target / 't3/userdata').mkdir(parents=True)
        sentinel=outside/'sentinel'; sentinel.write_bytes(b'unchanged')
        (target/'t3/userdata/settings.json').symlink_to(sentinel)
        with self.assertRaises((OSError,ValueError)):
            vm_history.restore_history(target,blob)
        self.assertEqual(sentinel.read_bytes(),b'unchanged')

    def test_secure_write_assigns_guest_ownership_on_descriptor(self):
        import os
        from unittest.mock import patch
        import vm_fs
        with patch.object(vm_fs, 'guest_owner', return_value=(os.getuid(),os.getgid())), patch.object(vm_fs.os,'fchown', wraps=os.fchown) as change:
            vm_fs.secure_write(self.root,'t3/userdata/check.bin',b'dummy')
            self.assertGreaterEqual(change.call_count,1)
        self.assertEqual((self.root/'t3/userdata/check.bin').stat().st_mode & 0o777,0o600)


    def test_unrelated_login_symlinks_are_ignored(self):
        (self.root / "claude" / "linked").symlink_to(self.root / "t3/userdata/environment-id")
        vm_history.build_split(self.root, self.scratch)
        vm_history.pairing_only(self.root)


    def test_autoincrement_highwater_survives_history_separation(self):
        src = self.root / "t3/userdata/sequence.sqlite"
        con = sqlite3.connect(src)
        con.execute('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)')
        con.execute("INSERT INTO events VALUES (100, 'removed')")
        con.execute('DELETE FROM events')
        con.commit(); con.close()
        dest = self.tmp / "sequence-copy.sqlite"
        vm_history.sanitize_sqlite(src, dest)
        con = sqlite3.connect(dest)
        con.execute("INSERT INTO events(value) VALUES ('next')")
        self.assertEqual(con.execute('SELECT id FROM events').fetchone()[0], 101)
        con.close()


    def test_t3_history_symlink_is_rejected(self):
        (self.root / "t3/userdata/linked").symlink_to(self.root / "t3/userdata/environment-id")
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)


    def _scheduled_tasks(self, token=None, secret=None):
        con = sqlite3.connect(self.root / 't3/userdata/statev2.sqlite')
        con.execute('CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, prompt TEXT, webhook_token TEXT, webhook_secret TEXT)')
        con.execute('INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?)', ('task', 'synthetic task', token, secret))
        con.commit(); con.close()

    def test_nullable_webhook_schema_preserves_threads_without_secrets(self):
        self._scheduled_tasks()
        blob, pairing = vm_history.build_split(self.root, self.scratch)
        vm_history.check_tar(blob)
        with tarfile.open(fileobj=io.BytesIO(blob)) as archive:
            data = archive.extractfile('t3/userdata/statev2.sqlite').read()
        con = sqlite3.connect(':memory:'); con.deserialize(data)
        self.assertGreater(con.execute('SELECT count(*) FROM projection_threads').fetchone()[0], 0)
        self.assertEqual(con.execute('SELECT webhook_token, webhook_secret FROM scheduled_tasks').fetchone(), (None,None))
        con.close()

    def test_configured_webhook_token_blocks_history_even_without_known_markers(self):
        self._scheduled_tasks(token='dummy-opaque-webhook')
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_configured_webhook_secret_blocks_history_even_without_known_markers(self):
        self._scheduled_tasks(secret='dummy-opaque-signing-key')
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_incoming_archive_with_webhook_secret_is_rejected(self):
        self._scheduled_tasks(secret='dummy-opaque-signing-key')
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w') as archive:
            data = (self.root / 't3/userdata/statev2.sqlite').read_bytes()
            entry = tarfile.TarInfo('t3/userdata/statev2.sqlite'); entry.size = len(data)
            archive.addfile(entry,io.BytesIO(data))
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.check_tar(buffer.getvalue())

    def test_unknown_nullable_secret_column_still_blocks_history(self):
        con = sqlite3.connect(self.root / 't3/userdata/statev2.sqlite')
        con.execute('CREATE TABLE unknown_config (secret TEXT)'); con.commit(); con.close()
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)


    def test_webhook_secret_default_is_not_exported_even_with_no_rows(self):
        con = sqlite3.connect(self.root / 't3/userdata/statev2.sqlite')
        con.execute("CREATE TABLE scheduled_tasks (webhook_token TEXT DEFAULT 'dummy-opaque-default', webhook_secret TEXT)")
        con.commit(); con.close()
        with self.assertRaises(vm_history.HistoryNotSeparable):
            vm_history.build_split(self.root, self.scratch)

    def test_concurrent_webhook_write_cannot_enter_validated_snapshot(self):
        from unittest.mock import patch
        self._scheduled_tasks()
        db = self.root / 't3/userdata/statev2.sqlite'
        con = sqlite3.connect(db); con.execute('PRAGMA journal_mode=WAL'); con.close()
        original = vm_history.assert_secret_columns_empty
        changed = False
        def race(con, table):
            nonlocal changed
            original(con, table)
            if table == 'scheduled_tasks' and not changed:
                writer = sqlite3.connect(db)
                writer.execute("UPDATE scheduled_tasks SET webhook_token='dummy-concurrent-secret'")
                writer.commit(); writer.close(); changed = True
        with patch.object(vm_history, 'assert_secret_columns_empty', side_effect=race):
            vm_history.sanitize_sqlite(db, self.tmp / 'copy.sqlite')
        copy = sqlite3.connect(self.tmp / 'copy.sqlite')
        self.assertEqual(copy.execute('SELECT webhook_token FROM scheduled_tasks').fetchone(), (None,))
        copy.close()
        self.assertTrue(changed)


def json_tables(pairing: dict) -> str:
    return str(pairing["auth_tables"])



if __name__ == "__main__":
    unittest.main()
