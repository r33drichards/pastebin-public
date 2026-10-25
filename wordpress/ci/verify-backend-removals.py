#!/usr/bin/env python3
"""Verify the removal plan against tracked exact upstream bytes; never touch .git.

Default is read-only. --apply unlinks only after every present removal candidate
is a tracked, non-symlink regular file with the recorded baseline Git blob hash.
An incomplete/synthetic checkout must be reconciled first; do not add-all it.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
root = args.root.resolve()
manifest = json.loads(Path(__file__).with_name('backend-removals.json').read_text())
errors, eligible, absent = [], [], []
for entry in manifest['entries']:
    relative = PurePosixPath(entry['path'])
    if relative.is_absolute() or any(p in ('', '.', '..', '.git') for p in relative.parts):
        raise SystemExit('Unsafe manifest path')
    file = root.joinpath(*relative.parts)
    if not file.exists() and not file.is_symlink():
        absent.append(entry['path'])
        continue
    if file.is_symlink() or not file.is_file() or file.resolve() != file:
        errors.append(entry['path'] + ': not a canonical regular file')
        continue
    tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '--error-unmatch', '--', entry['path']], capture_output=True)
    if tracked.returncode:
        errors.append(entry['path'] + ': not tracked in this checkout')
        continue
    contents = file.read_bytes()
    blob = hashlib.sha1(('blob %d\0' % len(contents)).encode() + contents).hexdigest()
    if blob != entry['git_blob']:
        errors.append(entry['path'] + ': differs from verified upstream blob')
        continue
    eligible.append(file)
if errors:
    print(json.dumps({'status': 'blocked', 'eligible': len(eligible), 'absent': len(absent), 'errors': errors}, indent=2))
    raise SystemExit(1)
if args.apply:
    for file in eligible:
        file.unlink()
print(json.dumps({'status': 'removed' if args.apply else 'verified', 'files': [str(p.relative_to(root)) for p in eligible], 'already_absent': absent}, indent=2))
