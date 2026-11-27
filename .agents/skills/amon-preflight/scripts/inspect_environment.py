#!/usr/bin/env python3
"""Read-only metadata inspection. Never read file content or follow directory links."""
import datetime
import json
import os
from pathlib import Path
import shutil
import stat as stat_module
import sys

DATALess = 0x40000000  # Darwin SF_DATALESS, sys/stat.h
WIN_OFFLINE = 0x00001000
WIN_RECALL_ON_OPEN = 0x00040000
WIN_RECALL_ON_DATA_ACCESS = 0x00400000
WIN_REPARSE_POINT = 0x00000400


def inspect(root):
    # abspath is lexical: resolve() would follow a redirected root before inspection.
    root = (Path(os.path.abspath(root)) if sys.platform == 'win32'
            else Path(root).resolve(strict=True))
    report = dict(schemaVersion='1.0', root=str(root),
                  observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  platform=sys.platform, metadataComplete=True, datalessFiles=[],
                  externalLinks=[], dependencyState='missing', freeBytes=0,
                  writable=False, errors=[])
    root_ready = False

    def windows_entry(path):
        # DirEntry.stat(False) uses enumeration metadata on Windows. In particular,
        # RECALL_ON_OPEN is an enumeration-only attribute, not an lstat guarantee.
        with os.scandir(path.parent) as entries:
            for entry in entries:
                if os.path.normcase(entry.name) == os.path.normcase(path.name):
                    return entry
        raise FileNotFoundError(str(path))

    def windows_metadata(path, entry=None):
        data = entry.stat(follow_symlinks=False) if entry else path.lstat()
        attributes = getattr(data, 'st_file_attributes', None)
        if not isinstance(attributes, int):
            raise ValueError('Windows file attributes unavailable')
        if attributes & WIN_REPARSE_POINT and not isinstance(getattr(data, 'st_reparse_tag', None), int):
            raise ValueError('Windows reparse tag unavailable')
        return data, attributes

    def placeholder(path, attributes):
        if attributes & (WIN_OFFLINE | WIN_RECALL_ON_OPEN | WIN_RECALL_ON_DATA_ACCESS):
            report['datalessFiles'].append(str(path.relative_to(root)) if path.is_relative_to(root) else str(path))
            return True
        return False

    def verify_windows_ancestors():
        # Each parent is classified before scanning its child. A redirected or
        # virtual root/ancestor cannot be silently accepted by resolve().
        chain = list(reversed(root.parents)) + [root]
        for path in chain:
            entry = None if path == Path(root.anchor) else windows_entry(path)
            data, attributes = windows_metadata(path, entry)
            if placeholder(path, attributes):
                raise ValueError('root or ancestor is not fully local')
            if attributes & WIN_REPARSE_POINT:
                raise ValueError('root or ancestor is a reparse point')
            if not stat_module.S_ISDIR(data.st_mode):
                raise ValueError('root or ancestor is not a directory')

    def verify_windows_target(path):
        # readlink supplies the link text without resolving its target. Check every
        # component before accepting an internal target; chains remain fail-closed.
        raw = os.readlink(path)
        target = Path(os.path.abspath(raw if os.path.isabs(raw) else path.parent / raw))
        if not target.is_relative_to(root):
            report['externalLinks'].append(str(path.relative_to(root)))
            return None
        current = root
        for part in target.relative_to(root).parts:
            current = current / part
            data, attributes = windows_metadata(current, windows_entry(current))
            if placeholder(current, attributes):
                raise ValueError('link target is not fully local')
            if attributes & WIN_REPARSE_POINT:
                raise ValueError('link target contains another reparse point')
            if current != target and not stat_module.S_ISDIR(data.st_mode):
                raise ValueError('link target ancestor is not a directory')
        if path == root / 'node_modules' and target != root and not stat_module.S_ISDIR(data.st_mode):
            raise ValueError('node_modules target must be a directory')
        return target

    def visit(path, git_entry=False, entry=None):
        try:
            dependency = path == root / 'node_modules'
            data = path.lstat() if sys.platform != 'win32' else None
            if sys.platform == 'darwin' and data.st_flags & DATALess:
                report['datalessFiles'].append(str(path.relative_to(root)))
                return  # do not hydrate directories or content
            if sys.platform == 'win32':
                data, attributes = windows_metadata(path, entry)
                if placeholder(path, attributes):
                    return  # do not hydrate cloud placeholders
                if attributes & WIN_REPARSE_POINT:
                    if data.st_reparse_tag not in (stat_module.IO_REPARSE_TAG_SYMLINK,
                                                   stat_module.IO_REPARSE_TAG_MOUNT_POINT):
                        raise ValueError('unsupported Windows reparse point')
                    target = verify_windows_target(path)
                    if dependency:
                        report['dependencyState'] = 'local' if target is not None else 'external'
                    return
            if sys.platform != 'win32' and path.is_symlink():
                target = path.resolve(strict=True)
                if not target.is_relative_to(root):
                    report['externalLinks'].append(str(path.relative_to(root)))
                    if dependency:
                        report['dependencyState'] = 'external'
                elif dependency:
                    if not target.is_dir():
                        raise ValueError('node_modules target must be a directory')
                    report['dependencyState'] = 'local'
                return
            if dependency:
                if not stat_module.S_ISDIR(data.st_mode):
                    raise ValueError('node_modules must be a directory')
                report['dependencyState'] = 'local'
            if git_entry:
                return  # inspect .git metadata, never traverse Git objects
            if stat_module.S_ISDIR(data.st_mode):
                if sys.platform == 'win32':
                    with os.scandir(path) as children:
                        for child in children:
                            visit(Path(child.path), git_entry=child.name == '.git', entry=child)
                else:
                    for child in path.iterdir():
                        visit(child, git_entry=child.name == '.git')
        except (OSError, RuntimeError, ValueError) as error:
            detail = f': {error}' if isinstance(error, ValueError) else ''
            report['errors'].append(f'{path.relative_to(root)}: {type(error).__name__}{detail}')
            report['metadataComplete'] = False

    # Windows attributes detect offline/recall placeholders; this does not certify
    # remote mounts or permissions beyond the executing context.
    if sys.platform not in ('darwin', 'linux', 'win32'):
        report['metadataComplete'] = False
        report['errors'].append('unsupported metadata platform')
    try:
        if sys.platform == 'win32':
            verify_windows_ancestors()
        elif not root.is_dir():
            raise ValueError('root must be a directory')
        root_ready = True
        report['writable'] = os.access(root, os.W_OK)
        visit(root)
    except (OSError, RuntimeError, ValueError) as error:
        report['metadataComplete'] = False
        detail = f': {error}' if isinstance(error, ValueError) else ''
        report['errors'].append(f'root: {type(error).__name__}{detail}')
    try:
        if root_ready:
            report['freeBytes'] = shutil.disk_usage(root).free
    except (OSError, RuntimeError, ValueError) as error:
        report['metadataComplete'] = False
        report['errors'].append(type(error).__name__)
    return report


if __name__ == '__main__':
    try:
        result = inspect(sys.argv[1] if len(sys.argv) == 2 else '.')
        print(json.dumps(result, indent=2))
        sys.exit(1 if not result['metadataComplete'] or result['datalessFiles'] or
                 result['externalLinks'] or not result['writable'] else 0)
    except (OSError, ValueError) as error:
        print(json.dumps({'error': type(error).__name__, 'metadataComplete': False}))
        sys.exit(1)
