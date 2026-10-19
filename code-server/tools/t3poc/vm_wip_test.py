import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / 'artifact/t3poc-image/autopush.py'
spec = importlib.util.spec_from_file_location('t3wip', SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class WipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.remote = self.root / 'remote.git'
        self.repo = self.root / 'repo'
        self.git(self.root, 'init', '--bare', str(self.remote))
        self.git(self.root, 'clone', str(self.remote), str(self.repo))
        self.git(self.repo, 'config', 'user.email', 'probe@example.invalid')
        self.git(self.repo, 'config', 'user.name', 'Synthetic probe')
        (self.repo / 'tracked').write_text('base')
        self.git(self.repo, 'add', '.')
        self.git(self.repo, 'commit', '-m', 'base')
        self.git(self.repo, 'push', 'origin', 'HEAD:refs/heads/main')
        self.head = self.git(self.repo, 'rev-parse', 'HEAD')
    def tearDown(self): self.tmp.cleanup()
    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-C', str(cwd), *args], stderr=subprocess.PIPE, text=True).strip()
    def tip(self): return self.git(self.remote, 'rev-parse', 'refs/heads/wip/probe')
    def test_repeat_dirty_push_is_fast_forward_and_keeps_index_head_worktree(self):
        (self.repo / 'tracked').write_text('staged')
        self.git(self.repo, 'add', 'tracked')
        (self.repo / 'tracked').write_text('unstaged')
        (self.repo / 'new').write_text('first')
        index = (self.repo / '.git/index').read_bytes()
        status = self.git(self.repo, 'status', '--porcelain')
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'wip/probe')
        first = self.tip()
        (self.repo / 'new').write_text('second')
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'wip/probe')
        second = self.tip()
        self.git(self.remote, 'merge-base', '--is-ancestor', first, second)
        self.assertEqual(self.git(self.remote, 'show', second + ':new'), 'second')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual((self.repo / '.git/index').read_bytes(), index)
        self.assertEqual(self.git(self.repo, 'status', '--porcelain'), status)
        self.assertEqual(self.git(self.remote, 'rev-parse', 'refs/heads/main'), self.head)
    def test_same_dirty_tree_can_be_pushed_twice(self):
        (self.repo / 'new').write_text('unchanged dirty')
        mod.wip_push(self.repo, 'probe'); first = self.tip()
        mod.wip_push(self.repo, 'probe'); second = self.tip()
        self.git(self.remote, 'merge-base', '--is-ancestor', first, second)
    def test_rejected_push_raises_and_retains_previous_remote(self):
        (self.repo / 'new').write_text('first'); mod.wip_push(self.repo, 'probe'); first = self.tip()
        hook = self.remote / 'hooks/pre-receive'
        hook.write_text('#!/bin/sh\nexit 1\n'); hook.chmod(0o700)
        (self.repo / 'new').write_text('second')
        with self.assertRaises(RuntimeError): mod.wip_push(self.repo, 'probe')
        self.assertEqual(self.tip(), first)
        self.assertEqual((self.repo / 'new').read_text(), 'second')
    def test_concurrent_local_writers_chain(self):
        from concurrent.futures import ThreadPoolExecutor
        (self.repo / 'new').write_text('dirty')
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(list(pool.map(lambda _:mod.wip_push(self.repo,'probe'), range(2))), ['wip/probe']*2)
    def test_clean_local_commit_is_saved_before_stop(self):
        (self.repo / 'new').write_text('first'); mod.wip_push(self.repo, 'probe')
        self.git(self.repo, 'add', '.'); self.git(self.repo, 'commit', '-m', 'local only')
        local = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'wip/probe')
        self.git(self.remote, 'merge-base', '--is-ancestor', local, self.tip())
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'clean')
        self.assertEqual(self.git(self.repo, 'rev-parse', '--is-shallow-repository'), 'false')
    def test_clean_initial_head_and_unborn_repo_are_saved(self):
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'wip/probe')
        unborn = self.root / 'unborn'; unborn.mkdir()
        self.git(unborn, 'init'); self.git(unborn, 'config', 'user.email', 'probe@example.invalid')
        self.git(unborn, 'config', 'user.name', 'Synthetic probe')
        self.git(unborn, 'remote', 'add', 'origin', str(self.remote))
        (unborn / 'new').write_text('unborn')
        self.assertEqual(mod.wip_push(unborn, 'unborn'), 'wip/unborn')
        self.assertEqual(self.git(self.remote, 'show', 'refs/heads/wip/unborn:new'), 'unborn')
    def test_discarded_dirty_tree_updates_remote_snapshot(self):
        (self.repo / 'tracked').write_text('dirty'); mod.wip_push(self.repo, 'probe')
        (self.repo / 'tracked').write_text('base')
        self.assertEqual(mod.wip_push(self.repo, 'probe'), 'wip/probe')
        self.assertEqual(self.git(self.remote, 'show', self.tip()+':tracked'), 'base')
    def test_malformed_metadata_refuses_wip_without_crashing_loop(self):
        import json
        from unittest.mock import patch
        metadata = self.root / 'session.json'
        for value in [{'microvmId': None}, [], None, {'microvmId': '../bad'}, {'expiresAt': []}]:
            metadata.write_text(json.dumps(value))
            with patch.object(mod, 'SESSION_FILE', metadata), patch.object(mod, 'token', return_value='synthetic'), patch.object(mod, 'write_status'), patch.object(mod, 'repos') as repos:
                self.assertIsNone(mod.expires_at_ms())
                self.assertIn('error', mod.run_once('wip'))
                repos.assert_not_called()
        metadata.write_text('{')
        with patch.object(mod, 'SESSION_FILE', metadata):
            self.assertIsNone(mod.expires_at_ms())
            with self.assertRaisesRegex(RuntimeError, 'invalid WIP session metadata'): mod.session_id()
    def test_lifecycle_dependencies_are_python314_stdlib(self):
        import ast, sys
        source = SOURCE.parent.parent / 'base-image/lifecycle.py'
        imports = [node.module.split('.')[0] if isinstance(node, ast.ImportFrom) else alias.name.split('.')[0]
                   for node in ast.walk(ast.parse(source.read_text()))
                   if isinstance(node, (ast.Import, ast.ImportFrom))
                   for alias in (node.names if isinstance(node, ast.Import) else [None])]
        self.assertEqual(sys.version_info[:2], (3, 14))
        self.assertTrue(set(imports) <= sys.stdlib_module_names)
    def test_invalid_ref_rejected(self):
        with self.assertRaises(RuntimeError): mod.wip_push(self.repo, '../main')

if __name__ == '__main__': unittest.main()
