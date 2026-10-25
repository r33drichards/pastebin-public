#!/usr/bin/env python3
"""Prepare local, disposable HTTP preview fixtures, never a live deployment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
work = Path(os.environ['PBIN_WP_FIXTURE']).resolve()
site = Path(os.environ['PBIN_WP_TEST_SITE']).resolve()
if not work.name.startswith('pbin-wp-ci.') or site != work / 'site':
    raise SystemExit('Refusing a non-disposable WordPress site')
artifact = Path(os.environ['PBIN_TEST_ARTIFACT']).resolve()
digest = os.environ['PBIN_TEST_ARTIFACT_SHA256']
if hashlib.sha256(artifact.read_bytes()).hexdigest() != digest:
    raise SystemExit('Test artifact digest mismatch')
with zipfile.ZipFile(artifact) as archive:
    revision = json.loads(archive.read('manifest.json'))['revision']
tools = ROOT / 'wordpress/tools'
previews = work / 'previews'

def command(script, *args):
    result = subprocess.run([sys.executable, str(tools / script), *map(str, args)], check=True, text=True, capture_output=True)
    return json.loads(result.stdout)

states = {}
for pr in ('910101', '910102'):
    states[pr] = command('preview_registry.py', '--root', previews, 'install', '--pr', pr,
            '--artifact', artifact, '--sha256', digest, '--revision', revision, '--expected-token', 'none')

# Synthetic upgrade is only a test fixture: never uploaded as a release artifact.
# It proves branch PHP selection, not merely registry/header changes. Base A/B
# both use the exact archive that the workflow may retain after all gates pass.
upgrade_revision = ('f' if revision != 'f' * 40 else 'e') * 40
upgrade_source = work / 'upgrade-source'
command('package.py', '--verify', artifact, '--sha256', digest, '--revision', revision, '--extract-to', upgrade_source)
runtime = upgrade_source / 'pbin/runtime.php'
text = runtime.read_text()
needle = 'namespace Pbin\\Plugin;'
if text.count(needle) != 1:
    raise SystemExit('Unexpected runtime namespace for synthetic upgrade')
runtime.write_text(text.replace(needle, needle + "\nif (PHP_SAPI !== 'cli') { header('X-Pbin-CI-Fixture: upgraded'); }", 1))
css = upgrade_source / 'pbin/static/css/app.css'
css.write_text(css.read_text() + '\n/* Synthetic CI upgrade: different immutable asset bytes. */\n')
upgrade = work / 'synthetic-upgrade.zip'
upgrade_info = command('package.py', '--source', upgrade_source / 'pbin', '--revision', upgrade_revision, '--output', upgrade)

mu = site / 'wp-content/mu-plugins'
(mu / 'pbin-preview').mkdir(parents=True)
for filename in ('loader.php', 'selector.php', 'health.php'):
    shutil.copyfile(ROOT / 'wordpress/preview' / filename, mu / 'pbin-preview' / filename)
(mu / 'pbin-preview.php').write_text("<?php\nrequire __DIR__ . '/pbin-preview/loader.php';\n")
data = {'root': str(previews), 'revision': revision, 'a': 910101, 'b': 910102,
        'a_token': states['910101']['state_token'], 'b_token': states['910102']['state_token'],
        'upgrade_revision': upgrade_revision, 'upgrade_artifact': str(upgrade),
        'upgrade_sha256': upgrade_info['artifact_sha256']}
(work / 'previews.json').write_text(json.dumps(data, sort_keys=True) + '\n')
print('Prepared real HTTP preview control plane and two exact-artifact tenants')
