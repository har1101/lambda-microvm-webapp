"""Real git regression: disk checkout + RAM are destroyed, then re-cloned."""
import base64
import contextlib
import io
import json
import hashlib
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vm_history as history
import vm_worktrees as wt


class Survival(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t3poc-wt-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.shm = self.root / 'shm'
        self.workspace = self.root / 'workspace'
        self.base = self.workspace / 'repo'
        self.base.mkdir(parents=True)
        self.git(self.base, 'init', '-b', 'main')
        self.git(self.base, 'config', 'user.email', 'fixture@example.invalid')
        self.git(self.base, 'config', 'user.name', 'Fixture')
        (self.base / 'tracked').write_text('original\n')
        (self.base / 'deleted').write_text('keep\n')
        (self.base / '.gitignore').write_text('ignored/\n.env\n')
        self.git(self.base, 'add', '.')
        self.git(self.base, 'commit', '-m', 'initial')
        self.remote = self.root / 'remote.git'
        self.git(self.root, 'clone', '--bare', str(self.base), str(self.remote))
        self.git(self.base, 'remote', 'add', 'origin', str(self.remote))
        self.thread = self.add_worktree('thread', branch='local-no-upstream')

    def git(self, repo, *args, data=None):
        p = subprocess.run(['git', '-C', str(repo), *args], input=data, capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        return p.stdout

    def add_worktree(self, name, branch=None):
        path = self.shm / 't3/worktrees/repo' / name
        args = ['-b', branch] if branch else ['--detach']
        self.git(self.base, 'worktree', 'add', *args, str(path), 'HEAD')
        return path

    def snapshot(self):
        return history.build_split(self.shm, self.root / 'scratch', self.workspace)[0]

    def replace_vm(self, blob):
        shutil.rmtree(self.workspace)
        shutil.rmtree(self.shm)
        self.git(self.root, 'clone', str(self.remote), str(self.base))
        history.restore_history(self.shm, blob)
        wt.restore_pending(self.shm, self.workspace, history.scan_bytes)

    def dirty(self, thread):
        (thread / 'tracked').write_text('staged\n')
        self.git(thread, 'add', 'tracked')
        (thread / 'tracked').write_text('unstaged\n')
        (thread / 'untracked').write_text('new\n')
        (thread / 'executable').write_text('#!/bin/sh\nexit 0\n')
        (thread / 'executable').chmod(0o755)
        (thread / 'deleted').unlink()
        (thread / 'ignored').mkdir()
        (thread / 'ignored/large').write_text('not archived')
        (thread / '.env').write_text('LOCAL_ONLY=synthetic-value')

    def test_broken_sqlite_normalized_across_all_history_paths(self):
        folder = self.shm / 't3/userdata'
        folder.mkdir(parents=True, exist_ok=True)
        bad = b'SQLite format 3\x00' + b'broken' * 30
        (folder/'broken.sqlite').write_bytes(bad)
        for run in (lambda: self.snapshot(), lambda: history.pairing_only(self.shm)):
            with self.assertRaises(history.HistoryNotSeparable): run()
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w') as archive:
            info = tarfile.TarInfo('t3/userdata/broken.sqlite'); info.size = len(bad)
            archive.addfile(info, io.BytesIO(bad))
        with self.assertRaises(history.HistoryNotSeparable): history.check_tar(payload.getvalue())

    def test_full_swap_same_paths_branches_head_index_working_tree(self):
        self.dirty(self.thread)
        # An unpushed commit must survive as the same SHA, not just as files.
        self.git(self.thread, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unpushed staged edit')
        self.git(self.thread, 'add', 'tracked')
        (self.thread / 'tracked').write_text('second unstaged\n')
        detached = self.add_worktree('detached')
        self.dirty(detached)
        expected = {p: [self.git(p, 'status', '--porcelain=v1', '-z'), self.git(p, 'ls-files', '--stage', '-z'), self.git(p, 'rev-parse', 'HEAD')] for p in (self.thread, detached)}
        blob = self.snapshot()
        self.assertNotIn(b'LOCAL_ONLY', blob)
        self.assertNotIn(b'not archived', blob)
        self.replace_vm(blob)
        for p, before in expected.items():
            self.assertEqual([self.git(p, 'status', '--porcelain=v1', '-z'), self.git(p, 'ls-files', '--stage', '-z'), self.git(p, 'rev-parse', 'HEAD')], before)
            self.git(p, 'fsck', '--no-reflogs')
            self.assertTrue((p / 'executable').stat().st_mode & 0o111)
            gitdir = Path(self.git(p, 'rev-parse', '--absolute-git-dir').decode().strip())
            self.assertTrue(gitdir.is_relative_to(self.base / '.git/worktrees'))
            self.assertIn(str(p).encode(), self.git(self.base, 'worktree', 'list', '--porcelain'))
        self.assertEqual(self.git(self.thread, 'symbolic-ref', '--short', 'HEAD').strip(), b'local-no-upstream')
        self.assertEqual(subprocess.run(['git', '-C', str(detached), 'symbolic-ref', '-q', 'HEAD'], capture_output=True).returncode, 1)
        # Repeated readiness does not overwrite user edits.
        (self.thread / 'untracked').write_text('after restore')
        wt.restore_pending(self.shm, self.workspace, history.scan_bytes)
        self.assertEqual((self.thread / 'untracked').read_text(), 'after restore')
        self.git(self.thread, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'works after swap')
        # A second swap works with the newly reconstructed git metadata.
        self.replace_vm(self.snapshot())
        self.assertEqual((self.thread / 'untracked').read_text(), 'after restore')

    def test_deleted_worktrees_are_not_resurrected(self):
        other = self.add_worktree('removed')
        shutil.rmtree(other)  # leave stale .git/worktrees registration
        self.replace_vm(self.snapshot())
        self.assertFalse(other.exists())
        self.assertNotIn(b'removed', self.git(self.base, 'worktree', 'list', '--porcelain'))

    def test_git_config_credentials_hooks_and_reflogs_are_never_archived(self):
        self.git(self.base, 'config', 'credential.helper', 'synthetic-helper-DO-NOT-COPY')
        self.git(self.base, 'remote', 'set-url', 'origin', 'https://synthetic-user:synthetic-pass@example.invalid/repo')
        (self.base / '.git/hooks/custom').write_text('synthetic-hook-DO-NOT-COPY')
        blob = self.snapshot()
        for secret in (b'synthetic-user', b'synthetic-pass', b'synthetic-helper', b'synthetic-hook'):
            self.assertNotIn(secret, blob)

    def test_untracked_git_and_netrc_credentials_are_excluded(self):
        for name in ['.git-credentials','.netrc','.npmrc','id_ed25519']:
            (self.thread/name).write_text('synthetic-private-value-DO-NOT-COPY')
        blob=self.snapshot()
        self.assertNotIn(b'synthetic-private-value',blob)
        self.replace_vm(blob)
        for name in ['.git-credentials','.netrc','.npmrc','id_ed25519']:
            self.assertFalse((self.thread/name).exists())

    def test_thread_branch_matches_fresh_clone_default(self):
        self.git(self.base,'switch','-c','base-only')
        path=self.shm/'t3/worktrees/repo/default-branch'
        self.git(self.base,'worktree','add',str(path),'main')
        (path/'untracked').write_text('default branch edit')
        self.replace_vm(self.snapshot())
        self.assertEqual(self.git(path,'symbolic-ref','--short','HEAD').strip(),b'main')
        self.assertEqual((path/'untracked').read_text(),'default branch edit')
        self.assertEqual(subprocess.run(['git','-C',str(self.base),'symbolic-ref','-q','HEAD'],capture_output=True).returncode,1)

    def test_existing_secret_filename_exclusions_are_preserved(self):
        names=['password.txt','custom-credentials.json','token.txt','secret.notes','fixture.db-journal']
        for name in names:(self.thread/name).write_text('SYNTHETIC-PRIVATE-DO-NOT-COPY')
        self.replace_vm(self.snapshot())
        for name in names:self.assertFalse((self.thread/name).exists())

    def test_tracked_secret_filename_fails_closed(self):
        (self.thread/'password.txt').write_text('synthetic')
        self.git(self.thread,'add','password.txt')
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()

    def test_sqlite_auth_data_cannot_hide_in_files_or_git_objects(self):
        path=self.thread/'fixture.sqlite'
        with contextlib.closing(sqlite3.connect(path)) as con:
            con.execute('CREATE TABLE auth_sessions (credential TEXT)')
            con.execute("INSERT INTO auth_sessions VALUES ('SYNTHETIC-PRIVATE')")
            con.commit()
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()
        self.git(self.thread,'add','fixture.sqlite')
        path.unlink()  # secret only exists in the staged Git blob now
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()
        self.git(self.thread,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture sqlite')
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()

    def test_secret_in_working_file_aborts(self):
        (self.thread / 'ordinary').write_text('"refresh_token": "synthetic"')
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_secret_in_historical_git_object_aborts_even_when_deleted(self):
        (self.thread / 'ordinary').write_text('ghs_synthetic_fixture')
        self.git(self.thread, 'add', '.')
        self.git(self.thread, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unsafe')
        (self.thread / 'ordinary').unlink()
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_secret_only_in_staged_blob_aborts(self):
        (self.thread / 'ordinary').write_text('ghs_synthetic_fixture')
        self.git(self.thread, 'add', '.')
        (self.thread / 'ordinary').write_text('safe worktree')
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_tracked_env_is_fail_closed(self):
        (self.thread / '.env').write_text('synthetic')
        self.git(self.thread, 'add', '-f', '.env')
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_broken_git_pointer_fails_instead_of_silently_omitting(self):
        (self.thread / '.git').write_text('gitdir: /missing/fixture\n')
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_symlink_file_and_parent_fail_closed(self):
        (self.thread / 'link').symlink_to('tracked')
        with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_size_limit_and_ignored_build_tree(self):
        self.dirty(self.thread)
        with patch.object(wt, 'MAX_ITEM_BYTES', 16):
            with self.assertRaises(history.HistoryNotSeparable): self.snapshot()
        with patch.object(wt, 'MAX_STATE_BYTES', 1024):
            with self.assertRaises(history.HistoryNotSeparable): self.snapshot()
        with patch.object(history, 'MAX_HISTORY_BYTES', 1024):
            with self.assertRaises(history.HistoryNotSeparable): self.snapshot()

    def test_archive_validation_decodes_embedded_objects(self):
        state = json.loads(wt.capture(self.shm, self.workspace, history.scan_bytes)[0][1])
        key = next(k for k,v in state['objects'].items() if v[0] == 'blob')
        state['objects'][key][1] = base64.b64encode(b'ghs_synthetic_fixture').decode()
        with self.assertRaises(history.HistoryNotSeparable): wt.validate(json.dumps(state).encode(), history.scan_bytes)
        with self.assertRaises(ValueError): wt.validate(json.dumps(state).encode(), lambda *_: None)

    def test_archive_path_traversal_and_legacy_pointer_rejected(self):
        state = json.loads(wt.capture(self.shm, self.workspace, history.scan_bytes)[0][1])
        state['files']['../outside'] = [0o644, 'eA==']
        with self.assertRaises(ValueError): wt.validate(json.dumps(state).encode(), history.scan_bytes)
        data=io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            entry=tarfile.TarInfo('t3/worktrees/repo/thread/.git');entry.size=4
            archive.addfile(entry,io.BytesIO(b'fake'))
        with self.assertRaises(history.HistoryNotSeparable): history.check_tar(data.getvalue())

    def test_restore_refuses_existing_worktree_and_keeps_manifest(self):
        blob=self.snapshot()
        history.restore_history(self.shm,blob)
        with self.assertRaisesRegex(ValueError,'overwrite'):wt.restore_pending(self.shm,self.workspace,history.scan_bytes)
        self.assertTrue(list((self.shm / wt.PREFIX).glob('*/*.json')))

    def test_crash_after_move_does_not_overwrite_later_edits(self):
        blob=self.snapshot()
        shutil.rmtree(self.workspace);shutil.rmtree(self.shm)
        self.git(self.root,'clone',str(self.remote),str(self.base))
        history.restore_history(self.shm,blob)
        manifest=next((self.shm/wt.PREFIX).glob('*/*.json'))
        original=Path.unlink
        def fail_manifest(path,*args,**kwargs):
            if path==manifest:raise OSError('synthetic crash')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',fail_manifest):
            with self.assertRaises(OSError):wt.restore_pending(self.shm,self.workspace,history.scan_bytes)
        (self.thread/'untracked').write_text('later user edit')
        wt.restore_pending(self.shm,self.workspace,history.scan_bytes)
        self.assertEqual((self.thread/'untracked').read_text(),'later user edit')

    def test_history_root_symlink_is_rejected(self):
        outside=self.root/'outside';outside.mkdir()
        self.git(self.base,'worktree','remove',str(self.thread))
        shutil.rmtree(self.shm/'t3')
        (self.shm/'t3').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()

    def test_decoded_item_limit_is_enforced_by_validate_and_tar(self):
        raw=b'x'*(wt.MAX_ITEM_BYTES+1)
        encoded=base64.b64encode(raw).decode()
        with self.assertRaises(ValueError):wt.decode(encoded)
        state=json.loads(wt.capture(self.shm,self.workspace,history.scan_worktree_bytes)[0][1])
        oid=hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()
        state['objects'][oid]=['blob',encoded]
        payload=json.dumps(state).encode()
        self.assertLess(len(payload),wt.MAX_STATE_BYTES)
        with self.assertRaises(ValueError):wt.validate(payload,history.scan_worktree_bytes)
        data=io.BytesIO()
        with tarfile.open(fileobj=data,mode='w') as archive:
            entry=tarfile.TarInfo(wt.snapshot_path('repo','thread'));entry.size=len(payload)
            archive.addfile(entry,io.BytesIO(payload))
        with self.assertRaises(history.HistoryNotSeparable):history.check_tar(data.getvalue())

    def test_base_git_symlink_is_rejected_on_capture_and_restore(self):
        blob=self.snapshot()
        external=self.root/'external-git'
        (self.base/'.git').rename(external)
        (self.base/'.git').symlink_to(external,target_is_directory=True)
        with self.assertRaisesRegex(history.HistoryNotSeparable,'symlink'):self.snapshot()
        shutil.rmtree(self.shm)
        history.restore_history(self.shm,blob)
        with self.assertRaisesRegex(ValueError,'symlink'):
            wt.restore_pending(self.shm,self.workspace,history.scan_worktree_bytes)

    def test_worktree_git_pointer_symlink_is_rejected(self):
        pointer=self.thread/'.git';external=self.root/'external-pointer'
        pointer.rename(external);pointer.symlink_to(external)
        with self.assertRaisesRegex(history.HistoryNotSeparable,'symlink'):self.snapshot()

    def test_hardlinked_external_config_is_rejected(self):
        external=self.root/'external-config'
        external.write_text('[credential]\n helper = synthetic-helper\n[remote "origin"]\n url = https://synthetic-user:synthetic-pass@example.invalid/repo\n')
        os.link(external,self.thread/'ordinary')
        self.assertEqual((self.thread/'ordinary').stat().st_nlink,2)
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()

    def test_index_skip_and_assume_unchanged_flags_survive(self):
        self.git(self.thread,'update-index','--assume-unchanged','tracked')
        self.git(self.thread,'update-index','--skip-worktree','deleted')
        (self.thread/'tracked').write_text('hidden worktree edit')
        (self.thread/'deleted').unlink()
        before=self.git(self.thread,'ls-files','-v','-z')
        status=self.git(self.thread,'status','--porcelain=v1','-z')
        self.replace_vm(self.snapshot())
        self.assertEqual(self.git(self.thread,'ls-files','-v','-z'),before)
        self.assertEqual(self.git(self.thread,'status','--porcelain=v1','-z'),status)
        self.assertEqual((self.thread/'tracked').read_text(),'hidden worktree edit')
        self.assertFalse((self.thread/'deleted').exists())

    def test_full_history_does_not_gain_a_shallow_boundary_from_new_clone(self):
        self.dirty(self.thread)
        self.git(self.thread,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','local full history')
        self.assertEqual(self.git(self.thread,'rev-parse','--is-shallow-repository').strip(),b'false')
        blob=self.snapshot()
        shutil.rmtree(self.workspace);shutil.rmtree(self.shm)
        self.git(self.root,'clone','--depth','1',self.remote.as_uri(),str(self.base))
        self.assertEqual(self.git(self.base,'rev-parse','--is-shallow-repository').strip(),b'true')
        history.restore_history(self.shm,blob)
        wt.restore_pending(self.shm,self.workspace,history.scan_worktree_bytes)
        self.assertEqual(self.git(self.thread,'rev-parse','--is-shallow-repository').strip(),b'false')
        self.git(self.thread,'fsck','--no-reflogs')

    def test_branch_slug_secret_words_do_not_exclude_safe_snapshots(self):
        other=self.add_worktree('token-refactor',branch='topic-token-refactor')
        (other/'ordinary').write_text('safe fixture')
        self.replace_vm(self.snapshot())
        self.assertEqual((other/'ordinary').read_text(),'safe fixture')
        self.assertEqual(self.git(other,'symbolic-ref','--short','HEAD').strip(),b'topic-token-refactor')

    def test_corrupt_sqlite_worktree_blob_has_a_clean_rejection(self):
        (self.thread/'broken.sqlite').write_bytes(b'SQLite format 3\0'+b'invalid'*20)
        with self.assertRaises(history.HistoryNotSeparable):self.snapshot()

    def test_shallow_clone_and_local_commit(self):
        # file:// makes git honor --depth for a local remote.
        shutil.rmtree(self.workspace); shutil.rmtree(self.shm)
        self.git(self.root,'clone','--depth','1',self.remote.as_uri(),str(self.base))
        self.thread=self.add_worktree('thread',branch='shallow-local')
        self.dirty(self.thread)
        self.git(self.thread,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','local')
        sha=self.git(self.thread,'rev-parse','HEAD')
        self.replace_vm(self.snapshot())
        self.assertEqual(self.git(self.thread,'rev-parse','HEAD'),sha)
        self.git(self.thread,'fsck','--no-reflogs')


if __name__=='__main__':unittest.main()
