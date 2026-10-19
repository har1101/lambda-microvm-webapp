import io
import tarfile
import tempfile
import unittest
from pathlib import Path

import vm_logins


def tar_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, payload in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


class LoginTarTest(unittest.TestCase):
    def test_extracts_only_inside_the_allowed_dir(self) -> None:
        dest = Path(tempfile.mkdtemp()) / "claude"
        vm_logins.extract_login(dest, tar_bytes({"config.json": b'{"ok":true}'}), {dest})
        self.assertEqual((dest / "config.json").read_bytes(), b'{"ok":true}')
        self.assertEqual((dest / "config.json").stat().st_mode & 0o777, 0o600)

    def test_rejects_parent_traversal(self) -> None:
        dest = Path(tempfile.mkdtemp()) / "claude"
        with self.assertRaises(vm_logins.LoginRejected):
            vm_logins.extract_login(dest, tar_bytes({"../gh-token": b"secret"}), {dest})

    def test_rejects_dest_outside_dev_shm(self) -> None:
        dest = Path(tempfile.mkdtemp()) / "claude"
        with self.assertRaises(vm_logins.LoginRejected):
            vm_logins.extract_login(dest, tar_bytes({"a": b"b"}))

    def test_production_destinations(self) -> None:
        self.assertEqual(
            {path.as_posix() for path in vm_logins.ALLOWED},
            {"/dev/shm/claude", "/dev/shm/codex"},
        )


class LoginRegressionTest(unittest.TestCase):
    def test_root_symlink_never_writes_to_disk(self):
        tmp=Path(tempfile.mkdtemp()); outside=tmp/'disk'; outside.mkdir()
        dest=tmp/'claude'; dest.symlink_to(outside,target_is_directory=True)
        with self.assertRaises((OSError,ValueError)):
            vm_logins.extract_login(dest,tar_bytes({'auth.json':b'dummy'}),{dest})
        self.assertEqual(list(outside.iterdir()),[])

    def test_nested_symlink_never_writes_to_disk(self):
        tmp=Path(tempfile.mkdtemp());outside=tmp/'disk';outside.mkdir();dest=tmp/'claude';dest.mkdir()
        (dest/'nested').symlink_to(outside,target_is_directory=True)
        with self.assertRaises((OSError,ValueError)):
            vm_logins.extract_login(dest,tar_bytes({'nested/auth.json':b'dummy'}),{dest})
        self.assertEqual(list(outside.iterdir()),[])

    def test_explicit_chown_makes_files_readable_by_guest(self):
        import os
        from unittest.mock import patch
        import vm_fs
        dest=Path(tempfile.mkdtemp())/'claude'
        with patch.object(vm_fs,'guest_owner',return_value=(os.getuid(),os.getgid())), patch.object(vm_fs.os,'fchown',wraps=os.fchown) as chown:
            vm_logins.extract_login(dest,tar_bytes({'auth.json':b'dummy'}),{dest})
            self.assertGreaterEqual(chown.call_count,2)
        self.assertEqual((dest/'auth.json').read_bytes(),b'dummy')
        self.assertEqual((dest/'auth.json').stat().st_mode & 0o777,0o600)


if __name__ == "__main__":
    unittest.main()
