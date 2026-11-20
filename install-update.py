#!/usr/bin/env python3
"""Update the managed skill files from one release to another. Backups retain platform and role."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

ROOTS = [
    ('codex/.agents/skills/goal-orchestrator', '.agents/skills/goal-orchestrator'),
    ('codex/.agents/skills/long-task-supervisor', '.agents/skills/long-task-supervisor'),
    ('claude-code/.claude/skills/long-task-orchestrator', '.claude/skills/long-task-orchestrator'),
    ('claude-code/.claude/skills/long-task-supervisor', '.claude/skills/long-task-supervisor'),
    ('claude-code/.claude/agents', '.claude/agents'),
    ('claude-code/.claude/workflows', '.claude/workflows'),
]


def signature(file):
    if file.is_symlink():
        raise ValueError(f'Unexpected symbolic link: {file}')
    if not file.exists():
        return None
    return [hashlib.sha256(file.read_bytes()).hexdigest(), file.stat().st_mode & 0o111]


def files(root):
    return {p.relative_to(root) for p in root.rglob('*') if p.is_file()
            and '__pycache__' not in p.parts and p.name != '.DS_Store'}


def replace(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent)
    os.close(fd)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def plan(old, new, home):
    changes = []
    for source_dir, target_dir in ROOTS:
        before, after = old / source_dir, new / source_dir
        if not before.is_dir() or not after.is_dir():
            raise ValueError(f'Incomplete release tree: {source_dir}')
        for rel in sorted(files(before) | files(after)):
            key = str(Path(source_dir) / rel)
            dest = str(Path(target_dir) / rel)
            previous, desired = signature(before / rel), signature(after / rel)
            current = signature(home / dest)
            if current == desired:
                continue
            if current != previous:
                raise ValueError(f'Installed local change: {dest}')
            changes.append(dict(source=key, target=dest, before=previous, after=desired))
    return changes


def restore(rows, home, backup):
    for row in rows:
        current = signature(home / row['target'])
        if current not in (row['before'], row['after']):
            raise ValueError(f"Local file changed since install: {row['target']}")
        if row['before'] and signature(backup / row['source']) != row['before']:
            raise ValueError(f"Incomplete backup: {row['source']}")
    for row in reversed(rows):
        target = home / row['target']
        if signature(target) == row['before']:
            continue
        if row['before'] is None:
            target.unlink()
        else:
            replace(backup / row['source'], target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'install', 'restore'])
    parser.add_argument('--old', type=Path)
    parser.add_argument('--new', type=Path)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    if args.mode == 'restore':
        restore(json.loads((args.backup / 'manifest.json').read_text()), args.home, args.backup)
        return
    rows = plan(args.old, args.new, args.home)
    if args.mode == 'install' and rows:
        if not args.backup:
            parser.error('install requires a fresh --backup directory')
        args.backup.mkdir(parents=True, exist_ok=False)
        for row in rows:
            if row['before']:
                copy = args.backup / row['source']
                replace(args.home / row['target'], copy)
                if signature(copy) != row['before']:
                    raise ValueError(f'Backup verification failed: {copy}')
        (args.backup / 'manifest.json').write_text(json.dumps(rows, indent=2) + '\n')
        try:
            for row in rows:
                dest = args.home / row['target']
                if signature(dest) != row['before']:
                    raise ValueError(f'File changed during update: {dest}')
                if row['after'] is None:
                    dest.unlink()
                else:
                    replace(args.new / row['source'], dest)
            if plan(args.old, args.new, args.home):
                raise ValueError('Readback differs from release')
        except Exception:
            restore(rows, args.home, args.backup)
            raise
    print(json.dumps(dict(changed=len(rows), files=[row['target'] for row in rows])))


if __name__ == '__main__':
    main()
