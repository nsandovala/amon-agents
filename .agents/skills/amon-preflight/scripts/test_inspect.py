"""Isolated metadata regressions; no builds, processes or cloud hydration."""
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('amon_inspect', Path(__file__).with_name('inspect_environment.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InspectorTests(unittest.TestCase):
    def test_safe_tree_and_external_backup_link(self):
        # Only temporary directories created by this test are removed by TemporaryDirectory.
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'node_modules').mkdir()
            (root/'internal').symlink_to('node_modules')
            self.assertEqual(module.inspect(root)['externalLinks'], [])
            (root/'node_modules.linked-backup').symlink_to(root.parent)
            result = module.inspect(root)
            self.assertEqual(result['externalLinks'], ['node_modules.linked-backup'])
            self.assertEqual(result['dependencyState'], 'local')

    def test_dataless_metadata_never_reads_file_content(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'page.tsx'
            target.write_text('synthetic fixture')
            real_stat = Path.lstat
            def fake_stat(path):
                if path == target:
                    return types.SimpleNamespace(st_flags=module.DATALess)
                return real_stat(path)
            with patch.object(module.sys,'platform','darwin'), patch.object(Path,'lstat',fake_stat), \
                 patch.object(Path,'read_text',side_effect=AssertionError('must not read content')):
                self.assertEqual(module.inspect(root)['datalessFiles'], ['page.tsx'])

    def test_enumeration_denial_is_not_clean(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            with patch.object(Path,'iterdir',side_effect=PermissionError('synthetic denial')):
                report = module.inspect(folder)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(report['errors'])


if __name__ == '__main__':
    unittest.main()
