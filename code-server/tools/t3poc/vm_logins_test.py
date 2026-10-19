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


if __name__ == "__main__":
    unittest.main()
