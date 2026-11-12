#!/usr/bin/env python3
"""Read-only metadata inspection. Never read file content or follow directory links."""
import datetime
import json
import os
from pathlib import Path
import shutil
import sys

DATALess = 0x40000000  # Darwin SF_DATALESS, sys/stat.h


def inspect(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('root must be a directory')
    report = dict(schemaVersion='1.0', root=str(root),
                  observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  platform=sys.platform, metadataComplete=True, datalessFiles=[],
                  externalLinks=[], dependencyState='missing', freeBytes=0,
                  writable=os.access(root, os.W_OK), errors=[])

    def visit(path):
        try:
            stat = path.lstat()
            if sys.platform == 'darwin' and stat.st_flags & DATALess:
                report['datalessFiles'].append(str(path.relative_to(root)))
                return  # do not hydrate directories or content
            if path.is_symlink():
                target = path.resolve(strict=True)
                if not target.is_relative_to(root):
                    report['externalLinks'].append(str(path.relative_to(root)))
                return
            if path.is_dir():
                for child in path.iterdir():
                    # Git metadata may live outside a linked worktree; inspect its
                    # entry flags but never traverse objects. Verify Git separately.
                    if child.name == '.git':
                        if sys.platform == 'darwin' and child.lstat().st_flags & DATALess:
                            report['datalessFiles'].append(str(child.relative_to(root)))
                    else:
                        visit(child)
        except (OSError, RuntimeError) as error:
            report['errors'].append(f'{path.relative_to(root)}: {type(error).__name__}')
            report['metadataComplete'] = False

    # Outside Darwin this is a local Unix metadata check, not an iCloud certification.
    if sys.platform not in ('darwin', 'linux'):
        report['metadataComplete'] = False
        report['errors'].append('unsupported metadata platform')
    visit(root)
    try:
        report['freeBytes'] = shutil.disk_usage(root).free
        deps = root / 'node_modules'
        if deps.exists():
            if not deps.is_dir():
                raise ValueError('node_modules must be a directory')
            report['dependencyState'] = 'local' if deps.resolve().is_relative_to(root) else 'external'
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
