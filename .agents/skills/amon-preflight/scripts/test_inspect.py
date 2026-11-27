"""Isolated metadata regressions; no builds, processes or cloud hydration."""
import importlib.util
from contextlib import contextmanager, nullcontext
import os
import ntpath
from pathlib import Path, PureWindowsPath
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('amon_inspect', Path(__file__).with_name('inspect_environment.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WindowsPathLexicalTests(unittest.TestCase):
    """Host-independent Windows path rules; no filesystem paths are fabricated."""

    def test_exact_workspace_components(self):
        root = PureWindowsPath('C:/Work/Repo')
        self.assertEqual(module.windows_relative_parts(root, PureWindowsPath('c:/Work/Repo/lib')),
                         ('lib',))
        self.assertIsNone(module.windows_relative_parts(root, PureWindowsPath('C:/Work/REPO/lib')))
        self.assertIsNone(module.windows_relative_parts(root, PureWindowsPath('C:/Work/RepoOther/lib')))
        self.assertEqual(PureWindowsPath('C:/Work/Repo/NODE_MODULES'),
                         PureWindowsPath('C:/Work/Repo/node_modules'))
        self.assertNotEqual(('NODE_MODULES',), ('node_modules',))
        self.assertEqual(ntpath.normcase('NODE_MODULES'), ntpath.normcase('node_modules'))

    def test_extended_drive_and_relative_targets(self):
        parent = PureWindowsPath('C:/Work/Repo')
        self.assertEqual(module.windows_target('\\\\?\\C:\\Work\\Repo\\lib', parent),
                         PureWindowsPath('C:/Work/Repo/lib'))
        self.assertEqual(module.windows_target('lib', parent), PureWindowsPath('C:/Work/Repo/lib'))
        self.assertEqual(module.windows_target('\\\\?\\C:\\outside', parent),
                         PureWindowsPath('C:/outside'))

    def test_unc_and_extended_unc_targets(self):
        parent = PureWindowsPath('C:/Work/Repo')
        expected = PureWindowsPath('//server/share/Repo/lib')
        self.assertEqual(module.windows_target('\\\\server\\share\\Repo\\lib', parent), expected)
        self.assertEqual(module.windows_target('\\\\?\\UNC\\server\\share\\Repo\\lib', parent), expected)
        self.assertEqual(module.windows_relative_parts(PureWindowsPath('//server/share/Repo'), expected),
                         ('lib',))
        self.assertIsNone(module.windows_relative_parts(parent, expected))

    def test_unknown_namespaces_and_ambiguous_components(self):
        parent = PureWindowsPath('C:/Work/Repo')
        for raw in ('\\\\.\\C:\\outside', '\\??\\C:\\outside',
                    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\outside',
                    'C:relative', '\\rooted', '..\\outside'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                module.windows_target(raw, parent)


class InspectorTests(unittest.TestCase):
    WIN_TAG_MOUNT_POINT = 0xA0000003
    WIN_TAG_SYMLINK = 0xA000000C

    @contextmanager
    def windows_entries(self, flags=None, tags=None, missing=(), denied=(), native_fields=True,
                        ambiguous=()):
        """Native Windows filesystem fixture with synthetic metadata and no links."""
        if os.name != 'nt':
            self.skipTest('Windows enumeration fixture needs a native Windows filesystem; pure path policy runs separately')
        flags, tags = flags or {}, tags or {}
        missing, denied, ambiguous = set(missing), set(denied), set(ambiguous)
        real_scandir = os.scandir
        real_lstat = Path.lstat

        class Entry:
            def __init__(self, original):
                self.name, self.path = original.name, original.path
                self.original = original

            def stat(self, *, follow_symlinks=True):
                if follow_symlinks:
                    raise AssertionError('must not follow an entry')
                path = Path(self.path)
                original = self.original.stat(follow_symlinks=False)
                if not native_fields:
                    original = types.SimpleNamespace(st_mode=original.st_mode)
                return types.SimpleNamespace(
                    st_mode=original.st_mode,
                    st_file_attributes=None if path in missing else flags[path] if path in flags else 0,
                    st_reparse_tag=tags[path] if path in tags else 0,
                )

        def lstat(path):
            original = real_lstat(path)
            return types.SimpleNamespace(
                st_mode=original.st_mode,
                st_file_attributes=None if path in missing else flags[path] if path in flags else 0,
                st_reparse_tag=tags[path] if path in tags else 0,
            )

        def scan(path):
            if Path(path) in denied:
                raise PermissionError('synthetic denial')
            with real_scandir(path) as entries:
                result = [Entry(entry) for entry in entries]
                for entry in list(result):
                    if Path(entry.path) in ambiguous:
                        duplicate = Entry(entry.original)
                        duplicate.name = entry.name.swapcase()
                        duplicate.path = str(Path(path)/duplicate.name)
                        result.append(duplicate)
                return nullcontext(result)

        with patch.object(module.sys, 'platform', 'win32'), \
             patch.object(module.os, 'scandir', scan), \
             patch.object(Path, 'lstat', lstat), \
             patch.object(module.stat_module, 'IO_REPARSE_TAG_MOUNT_POINT', self.WIN_TAG_MOUNT_POINT, create=True), \
             patch.object(module.stat_module, 'IO_REPARSE_TAG_SYMLINK', self.WIN_TAG_SYMLINK, create=True):
            yield

    def link_or_skip(self, link, target):
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows symlink privilege unavailable')
            raise

    def test_safe_tree_and_external_backup_link(self):
        # Only temporary directories created by this test are removed by TemporaryDirectory.
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'node_modules').mkdir()
            self.link_or_skip(root/'internal', 'node_modules')
            self.assertEqual(module.inspect(root)['externalLinks'], [])
            self.link_or_skip(root/'node_modules.linked-backup', root.parent)
            result = module.inspect(root)
            self.assertEqual(result['externalLinks'], ['node_modules.linked-backup'])
            self.assertEqual(result['dependencyState'], 'local')

    def test_directory_links_are_not_traversed_and_broken_links_are_reported(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'canonical').mkdir()
            self.link_or_skip(root/'adapter', 'canonical')
            real_iterdir = Path.iterdir
            def guarded(path):
                if path == root/'adapter':
                    raise AssertionError('must not traverse directory link')
                return real_iterdir(path)
            with patch.object(Path, 'iterdir', guarded):
                self.assertTrue(module.inspect(root)['metadataComplete'])
            self.link_or_skip(root/'broken', 'missing')
            result = module.inspect(root)
            self.assertFalse(result['metadataComplete'])
            self.assertTrue(any('broken' in e for e in result['errors']))

    def test_dataless_metadata_never_reads_file_content(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'page.tsx'
            target.write_text('synthetic fixture')
            real_stat = Path.lstat
            def fake_stat(path):
                # Linux stat results lack st_flags; supply Darwin metadata for every path.
                return types.SimpleNamespace(
                    st_mode=real_stat(path).st_mode,
                    st_flags=module.DATALess if path == target else 0,
                )
            with patch.object(module.sys,'platform','darwin'), patch.object(Path,'lstat',fake_stat), \
                 patch.object(Path,'read_text',side_effect=AssertionError('must not read content')):
                self.assertEqual(module.inspect(root)['datalessFiles'], ['page.tsx'])

    def test_enumeration_denial_is_not_clean(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            with self.windows_entries(denied=[Path(folder)]):
                report = module.inspect(folder)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(report['errors'])

    def test_windows_offline_and_reparse_metadata_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'placeholder'
            target.write_text('synthetic fixture')
            with self.windows_entries(flags={target: module.WIN_OFFLINE}), \
                 patch.object(Path, 'read_text', side_effect=AssertionError('must not read content')):
                self.assertEqual(module.inspect(root)['datalessFiles'], ['placeholder'])
            with self.windows_entries(flags={target: module.WIN_REPARSE_POINT}, tags={target: 0x12345678}), \
                 patch.object(module.os, 'readlink', side_effect=AssertionError('unknown tag resolved')):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(any('placeholder' in e for e in report['errors']))

    def test_windows_recall_flags_and_git_entry_are_checked(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'.git').mkdir()
            (root/'.git'/'objects').mkdir()
            target = root/'recall'
            target.write_text('synthetic fixture')
            for flag in (module.WIN_RECALL_ON_OPEN, module.WIN_RECALL_ON_DATA_ACCESS):
                with self.windows_entries(flags={target: flag}, denied=[root/'.git']):
                    report = module.inspect(root)
                self.assertEqual(report['datalessFiles'], ['recall'])
                self.assertTrue(report['metadataComplete'])

            with self.windows_entries(flags={root/'.git': module.WIN_OFFLINE}, denied=[root/'.git']):
                report = module.inspect(root)
            self.assertEqual(report['datalessFiles'], ['.git'])

    def test_windows_missing_attributes_and_link_denial_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'entry'
            target.write_text('synthetic fixture')
            with self.windows_entries(missing=[target]):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(any('entry: ValueError' in e for e in report['errors']))

            with self.windows_entries(denied=[root]):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(any('PermissionError' in e for e in report['errors']))

    def test_windows_junction_targets_without_resolving_or_traversing(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'canonical'
            target.mkdir()
            (root/'node_modules').mkdir()
            link = root/'adapter'
            link.write_text('synthetic junction entry')
            flags = {link: module.WIN_REPARSE_POINT}
            tags = {link: self.WIN_TAG_MOUNT_POINT}
            for raw, expected_external, expected_complete in (
                ('canonical', [], True),
                (str(root.parent), ['adapter'], True),
                ('missing', [], False),
            ):
                with self.windows_entries(flags=flags, tags=tags), \
                     patch.object(module.os, 'readlink', return_value=raw) as readlink, \
                     patch.object(Path, 'resolve', side_effect=AssertionError('target resolved')), \
                     patch.object(Path, 'open', side_effect=AssertionError('content opened')), \
                     patch.object(Path, 'is_junction', side_effect=AssertionError('3.12 API used'), create=True):
                    report = module.inspect(root)
                self.assertEqual(report['externalLinks'], expected_external)
                self.assertEqual(report['metadataComplete'], expected_complete)
                if expected_external:
                    self.assertEqual(report['dependencyState'], 'local')
                    self.assertGreater(report['freeBytes'], 0)
                readlink.assert_called_once_with(link)

    def test_windows_case_changed_boundary_is_not_internal(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'node_modules').mkdir()
            link = root/'adapter'
            link.write_text('synthetic junction entry')
            changed = str(root.parent / root.name.swapcase() / 'node_modules')
            with self.windows_entries(flags={link: module.WIN_REPARSE_POINT},
                                      tags={link: self.WIN_TAG_MOUNT_POINT}), \
                 patch.object(module.os, 'readlink', return_value=changed), \
                 patch.object(Path, 'resolve', side_effect=AssertionError('target resolved')):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'] and not report['externalLinks'])
            with self.windows_entries(flags={link: module.WIN_REPARSE_POINT},
                                      tags={link: self.WIN_TAG_MOUNT_POINT}), \
                 patch.object(module.os, 'readlink', return_value='NODE_MODULES'):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])

    def test_windows_extended_drive_junction_is_internal(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'canonical'
            target.mkdir()
            link = root/'adapter'
            link.write_text('synthetic junction entry')
            raw = '\\\\?\\' + str(target)
            with self.windows_entries(flags={link: module.WIN_REPARSE_POINT},
                                      tags={link: self.WIN_TAG_MOUNT_POINT}), \
                 patch.object(module.os, 'readlink', return_value=raw), \
                 patch.object(Path, 'resolve', side_effect=AssertionError('target resolved')):
                report = module.inspect(root)
            self.assertTrue(report['metadataComplete'])
            self.assertEqual(report['externalLinks'], [])

    def test_windows_extended_external_and_dependency_targets(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            canonical = root/'canonical'
            canonical.mkdir()
            dependency = root/'node_modules'
            dependency.write_text('synthetic junction entry')
            flags = {dependency: module.WIN_REPARSE_POINT}
            tags = {dependency: self.WIN_TAG_MOUNT_POINT}
            for raw, state, external in (
                ('\\\\?\\' + str(canonical), 'local', []),
                ('\\\\?\\' + str(root.parent), 'external', ['node_modules']),
            ):
                with self.windows_entries(flags=flags, tags=tags), \
                     patch.object(module.os, 'readlink', return_value=raw):
                    report = module.inspect(root)
                self.assertTrue(report['metadataComplete'])
                self.assertEqual(report['dependencyState'], state)
                self.assertEqual(report['externalLinks'], external)

    def test_windows_uppercase_dependency_name_is_not_local(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'NODE_MODULES').mkdir()
            with self.windows_entries():
                report = module.inspect(root)
            self.assertTrue(report['metadataComplete'])
            self.assertEqual(report['dependencyState'], 'missing')
            with self.windows_entries(ambiguous=[root/'NODE_MODULES']):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertEqual(report['dependencyState'], 'missing')

    def test_windows_ambiguous_enumeration_and_unknown_namespaces_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            target = root/'canonical'
            target.mkdir()
            link = root/'adapter'
            link.write_text('synthetic junction entry')
            flags = {link: module.WIN_REPARSE_POINT}
            tags = {link: self.WIN_TAG_MOUNT_POINT}
            with self.windows_entries(flags=flags, tags=tags, ambiguous=[target]), \
                 patch.object(module.os, 'readlink', return_value='canonical'):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(any('ambiguous Windows' in error for error in report['errors']))
            for raw in ('\\\\.\\C:\\outside', '\\??\\C:\\outside',
                        '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\outside',
                        'C:relative', '\\rooted', '..\\outside'):
                with self.subTest(raw=raw), self.windows_entries(flags=flags, tags=tags), \
                     patch.object(module.os, 'readlink', return_value=raw), \
                     patch.object(Path, 'resolve', side_effect=AssertionError('target resolved')):
                    report = module.inspect(root)
                self.assertFalse(report['metadataComplete'])
                self.assertTrue(report['errors'])
            for raw in ('\\\\server\\share\\outside',
                        '\\\\?\\UNC\\server\\share\\outside'):
                with self.subTest(raw=raw), self.windows_entries(flags=flags, tags=tags), \
                     patch.object(module.os, 'readlink', return_value=raw), \
                     patch.object(Path, 'resolve', side_effect=AssertionError('target resolved')):
                    report = module.inspect(root)
                self.assertTrue(report['metadataComplete'])
                self.assertEqual(report['externalLinks'], ['adapter'])

    def test_windows_fixture_needs_no_native_windows_stat_fields(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'node_modules').mkdir()
            target = root/'placeholder'
            target.write_text('synthetic fixture')
            with self.windows_entries(flags={target: module.WIN_OFFLINE}, native_fields=False):
                report = module.inspect(root)
            self.assertEqual(report['datalessFiles'], ['placeholder'])
            self.assertEqual(report['dependencyState'], 'local')
            self.assertGreater(report['freeBytes'], 0)

    def test_external_junction_keeps_local_dependency_classification(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'node_modules').mkdir()
            link = root/'linked-backup'
            link.write_text('synthetic junction entry')
            with self.windows_entries(flags={link: module.WIN_REPARSE_POINT},
                                      tags={link: self.WIN_TAG_MOUNT_POINT}), \
                 patch.object(module.os, 'readlink', return_value=str(root.parent)):
                report = module.inspect(root)
            self.assertEqual(report['externalLinks'], ['linked-backup'])
            self.assertTrue(report['metadataComplete'])
            self.assertEqual(report['dependencyState'], 'local')
            self.assertGreater(report['freeBytes'], 0)

    def test_windows_root_and_ancestor_redirection_fail_before_inspection(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            for redirected in (root, root.parent):
                with self.windows_entries(flags={redirected: module.WIN_REPARSE_POINT},
                                          tags={redirected: self.WIN_TAG_MOUNT_POINT}), \
                     patch.object(module.os, 'readlink', side_effect=AssertionError('root target read')), \
                     patch.object(Path, 'resolve', side_effect=AssertionError('root resolved')):
                    report = module.inspect(root)
                self.assertFalse(report['metadataComplete'])
                self.assertTrue(any('root or ancestor is a reparse point' in e for e in report['errors']))

    def test_windows_missing_reparse_tag_blocks_before_target_access(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            link = root/'entry'
            link.write_text('synthetic entry')
            with self.windows_entries(flags={link: module.WIN_REPARSE_POINT}, tags={link: None}), \
                 patch.object(module.os, 'readlink', side_effect=AssertionError('target read')):
                report = module.inspect(root)
            self.assertFalse(report['metadataComplete'])
            self.assertTrue(any('reparse tag unavailable' in e for e in report['errors']))

    def test_linux_tree_needs_no_windows_attributes(self):
        with tempfile.TemporaryDirectory(prefix='.aa-skills-fixture-', dir=Path.cwd()) as folder:
            root = Path(folder)
            (root/'plain').write_text('synthetic fixture')
            with patch.object(module.sys, 'platform', 'linux'), \
                 patch.object(Path, 'is_junction', side_effect=AssertionError('Windows API used'), create=True):
                report = module.inspect(root)
            self.assertTrue(report['metadataComplete'])
            self.assertEqual(report['datalessFiles'], [])


if __name__ == '__main__':
    unittest.main()
