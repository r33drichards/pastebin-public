#!/usr/bin/env python3
"""Python-stdlib package and staging lifecycle regression/security tests."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import package
import preview_registry as registry

A1 = "a" * 40
A2 = "b" * 40
A3 = "c" * 40
A4 = "d" * 40
B1 = "e" * 40


class PreviewTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "pbin.php").write_bytes(b"<?php /* entry */\n")
        (self.source / "runtime.php").write_bytes(b"<?php /* runtime */\n")
        (self.source / "static").mkdir()
        (self.source / "static" / "runner.wasm").write_bytes(bytes(range(256)) * 128)
        self.root = self.base / "staging"
        self.counter = 0

    def tearDown(self):
        # Installed releases intentionally have read-only directories.
        for current, directories, filenames in os.walk(self.base):
            if not Path(current).is_symlink():
                os.chmod(current, 0o700)
        self.temporary.cleanup()

    def build(self, revision=A1, marker=None):
        if marker is not None:
            (self.source / "runtime.php").write_text("<?php /* " + marker + " */\n")
        self.counter += 1
        artifact = self.base / ("package-%d.zip" % self.counter)
        return artifact, package.build_package(self.source, revision, artifact)

    def install(self, pr=1, revision=A1, expected=None, marker=None, **kwargs):
        artifact, result = self.build(revision, marker)
        return registry.install(self.root, pr, artifact, result["artifact_sha256"], expected, **kwargs)

    def state(self):
        return json.loads((self.root / "registry.json").read_text())

    def token(self, pr=1):
        return self.state()["tenants"]["pr-" + str(pr)]["state_token"]

    def release(self, pr=1, revision=A1):
        return self.root / "releases" / ("pr-" + str(pr)) / revision

    def crafted(self, payload=None, mutate_manifest=None, extras=(), compression=zipfile.ZIP_STORED):
        payload = payload or {"pbin/pbin.php": b"<?php entry", "pbin/runtime.php": b"<?php runtime"}
        manifest = {"version": 1, "revision": A1, "files": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} for name, data in payload.items()}}
        if mutate_manifest:
            mutate_manifest(manifest)
        self.counter += 1
        artifact = self.base / ("crafted-%d.zip" % self.counter)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(artifact, "w", compression=compression) as archive:
                archive.writestr("manifest.json", package.canonical_json(manifest))
                for name, data in payload.items():
                    archive.writestr(name, data)
                for name, data in extras:
                    archive.writestr(name, data)
        return artifact, package.file_sha256(artifact)

    def reject(self, artifact, digest, limits=package.Limits()):
        with self.assertRaises((package.PackageError, OSError)):
            with package.open_verified_package(artifact, digest, limits):
                pass


class PackageTests(PreviewTest):
    def test_deterministic_bytes_preserve_binary_and_fix_metadata(self):
        one, first = self.build()
        os.utime(self.source / "runtime.php", (1234567890, 1234567890))
        os.chmod(self.source / "runtime.php", 0o755)
        two, second = self.build()
        self.assertEqual(one.read_bytes(), two.read_bytes())
        self.assertEqual(first["artifact_sha256"], second["artifact_sha256"])
        with package.open_verified_package(one, first["artifact_sha256"]) as checked:
            self.assertEqual(A1, checked.revision)
            checked.extract(self.base / "extracted")
            self.assertEqual((self.source / "static/runner.wasm").read_bytes(),
                             (self.base / "extracted/pbin/static/runner.wasm").read_bytes())
            self.assertEqual(set(checked.manifest["files"]),
                             {"pbin/" + path.relative_to(self.source).as_posix() for path in self.source.rglob("*") if path.is_file()})
            for entry in checked.archive.infolist():
                self.assertEqual((1980, 1, 1, 0, 0, 0), entry.date_time)
                self.assertEqual(zipfile.ZIP_STORED, entry.compress_type)
                self.assertEqual(stat.S_IFREG | 0o644, entry.external_attr >> 16)

    def test_real_runtime_assets_are_all_packaged(self):
        source = TOOLS.parent / "pbin"
        artifact = self.base / "real.zip"
        result = package.build_package(source, A1, artifact)
        source_files = {"pbin/" + path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
        with package.open_verified_package(artifact, result["artifact_sha256"]) as checked:
            self.assertEqual(source_files, set(checked.manifest["files"]))
            for asset in ("picat/picat.wasm", "quickjs/qjs-wasi.wasm", "tla-checker/tla_checker_bg.wasm", "ocaml/toplevel.js"):
                self.assertIn("pbin/static/wasm/" + asset, checked.manifest["files"])
        second = self.base / "real-again.zip"
        again = package.build_package(source, A1, second)
        self.assertEqual(result["artifact_sha256"], again["artifact_sha256"])

    def test_verified_archive_is_a_snapshot_not_a_mutable_input_file(self):
        artifact, result = self.build()
        with package.open_verified_package(artifact, result["artifact_sha256"]) as checked:
            artifact.write_bytes(b"replaced after verification")
            checked.extract(self.base / "snapshot")
        self.assertEqual((self.source / "runtime.php").read_bytes(),
                         (self.base / "snapshot/pbin/runtime.php").read_bytes())

    def test_reject_digest_or_revision_mismatch(self):
        artifact, result = self.build()
        self.reject(artifact, "0" * 64)
        with self.assertRaises(package.PackageError):
            registry.install(self.root, 1, artifact, result["artifact_sha256"], None, expected_revision=A2)
        self.assertFalse(self.root.exists())

    def test_source_symlinks_and_control_plane_are_not_silently_skipped(self):
        (self.source / "link").symlink_to(self.source / "runtime.php")
        with self.assertRaises(package.PackageError):
            self.build()
        (self.source / "link").unlink()
        (self.source / ".user.ini").write_text("auto_prepend_file=bad.php")
        with self.assertRaises(package.PackageError):
            self.build()

    def test_reject_zip_slip_absolute_windows_control_plane_and_invalid_paths(self):
        paths = ["../outside.php", "/outside.php", "pbin/../../outside.php", "pbin\\runtime.php",
                 "pbin//extra.php", "pbin/./extra.php", "C:/outside.php", "registry.json",
                 "preview/loader.php", "pbin/preview/loader.php", "pbin/wp-config.php",
                 "pbin/.htaccess", "pbin/UPPER/.USER.INI", "pbin/line\nbreak.php"]
        for path in paths:
            with self.subTest(path=path):
                self.reject(*self.crafted(extras=[(path, b"malicious")]))
        self.assertFalse((self.base / "outside.php").exists())

    def test_reject_duplicate_case_collision_and_symlink_entries(self):
        self.reject(*self.crafted(extras=[("pbin/runtime.php", b"duplicate")]))
        self.reject(*self.crafted(extras=[("pbin/RUNTIME.php", b"collision")]))
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o644, stat.S_IFDIR | 0o755):
            info = zipfile.ZipInfo("pbin/evil")
            info.create_system = 3
            info.external_attr = mode << 16
            self.reject(*self.crafted(extras=[(info, b"../outside")]))

    def test_reject_zipbombs_and_size_count_limits(self):
        payload = {"pbin/pbin.php": b"ok", "pbin/runtime.php": b"x" * 1000000}
        self.reject(*self.crafted(payload=payload, compression=zipfile.ZIP_DEFLATED))
        artifact, digest = self.crafted()
        self.reject(artifact, digest, package.Limits(max_archive_bytes=10))
        self.reject(artifact, digest, package.Limits(max_expanded_bytes=50))
        self.reject(artifact, digest, package.Limits(max_file_bytes=1))
        self.reject(artifact, digest, package.Limits(max_files=1))
        self.reject(artifact, digest, package.Limits(max_manifest_bytes=10))

    def test_reject_manifest_missing_extra_incorrect_file_and_bad_json(self):
        mutations = [lambda m: m["files"].pop("pbin/runtime.php"),
                     lambda m: m["files"]["pbin/runtime.php"].update(sha256="0" * 64),
                     lambda m: m["files"]["pbin/runtime.php"].update(size=999),
                     lambda m: m.update(revision="not-a-sha"),
                     lambda m: m.update(version=True),
                     lambda m: m.update(extra="control-plane")]
        for mutate in mutations:
            self.reject(*self.crafted(mutate_manifest=mutate))
        self.reject(*self.crafted(extras=[("pbin/unlisted.php", b"surprise")]))
        with self.assertRaises(package.PackageError):
            package.validate_manifest(b'{"version":1,"version":1,"revision":"' + A1.encode() + b'","files":{}}')
        with self.assertRaises(package.PackageError):
            package.strict_json(b'{"number":NaN}')

    def test_reject_conflicting_file_and_directory_paths(self):
        payload = {"pbin/pbin.php": b"ok", "pbin/runtime.php": b"ok", "pbin/foo": b"file", "pbin/foo/bar": b"nested"}
        self.reject(*self.crafted(payload=payload))

    def test_extraction_cannot_reuse_existing_or_symlinked_directory(self):
        artifact, result = self.build()
        with package.open_verified_package(artifact, result["artifact_sha256"]) as checked:
            (self.base / "existing").mkdir()
            (self.base / "existing/sentinel").write_text("keep")
            with self.assertRaises(FileExistsError):
                checked.extract(self.base / "existing")
            (self.base / "linked").symlink_to(self.base / "existing", target_is_directory=True)
            with self.assertRaises(package.PackageError):
                checked.extract(self.base / "linked/new")
        self.assertEqual("keep", (self.base / "existing/sentinel").read_text())

    def test_builder_and_verifier_cli(self):
        artifact = self.base / "cli.zip"
        command = [sys.executable, str(TOOLS / "package.py"), "--source", str(self.source), "--revision", A1, "--output", str(artifact)]
        result = json.loads(subprocess.check_output(command, text=True))
        verified = subprocess.run([sys.executable, str(TOOLS / "package.py"), "--verify", str(artifact), "--sha256",
                                   result["artifact_sha256"], "--revision", A1, "--extract-to", str(self.base / "cli-extracted")],
                                  capture_output=True, text=True)
        self.assertEqual(0, verified.returncode, verified.stderr)
        self.assertTrue((self.base / "cli-extracted/pbin/runtime.php").is_file())


class LifecycleTests(PreviewTest):
    def test_a_update_rollback_and_retire_preserve_b_and_both_data(self):
        self.install(1, A1, marker="A old")
        self.install(2, B1, marker="B")
        before_b = copy.deepcopy(self.state()["tenants"]["pr-2"])
        for pr in (1, 2):
            (self.root / "data" / ("pr-%d" % pr) / "saved.txt").write_text("data for %d" % pr)
        self.install(1, A2, expected=self.token(), marker="A new")
        self.assertEqual(A2, self.state()["tenants"]["pr-1"]["active"])
        self.assertIn("A old", (self.release(1, A1) / "pbin/runtime.php").read_text())
        self.assertIn("A new", (self.release(1, A2) / "pbin/runtime.php").read_text())
        registry.rollback(self.root, 1, A1, self.token())
        self.assertEqual(A1, self.state()["tenants"]["pr-1"]["active"])
        registry.retire(self.root, 1, self.token())
        self.assertFalse(self.state()["tenants"]["pr-1"]["enabled"])
        self.assertEqual(before_b, self.state()["tenants"]["pr-2"])
        for pr in (1, 2):
            self.assertEqual("data for %d" % pr, (self.root / "data" / ("pr-%d" % pr) / "saved.txt").read_text())
        self.assertTrue(self.release(1, A1).exists())
        self.assertTrue(self.release(1, A2).exists())
        self.assertTrue(self.release(2, B1).exists())
        registry.rollback(self.root, 1, A2, self.token())
        self.assertTrue(self.state()["tenants"]["pr-1"]["enabled"])

    def test_separate_registry_roots_are_isolated(self):
        artifact, result = self.build()
        other = self.base / "other-staging"
        registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        registry.install(other, 1, artifact, result["artifact_sha256"], None)
        unchanged = (other / "registry.json").read_bytes()
        registry.retire(self.root, 1, self.token())
        self.assertEqual(unchanged, (other / "registry.json").read_bytes())
        self.assertTrue(self.release().is_dir())
        self.assertTrue((other / "releases/pr-1" / A1).is_dir())

    def test_stale_cas_install_rollback_and_retire_fail_without_changes(self):
        self.install()
        before = (self.root / "registry.json").read_bytes()
        artifact, built = self.build(A2)
        actions = [lambda: registry.install(self.root, 1, artifact, built["artifact_sha256"], None),
                   lambda: registry.rollback(self.root, 1, A1, "0" * 64),
                   lambda: registry.retire(self.root, 1, "0" * 64)]
        for action in actions:
            with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
                action()
            self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertFalse(self.release(1, A2).exists())

    def test_immutable_reinstall_is_idempotent_and_different_bytes_fail(self):
        artifact, result = self.build()
        registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        inode = self.release().stat().st_ino
        before = (self.root / "registry.json").read_bytes()
        registry.install(self.root, 1, artifact, result["artifact_sha256"], self.token())
        self.assertEqual(inode, self.release().stat().st_ino)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        other, changed = self.build(A1, "different bytes at same revision")
        with self.assertRaisesRegex(registry.RegistryError, "Immutable revision"):
            registry.install(self.root, 1, other, changed["artifact_sha256"], self.token())
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertEqual(0, self.release().stat().st_mode & 0o222)
        self.assertEqual(0, (self.release() / "pbin/runtime.php").stat().st_mode & 0o222)

    def test_active_budget_and_retired_slot_reuse_keep_retained_files(self):
        self.install(1, A1)
        self.install(2, B1)
        with self.assertRaisesRegex(registry.RegistryError, "Active PR budget"):
            self.install(3, A3)
        self.assertFalse(self.release(3, A3).exists())
        registry.retire(self.root, 1, self.token())
        self.install(3, A3)
        self.assertTrue(self.release(1, A1).exists())
        with self.assertRaisesRegex(registry.RegistryError, "Active PR budget"):
            registry.rollback(self.root, 1, A1, self.token())

    def test_revision_budget_never_deletes_previous_releases(self):
        self.install(1, A1)
        self.install(1, A2, self.token())
        self.install(1, A3, self.token())
        before = (self.root / "registry.json").read_bytes()
        with self.assertRaisesRegex(registry.RegistryError, "Retained revision budget"):
            self.install(1, A4, self.token())
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        for revision in (A1, A2, A3):
            self.assertTrue(self.release(1, revision).exists())
        self.assertFalse(self.release(1, A4).exists())

    def test_disk_budget_counts_retired_releases_and_persistent_data(self):
        self.install()
        (self.root / "data/pr-1/saved.bin").write_bytes(b"data" * 10000)
        registry.retire(self.root, 1, self.token())
        size = registry.storage_bytes(self.root)
        artifact, result = self.build(A2)
        budget = registry.Budget(max_total_bytes=size + result["uncompressed_bytes"] - 1)
        with self.assertRaisesRegex(registry.RegistryError, "Storage budget"):
            registry.install(self.root, 2, artifact, result["artifact_sha256"], None, budget)
        self.assertTrue(self.release().exists())
        self.assertEqual(b"data" * 10000, (self.root / "data/pr-1/saved.bin").read_bytes())
        registry.install(self.root, 2, artifact, result["artifact_sha256"], None,
                         registry.Budget(max_total_bytes=size + result["uncompressed_bytes"]))
        self.assertEqual(size + result["uncompressed_bytes"], registry.storage_bytes(self.root))

    def test_rollback_verifies_manifest_inventory_and_content(self):
        self.install(1, A1)
        self.install(1, A2, self.token())
        target = self.release(1, A1) / "pbin/runtime.php"
        os.chmod(target, 0o644)
        target.write_text("modified")
        before = (self.root / "registry.json").read_bytes()
        with self.assertRaisesRegex(registry.RegistryError, "Retained file checksum"):
            registry.rollback(self.root, 1, A1, self.token())
        self.assertEqual(before, (self.root / "registry.json").read_bytes())

    def test_rollback_rejects_rewritten_manifest_even_if_file_hash_updated(self):
        self.install(1, A1)
        self.install(1, A2, self.token())
        manifest_path = self.release(1, A1) / "manifest.json"
        os.chmod(manifest_path, 0o644)
        content = json.loads(manifest_path.read_text())
        content["files"]["pbin/runtime.php"]["sha256"] = "0" * 64
        manifest_path.write_bytes(package.canonical_json(content))
        with self.assertRaisesRegex(registry.RegistryError, "Retained manifest checksum"):
            registry.rollback(self.root, 1, A1, self.token())

    def test_symlinked_root_registry_release_data_or_lock_fail_closed(self):
        actual = self.base / "actual"
        actual.mkdir()
        self.root.symlink_to(actual, target_is_directory=True)
        artifact, result = self.build()
        with self.assertRaises(registry.RegistryError):
            registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        self.root.unlink()
        self.install()
        for name in ("registry.json", ".registry.lock"):
            path = self.root / name
            saved = path.with_name(name + ".saved")
            path.rename(saved)
            path.symlink_to(saved)
            with self.assertRaises((registry.RegistryError, OSError)):
                registry.retire(self.root, 1, self.token())
            path.unlink()
            saved.rename(path)
        (self.root / "data/evil").symlink_to(actual, target_is_directory=True)
        with self.assertRaises(registry.RegistryError):
            registry.rollback(self.root, 1, A1, self.token())

    def test_malformed_registry_is_not_replaced(self):
        self.install()
        path = self.root / "registry.json"
        token = self.token()
        for value in (b'{"version":1,"version":1,"tenants":{}}',
                      b'{"version":3,"tenants":{}}', b'null'):
            path.write_bytes(value)
            with self.assertRaises(package.PackageError):
                registry.retire(self.root, 1, token)
            self.assertEqual(value, path.read_bytes())

    def test_promotion_failure_retains_orphan_and_retry_safely_adopts_it(self):
        artifact, result = self.build()
        with mock.patch.object(registry, "_write_registry", side_effect=OSError("simulated disk error")):
            with self.assertRaises(OSError):
                registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        self.assertTrue(self.release().exists())
        self.assertFalse((self.root / "registry.json").exists())
        inode = self.release().stat().st_ino
        registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        self.assertEqual(inode, self.release().stat().st_ino)
        self.assertEqual(A1, self.state()["tenants"]["pr-1"]["active"])
        self.assertFalse(list(self.root.glob(".incoming-*")))

    def test_atomic_registry_replace_failure_preserves_previous_pointer(self):
        self.install()
        previous = (self.root / "registry.json").read_bytes()
        artifact, result = self.build(A2)
        with mock.patch.object(registry.os, "replace", side_effect=OSError("simulated replace failure")):
            with self.assertRaises(OSError):
                registry.install(self.root, 1, artifact, result["artifact_sha256"], self.token())
        self.assertEqual(previous, (self.root / "registry.json").read_bytes())
        self.assertTrue(self.release(1, A2).exists())
        self.assertFalse(list(self.root.glob(".registry-*")))
        registry.install(self.root, 1, artifact, result["artifact_sha256"], self.token())
        self.assertEqual(A2, self.state()["tenants"]["pr-1"]["active"])

    def test_orphan_revisions_and_other_tenants_count_toward_budgets(self):
        artifact, result = self.build(A1)
        with mock.patch.object(registry, "_write_registry", side_effect=OSError("crash")):
            with self.assertRaises(OSError):
                registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        second, built = self.build(A2)
        with self.assertRaisesRegex(registry.RegistryError, "Retained revision budget"):
            registry.install(self.root, 1, second, built["artifact_sha256"], None,
                             registry.Budget(max_revisions=1))
        registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        registry.install(self.root, 1, second, built["artifact_sha256"], self.token())
        third, built = self.build(B1)
        with self.assertRaisesRegex(registry.RegistryError, "Retained revision budget"):
            registry.install(self.root, 2, third, built["artifact_sha256"], None,
                             registry.Budget(max_revisions=1))

    def test_concurrent_promotions_lock_and_cas_allow_only_one_winner(self):
        self.install()
        token = self.token()
        children = []
        for revision in (A2, A3):
            artifact, result = self.build(revision)
            children.append(subprocess.Popen([sys.executable, str(TOOLS / "preview_registry.py"), "--root", str(self.root),
                                               "install", "--pr", "1", "--artifact", str(artifact), "--sha256", result["artifact_sha256"],
                                               "--expected-token", token], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        results = [child.communicate(timeout=20) for child in children]
        self.assertEqual([0, 1], sorted(child.returncode for child in children), results)
        state = self.state()["tenants"]["pr-1"]
        self.assertIn(state["active"], (A2, A3))
        self.assertEqual(2, len(state["releases"]))
        self.assertEqual(2, len(list((self.root / "releases/pr-1").iterdir())))

    def test_invalid_budget_identifiers_and_missing_rollback_fail(self):
        for kwargs in ({"max_active": 0}, {"max_revisions": -1}, {"max_total_bytes": True}):
            with self.assertRaises(registry.RegistryError):
                registry.Budget(**kwargs)
        for pr in (0, "01", "../x", "1;bad", 10000000000):
            with self.assertRaises(package.PackageError):
                package.checked_pr(pr)
        self.install()
        with self.assertRaisesRegex(registry.RegistryError, "Rollback target is not retained"):
            registry.rollback(self.root, 1, A2, self.token())



class StateTokenTests(PreviewTest):
    def legacy_fixture(self):
        self.install(1, A1)
        self.install(2, B1)
        registry.retire(self.root, 1, self.token(1))
        legacy = self.state()
        legacy["version"] = 1
        for record in legacy["tenants"].values():
            del record["state_token"]
        (self.root / "registry.json").write_bytes(package.canonical_json(legacy))
        return legacy

    def test_close_fences_stale_install_and_stale_rollback(self):
        self.install()
        before_close = self.token()
        closed = registry.retire(self.root, 1, before_close)
        self.assertNotEqual(before_close, closed["state_token"])
        before = (self.root / "registry.json").read_bytes()
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            self.install(1, A2, expected=before_close)
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.rollback(self.root, 1, A1, before_close)
        self.assertFalse(self.state()["tenants"]["pr-1"]["enabled"])
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertFalse(self.release(1, A2).exists())

    def test_aba_rollback_fences_prior_token_even_when_active_matches(self):
        self.install()
        original = self.token()
        second = self.install(1, A2, expected=original)
        back = registry.rollback(self.root, 1, A1, second["state_token"])
        self.assertEqual(A1, back["active"])
        self.assertEqual(3, len({original, second["state_token"], back["state_token"]}))
        before = (self.root / "registry.json").read_bytes()
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            self.install(1, A3, expected=original)
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.retire(self.root, 1, original)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertFalse(self.release(1, A3).exists())

    def test_close_before_first_install_creates_durable_disabled_tombstone(self):
        closed = registry.retire(self.root, 1, None)
        record = self.state()["tenants"]["pr-1"]
        self.assertEqual(2, self.state()["version"])
        self.assertEqual({"enabled": False, "active": None, "releases": {},
                          "state_token": closed["state_token"]}, record)
        self.assertRegex(record["state_token"], r"^[0-9a-f]{64}$")
        self.assertFalse((self.root / "releases").exists())
        self.assertFalse((self.root / "data").exists())
        before = (self.root / "registry.json").read_bytes()
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            self.install()
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.retire(self.root, 1, None)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        # A new, separately authorized open-PR intent may explicitly re-enable it.
        opened = self.install(expected=closed["state_token"])
        self.assertTrue(opened["enabled"])
        self.assertNotEqual(closed["state_token"], opened["state_token"])

    def test_install_before_close_requires_fresh_close_intent_after_conflict(self):
        installed = self.install()
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.retire(self.root, 1, None)
        self.assertTrue(self.state()["tenants"]["pr-1"]["enabled"])
        # A controller must independently confirm the PR is still closed before
        # supplying this newer token; the registry never retries automatically.
        registry.retire(self.root, 1, installed["state_token"])
        self.assertFalse(self.state()["tenants"]["pr-1"]["enabled"])

    def test_concurrent_first_install_and_retire_have_one_cas_winner(self):
        artifact, result = self.build()
        common = [sys.executable, str(TOOLS / "preview_registry.py"), "--root", str(self.root)]
        commands = [common + ["install", "--pr", "1", "--artifact", str(artifact),
                               "--sha256", result["artifact_sha256"], "--expected-token", "none"],
                    common + ["retire", "--pr", "1", "--expected-token", "none"]]
        children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for command in commands]
        results = [child.communicate(timeout=20) for child in children]
        self.assertEqual([0, 1], sorted(child.returncode for child in children), results)
        record = self.state()["tenants"]["pr-1"]
        self.assertRegex(record["state_token"], r"^[0-9a-f]{64}$")
        if children[1].returncode == 0:
            self.assertFalse(record["enabled"])
            self.assertIsNone(record["active"])
            self.assertFalse(self.release().exists())
        else:
            self.assertTrue(record["enabled"])
            self.assertEqual(A1, record["active"])
            registry.retire(self.root, 1, record["state_token"])
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        self.assertFalse(self.state()["tenants"]["pr-1"]["enabled"])

    def test_concurrent_first_installs_have_one_winner(self):
        children = []
        for revision in (A1, A2):
            artifact, result = self.build(revision)
            children.append(subprocess.Popen([sys.executable, str(TOOLS / "preview_registry.py"), "--root", str(self.root),
                                               "install", "--pr", "1", "--artifact", str(artifact),
                                               "--sha256", result["artifact_sha256"], "--expected-token", "none"],
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        results = [child.communicate(timeout=20) for child in children]
        self.assertEqual([0, 1], sorted(child.returncode for child in children), results)
        self.assertEqual(1, len(self.state()["tenants"]["pr-1"]["releases"]))
        self.assertEqual(1, len(list((self.root / "releases/pr-1").iterdir())))

    def test_tokens_rotate_only_on_real_changes_and_noops_still_require_cas(self):
        artifact, result = self.build()
        initial = registry.install(self.root, 1, artifact, result["artifact_sha256"], None)
        token = initial["state_token"]
        self.assertTrue(initial["changed"])
        for no_op in (lambda: registry.install(self.root, 1, artifact, result["artifact_sha256"], token),
                      lambda: registry.rollback(self.root, 1, A1, token)):
            before = (self.root / "registry.json").read_bytes()
            unchanged = no_op()
            self.assertFalse(unchanged["changed"])
            self.assertEqual(token, unchanged["state_token"])
            self.assertEqual(before, (self.root / "registry.json").read_bytes())
        closed = registry.retire(self.root, 1, token)
        self.assertTrue(closed["changed"])
        self.assertNotEqual(token, closed["state_token"])
        again = registry.retire(self.root, 1, closed["state_token"])
        self.assertFalse(again["changed"])
        self.assertEqual(closed["state_token"], again["state_token"])
        with self.assertRaisesRegex(registry.RegistryError, "Tenant state changed"):
            registry.retire(self.root, 1, token)

    def test_tokens_are_tenant_scoped_and_not_revision_shas(self):
        one = self.install(1, A1)
        two = self.install(2, A1)
        self.assertNotEqual(one["state_token"], two["state_token"])
        for token in (one["state_token"], A1, "", "z" * 64, "A" * 64, True):
            with self.subTest(token=token):
                with self.assertRaises(registry.RegistryError):
                    registry.retire(self.root, 2, token)
        self.assertTrue(self.state()["tenants"]["pr-2"]["enabled"])

    def test_v1_mutations_require_explicit_migration_and_preserve_records(self):
        legacy = self.legacy_fixture()
        (self.root / "data/pr-1/keep.txt").write_text("retained data")
        before = (self.root / "registry.json").read_bytes()
        artifact, result = self.build(A2)
        actions = [lambda: registry.install(self.root, 1, artifact, result["artifact_sha256"], None),
                   lambda: registry.rollback(self.root, 1, A1, None),
                   lambda: registry.retire(self.root, 1, None)]
        for action in actions:
            with self.assertRaisesRegex(registry.RegistryError, "explicit migrate-v1"):
                action()
            self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertEqual(legacy, registry.status(self.root)["registry"])
        migrated = registry.migrate_v1(self.root)
        self.assertTrue(migrated["migrated"])
        state = self.state()
        self.assertEqual(2, state["version"])
        self.assertEqual(2, len({r["state_token"] for r in state["tenants"].values()}))
        for tenant, old in legacy["tenants"].items():
            current = dict(state["tenants"][tenant])
            self.assertRegex(current.pop("state_token"), r"^[0-9a-f]{64}$")
            self.assertEqual(old, current)
        self.assertEqual("retained data", (self.root / "data/pr-1/keep.txt").read_text())
        self.assertTrue(self.release(1, A1).exists())
        self.assertTrue(self.release(2, B1).exists())
        again = registry.migrate_v1(self.root)
        self.assertFalse(again["migrated"])
        self.assertEqual(state, self.state())

    def test_migration_failure_preserves_legacy_registry_and_data(self):
        self.legacy_fixture()
        before = (self.root / "registry.json").read_bytes()
        with mock.patch.object(registry.os, "replace", side_effect=OSError("replace failure")):
            with self.assertRaises(OSError):
                registry.migrate_v1(self.root)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())
        self.assertTrue(self.release(1, A1).exists())
        self.assertTrue(registry.migrate_v1(self.root)["migrated"])

    def test_concurrent_migrations_do_not_rotate_tokens_twice(self):
        self.legacy_fixture()
        command = [sys.executable, str(TOOLS / "preview_registry.py"), "--root", str(self.root), "migrate-v1"]
        children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        results = [child.communicate(timeout=20) for child in children]
        self.assertEqual([0, 0], [child.returncode for child in children], results)
        data = [json.loads(out) for out, error in results]
        self.assertEqual([False, True], sorted(item["migrated"] for item in data))
        self.assertEqual(data[0]["registry"], data[1]["registry"])

    def test_old_active_only_cli_and_api_writes_are_rejected_after_migration(self):
        self.legacy_fixture()
        registry.migrate_v1(self.root)
        before = (self.root / "registry.json").read_bytes()
        result = subprocess.run([sys.executable, str(TOOLS / "preview_registry.py"), "--root", str(self.root),
                                 "retire", "--pr", "1", "--expected-active", A1], capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("--expected-token", result.stderr)
        with self.assertRaises(registry.RegistryError):
            registry.retire(self.root, 1, A1)
        with self.assertRaises(TypeError):
            registry.retire(self.root, 1, expected_active=A1)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())

    def test_v2_tombstone_schema_and_token_validation_fail_closed(self):
        registry.retire(self.root, 1, None)
        original = self.state()
        changes = [lambda r: r.update(enabled=True), lambda r: r.update(state_token=None),
                   lambda r: r.pop("state_token"), lambda r: r.update(active=A1),
                   lambda r: r.update(releases={A1: {"artifact_sha256": "a" * 64, "manifest_sha256": "b" * 64}})]
        for mutate in changes:
            value = copy.deepcopy(original)
            mutate(value["tenants"]["pr-1"])
            with self.assertRaises(registry.RegistryError):
                registry._validate_registry(value)
        legacy = copy.deepcopy(original)
        legacy["version"] = 1
        del legacy["tenants"]["pr-1"]["state_token"]
        with self.assertRaises(registry.RegistryError):
            registry._validate_registry(legacy, allow_legacy=True)

    def test_random_token_collision_fails_closed_without_registry_mutation(self):
        self.install()
        before = (self.root / "registry.json").read_bytes()
        with mock.patch.object(registry.secrets, "token_hex", return_value=self.token()) as random:
            with self.assertRaisesRegex(registry.RegistryError, "token did not change"):
                registry.retire(self.root, 1, self.token())
            random.assert_called_once_with(32)
        self.assertEqual(before, (self.root / "registry.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
