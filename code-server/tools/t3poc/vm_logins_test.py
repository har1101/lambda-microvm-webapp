import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import vm_logins as login
import vm_fs


def fixture(kind):
    if kind == 'codex':
        return {'auth.json': login.json_bytes({'tokens': {'access_token':'synthetic-access', 'refresh_token':'synthetic-refresh', 'id_token':'synthetic-id'}, 'last_refresh':'test'})}
    return {'.credentials.json': login.json_bytes({'claudeAiOauth': {'accessToken':'synthetic-access', 'refreshToken':'synthetic-refresh'}, 'unrelated':'omit'}), '.claude.json': login.json_bytes({'hasCompletedOnboarding':True, 'oauthAccount':{'accountUuid':'synthetic-account', 'organizationUuid':'synthetic-org', 'unrelated':'omit'}, 'mcpServers':{'omit':'private'}, 'projects':{'omit':'private'}})}


class LoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_roundtrip_minimal_stable_and_modes(self):
        for kind in login.ROOTS:
            root = self.root / kind
            root.mkdir(mode=0o755)
            blob = login.pack(login.minimal_files(kind, fixture(kind)))
            with patch.object(vm_fs, 'guest_owner', return_value=(os.getuid(),os.getgid())), patch.object(vm_fs.os, 'fchown', wraps=os.fchown) as chown:
                login.extract_login(root, blob, {root}, kind)
                self.assertGreaterEqual(chown.call_count, 2)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            for file in root.iterdir():
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(file.stat().st_uid, os.getuid())
            self.assertEqual(login.snapshot(kind, root), blob)
            self.assertNotIn(b'omit', blob)

    def test_reject_empty_logged_out_invalid_and_extra(self):
        for kind in login.ROOTS:
            for files in ({}, {'auth.json':b'{}'}, {'auth.json':b'invalid'}, {**fixture(kind), 'settings.json':b'{}'}):
                with self.assertRaises(Exception): login.validate_login(login.pack(files),kind)
        files=fixture('claude');files['.claude.json']=b'{"hasCompletedOnboarding":false}'
        with self.assertRaises(login.LoginRejected): login.minimal_files('claude',files)

    def test_tar_slip_links_duplicates_and_oversize(self):
        for name, type_ in [('../auth.json',tarfile.REGTYPE),('/auth.json',tarfile.REGTYPE),('auth.json',tarfile.SYMTYPE),('auth.json',tarfile.LNKTYPE)]:
            buf=io.BytesIO()
            with tarfile.open(fileobj=buf,mode='w') as archive:
                member=tarfile.TarInfo(name);member.type=type_;archive.addfile(member)
            with self.assertRaises(login.LoginRejected):login.validate_login(buf.getvalue(),'codex')
        with self.assertRaises(login.LoginRejected):login.validate_login(b'x'*(login.MAX_BYTES+1),'codex')

    def test_snapshot_rejects_links_and_nonregular(self):
        outside=self.root/'outside';outside.write_bytes(fixture('codex')['auth.json'])
        root=self.root/'codex';root.mkdir();(root/'auth.json').symlink_to(outside)
        with self.assertRaises(OSError):login.snapshot('codex',root)
        (root/'auth.json').unlink();os.mkfifo(root/'auth.json')
        with self.assertRaises(login.LoginRejected):login.snapshot('codex',root)

    def test_extract_rejects_destination_links_and_keeps_old_on_invalid(self):
        root=self.root/'codex';root.mkdir();old=root/'auth.json';old.write_bytes(b'old')
        with self.assertRaises(login.LoginRejected):login.extract_login(root,login.pack({}),{root},'codex')
        self.assertEqual(old.read_bytes(),b'old')
        old.unlink();outside=self.root/'outside';outside.write_bytes(b'old');old.symlink_to(outside)
        with self.assertRaises(ValueError):login.extract_login(root,login.pack(fixture('codex')),{root},'codex')
        self.assertEqual(outside.read_bytes(),b'old')
        with self.assertRaises(login.LoginRejected):login.extract_login(root,login.pack(fixture('codex')))

    def test_root_symlink(self):
        root=self.root/'codex';outside=self.root/'outside';outside.mkdir();root.symlink_to(outside)
        with self.assertRaises(OSError):login.extract_login(root,login.pack(fixture('codex')),{root},'codex')
        self.assertEqual(list(outside.iterdir()),[])

    def test_guest_probe_capture_hash_and_rotation_race(self):
        import contextlib
        import hashlib
        root=self.root/'codex';root.mkdir()
        (root/'auth.json').write_bytes(fixture('codex')['auth.json'])
        expected=hashlib.sha256(login.snapshot('codex',root)).hexdigest()
        request=self.root/'request';request.write_text(expected)
        with patch.dict(login.ROOTS, {'codex':root}):
            out=io.StringIO()
            with contextlib.redirect_stdout(out): self.assertEqual(login.main(['test','probe-codex']),0)
            self.assertEqual(out.getvalue(),'T3POC_LOGIN_HASH '+expected+'\n')
            out=io.StringIO()
            with contextlib.redirect_stdout(out): self.assertEqual(login.main(['test','capture-codex',str(request)]),0)
            self.assertTrue(out.getvalue().startswith('T3POC_LOGIN_BUNDLE '))
            (root/'auth.json').write_bytes(fixture('codex')['auth.json'].replace(b'synthetic-access',b'synthetic-rotate'))
            out=io.StringIO()
            with contextlib.redirect_stdout(out): self.assertEqual(login.main(['test','capture-codex',str(request)]),2)
            self.assertEqual(out.getvalue(),'T3POC_LOGIN_REJECTED\n')
            (root/'auth.json').unlink()
            out=io.StringIO()
            with contextlib.redirect_stdout(out): self.assertEqual(login.main(['test','probe-codex']),0)
            self.assertEqual(out.getvalue(),'T3POC_LOGIN_EMPTY\n')

    def test_owner_maps_only_ram_roots_to_vscode(self):
        from types import SimpleNamespace
        with patch.object(vm_fs.pwd,'getpwnam', return_value=SimpleNamespace(pw_uid=1000,pw_gid=1000)) as lookup:
            self.assertEqual(vm_fs.guest_owner(Path('/dev/shm/codex')),(1000,1000))
            self.assertEqual(vm_fs.guest_owner(Path('/dev/shm/claude')),(1000,1000))
            self.assertIsNone(vm_fs.guest_owner(self.root))
            lookup.assert_called_with('vscode')

    def test_cli_sanitizes_secret_errors(self):
        import subprocess
        result=subprocess.run(['python3.14',login.__file__,'validate','codex'],input=b'synthetic-secret',capture_output=True)
        self.assertEqual(result.returncode,2)
        self.assertEqual(result.stdout,b'T3POC_LOGIN_REJECTED\n')
        self.assertEqual(result.stderr,b'')

if __name__=='__main__':unittest.main()
