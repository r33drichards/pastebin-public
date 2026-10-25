#!/usr/bin/env python3
"""Prepare only synthetic test code; never retain it as a deployment artifact."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
work = Path(os.environ.get("PBIN_WP_FIXTURE", ""))
if os.environ.get("PBIN_CONTROLLER_GATE") != "1" or work.resolve() != work or not work.name.startswith("pbin-wp-ci."):
    raise SystemExit("Disposable controller fixture required")
artifact = Path(os.environ["PBIN_CONTROLLER_ARTIFACT"]).resolve(strict=True)
digest = os.environ["PBIN_CONTROLLER_ARTIFACT_SHA256"]

def package(*args):
    result = subprocess.run([sys.executable, str(ROOT / "wordpress/tools/package.py"), *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Controller test artifact verification/build failed")
    return json.loads(result.stdout)

revision = os.environ.get("PBIN_SOURCE_SHA", "")
if not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise SystemExit("Exact PBIN_SOURCE_SHA is required")
verified = package("--verify", artifact, "--sha256", digest, "--revision", revision, "--extract-to", work / "controller-upgrade-source")
upgrade_revision = ("f" if revision != "f" * 40 else "e") * 40
source = work / "controller-upgrade-source/pbin"
runtime = source / "runtime.php"
text = runtime.read_text()
needle = "namespace Pbin\\Plugin;"
if text.count(needle) != 1:
    raise SystemExit("Unexpected controller upgrade source")
runtime.write_text(text.replace(needle, needle + "\nif (PHP_SAPI !== 'cli') { header('X-Pbin-CI-Fixture: controller-upgraded'); }", 1))
css = source / "static/css/app.css"
css.write_text(css.read_text() + "\n/* Controller fixture synthetic upgrade. */\n")
upgrade = package("--source", source, "--revision", upgrade_revision, "--output", work / "controller-upgrade.zip")
(work / "controller-artifacts.json").write_text(json.dumps({"artifact": str(artifact), "digest": digest, "revision": revision,
    "upgrade_artifact": str(work / "controller-upgrade.zip"), "upgrade_digest": upgrade["artifact_sha256"], "upgrade_revision": upgrade_revision}))
print("PASS: exact controller artifact verified; synthetic upgrade prepared separately")
