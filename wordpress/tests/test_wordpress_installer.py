#!/usr/bin/env python3
"""Standard-library tests for the WordPress ZIP adapter, not live WP installation."""
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
import wordpress_installer as installer

REVISION = "a" * 40
OTHER_REVISION = "b" * 40


class WordPressInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        (self.source / "static").mkdir(parents=True)
        (self.source / "pbin.php").write_bytes(b"<?php\n/**\n * Plugin Name: pbin\n * Version: 1.0\n */\n")
        (self.source / "runtime.php").write_bytes(b"<?php /* trusted runtime */\n")
        (self.source / "static/runner.wasm").write_bytes(b"\x00asm" + bytes(range(256)) * 32)
        self.canonical = self.root / "canonical.zip"
        self.canonical_info = package.build_package(self.source, REVISION, self.canonical)
        self.canonical_digest = self.canonical_info["artifact_sha256"]
        self.output = self.root / "wordpress.zip"
        self.receipt = self.root / "wordpress.json"

    def tearDown(self):
        self.temp.cleanup()

    def build(self):
        # Tests deliberately reset only their own scratch fixtures. The public
        # builder itself must never overwrite any existing destination.
        for path in (self.output, self.receipt):
            if os.path.lexists(path):
                path.unlink()
        return installer.build_installer(self.canonical, self.canonical_digest, REVISION, self.output, self.receipt)

    def verify(self):
        return installer.verify_installer(self.output, self.receipt, self.canonical, self.canonical_digest, REVISION)

    def read_receipt(self):
        return json.loads(self.receipt.read_text())

    def write_receipt(self, value):
        self.receipt.write_bytes(package.canonical_json(value))

    def entries(self):
        with zipfile.ZipFile(self.output) as archive:
            return [(entry, archive.read(entry)) for entry in archive.infolist()]

    def rewrite(self, entries, forge_receipt=True):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.output, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, data in entries:
                    archive.writestr(name, data)
        if forge_receipt:
            value = self.read_receipt()
            value["installer_sha256"] = package.file_sha256(self.output)
            self.write_receipt(value)

    def test_deterministic_zip_and_receipt_contain_only_exact_canonical_payload(self):
        before = self.canonical.read_bytes()
        first = self.build()
        other_zip, other_receipt = self.root / "other.zip", self.root / "other.json"
        second = installer.build_installer(self.canonical, self.canonical_digest, REVISION, other_zip, other_receipt)
        self.assertEqual(self.output.read_bytes(), other_zip.read_bytes())
        self.assertEqual(self.receipt.read_bytes(), other_receipt.read_bytes())
        self.assertEqual(first["installer_sha256"], second["installer_sha256"])
        self.assertEqual(first["receipt_sha256"], second["receipt_sha256"])
        self.assertEqual(before, self.canonical.read_bytes(), "canonical envelope must not be changed")
        with package.open_verified_package(self.canonical, self.canonical_digest) as canonical:
            with zipfile.ZipFile(self.output) as archive:
                self.assertEqual(sorted(canonical.manifest["files"]), archive.namelist())
                self.assertNotIn("manifest.json", archive.namelist())
                for entry in archive.infolist():
                    self.assertTrue(entry.filename.startswith("pbin/"))
                    self.assertEqual(canonical.archive.read(entry.filename), archive.read(entry))
                    self.assertEqual((1980, 1, 1, 0, 0, 0), entry.date_time)
                    self.assertEqual(stat.S_IFREG | 0o644, entry.external_attr >> 16)
                    self.assertEqual(zipfile.ZIP_STORED, entry.compress_type)
            self.assertEqual(canonical.manifest["files"], self.read_receipt()["files"])
            self.assertEqual(canonical.manifest_sha256, self.read_receipt()["canonical_manifest_sha256"])
        self.assertEqual(first, self.verify())

    def test_real_runtime_assets_preserve_all_bytes(self):
        source = TOOLS.parent / "pbin"
        info = package.build_package(source, REVISION, self.canonical)
        self.canonical_digest = info["artifact_sha256"]
        result = self.build()
        self.assertEqual(info["file_count"], result["file_count"])
        self.verify()
        with zipfile.ZipFile(self.output) as archive:
            for file in source.rglob("*"):
                if file.is_file():
                    self.assertEqual(file.read_bytes(), archive.read("pbin/" + file.relative_to(source).as_posix()))
            for name in ("ocaml/toplevel.js", "picat/picat.wasm", "quickjs/qjs-wasi.wasm", "tla-checker/tla_checker_bg.wasm"):
                self.assertIn("pbin/static/wasm/" + name, archive.namelist())

    def test_receipt_binds_installer_canonical_manifest_revision_and_inventory(self):
        result = self.build()
        value = self.read_receipt()
        self.assertEqual(installer.RECEIPT_FIELDS, set(value))
        self.assertEqual(1, value["version"])
        self.assertEqual("pbin-wordpress-installer", value["format"])
        self.assertEqual(REVISION, value["revision"])
        self.assertEqual(self.canonical_digest, value["canonical_artifact_sha256"])
        self.assertEqual(self.canonical_info["manifest_sha256"], value["canonical_manifest_sha256"])
        self.assertEqual(package.file_sha256(self.output), value["installer_sha256"])
        self.assertEqual(package.file_sha256(self.receipt), result["receipt_sha256"])

    def test_wrong_trusted_canonical_digest_and_revision_fail_before_output(self):
        for digest, revision in (("0" * 64, REVISION), (self.canonical_digest, OTHER_REVISION),
                                 (self.canonical_digest, "short")):
            with self.subTest(digest=digest, revision=revision):
                with self.assertRaises(package.PackageError):
                    installer.build_installer(self.canonical, digest, revision, self.output, self.receipt)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.receipt.exists())

    def test_wrong_canonical_at_verification_is_rejected(self):
        self.build()
        with self.assertRaises(package.PackageError):
            installer.verify_installer(self.output, self.receipt, self.canonical, "0" * 64, REVISION)
        with self.assertRaises(package.PackageError):
            installer.verify_installer(self.output, self.receipt, self.canonical, self.canonical_digest, OTHER_REVISION)

    def test_reuses_canonical_strict_checks_for_bad_input_envelope(self):
        original = self.canonical.read_bytes()
        attacks = [("../outside.php", b"bad"), ("pbin/runtime.php", b"duplicate"),
                   ("registry.json", b"control plane")]
        link = zipfile.ZipInfo("pbin/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        attacks.append((link, b"../outside"))
        for entry in attacks:
            with self.subTest(entry=entry[0]):
                self.canonical.write_bytes(original)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    with zipfile.ZipFile(self.canonical, "a") as archive:
                        archive.writestr(*entry)
                digest = package.file_sha256(self.canonical)
                with self.assertRaises(package.PackageError):
                    installer.build_installer(self.canonical, digest, REVISION, self.output, self.receipt)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.receipt.exists())

    def test_payload_tampering_is_rejected_with_original_or_forged_receipt(self):
        self.build()
        entries = [(entry, b"evil" if entry.filename == "pbin/runtime.php" else data) for entry, data in self.entries()]
        self.rewrite(entries, forge_receipt=False)
        with self.assertRaises(package.PackageError):
            self.verify()
        value = self.read_receipt()
        value["installer_sha256"] = package.file_sha256(self.output)
        value["files"]["pbin/runtime.php"] = {"size": 4, "sha256": hashlib.sha256(b"evil").hexdigest()}
        self.write_receipt(value)
        with self.assertRaisesRegex(package.PackageError, "verified canonical derivative"):
            self.verify()

    def test_extra_missing_duplicate_case_collision_and_root_manifest_are_rejected(self):
        self.build()
        baseline = self.entries()
        cases = {
            "extra": baseline + [("pbin/extra.php", b"extra")],
            "missing": [entry for entry in baseline if entry[0].filename != "pbin/runtime.php"],
            "duplicate": baseline + [("pbin/runtime.php", b"duplicate")],
            "case-collision": baseline + [("pbin/RUNTIME.php", b"duplicate")],
            "root-manifest": baseline + [("manifest.json", b"{}")],
        }
        for name, entries in cases.items():
            with self.subTest(name=name):
                self.build()
                self.rewrite(entries)
                with self.assertRaises(package.PackageError):
                    self.verify()

    def test_traversal_absolute_windows_and_control_plane_entries_are_rejected(self):
        self.build()
        baseline = self.entries()
        paths = ["../escape.php", "/tmp/escape.php", "pbin/../../escape.php", "pbin\\evil.php", "C:/escape.php",
                 "pbin//evil.php", "pbin/./evil.php", "pbin/.htaccess", "preview/loader.php", "pbin/preview/loader.php"]
        for path in paths:
            with self.subTest(path=path):
                self.build()
                self.rewrite(baseline + [(path, b"evil")])
                with self.assertRaises(package.PackageError):
                    self.verify()
        self.assertFalse((self.root / "escape.php").exists())

    def test_symlink_special_file_and_directory_entries_are_rejected(self):
        self.build()
        baseline = self.entries()
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFDIR):
            with self.subTest(kind=kind):
                self.build()
                info = zipfile.ZipInfo("pbin/evil")
                info.create_system = 3
                info.external_attr = (kind | 0o777) << 16
                self.rewrite(baseline + [(info, b"../target")])
                with self.assertRaises(package.PackageError):
                    self.verify()

    def test_zip_metadata_tampering_and_trailing_bytes_are_rejected(self):
        self.build()
        entries = self.entries()
        entries[0][0].date_time = (2020, 1, 1, 0, 0, 0)
        self.rewrite(entries)
        with self.assertRaises(package.PackageError):
            self.verify()
        self.build()
        with self.output.open("ab") as stream:
            stream.write(b"unapproved trailer")
        with self.assertRaises(package.PackageError):
            self.verify()

    def test_receipt_tampering_extra_missing_fields_and_wrong_types_are_rejected(self):
        self.build()
        original = self.read_receipt()
        mutations = [lambda r: r.update(installer_sha256="0" * 64),
                     lambda r: r.update(canonical_artifact_sha256="0" * 64),
                     lambda r: r.update(canonical_manifest_sha256="0" * 64),
                     lambda r: r.update(revision=OTHER_REVISION), lambda r: r.update(version=True),
                     lambda r: r.update(format="other"), lambda r: r.update(extra="unapproved"),
                     lambda r: r.pop("canonical_manifest_sha256"),
                     lambda r: r["files"].pop("pbin/runtime.php"),
                     lambda r: r["files"]["pbin/runtime.php"].update(size=True),
                     lambda r: r["files"].update({"../escape": {"size": 1, "sha256": "a" * 64}})]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                value = copy.deepcopy(original)
                mutate(value)
                self.write_receipt(value)
                with self.assertRaises(package.PackageError):
                    self.verify()

    def test_receipt_duplicate_json_keys_and_oversized_inputs_are_rejected(self):
        self.build()
        raw = self.receipt.read_bytes()
        self.receipt.write_bytes(raw.replace(b'{"canonical_artifact_sha256":', b'{"version":1,"canonical_artifact_sha256":', 1))
        with self.assertRaises(package.PackageError):
            self.verify()
        self.receipt.write_bytes(b" " * (package.Limits().max_manifest_bytes + 1025))
        with self.assertRaises(package.PackageError):
            self.verify()
        self.build()
        maximum = self.canonical.stat().st_size + 1
        self.output.write_bytes(b"x" * (maximum + 1))
        with self.assertRaises(package.PackageError):
            installer.verify_installer(self.output, self.receipt, self.canonical, self.canonical_digest,
                                       REVISION, package.Limits(max_archive_bytes=maximum))

    def test_same_payload_at_another_revision_still_requires_matching_receipt(self):
        first = self.build()
        other_canonical = self.root / "other-canonical.zip"
        info = package.build_package(self.source, OTHER_REVISION, other_canonical)
        other_zip, other_receipt = self.root / "other.zip", self.root / "other.json"
        second = installer.build_installer(other_canonical, info["artifact_sha256"], OTHER_REVISION, other_zip, other_receipt)
        self.assertEqual(first["installer_sha256"], second["installer_sha256"], "payload identity is independent of revision label")
        self.assertNotEqual(first["receipt_sha256"], second["receipt_sha256"])
        with self.assertRaises(package.PackageError):
            installer.verify_installer(self.output, self.receipt, other_canonical, info["artifact_sha256"], OTHER_REVISION)

    def test_distinct_output_paths_protect_canonical_envelope(self):
        original = self.canonical.read_bytes()
        for output, receipt in ((self.canonical, self.receipt), (self.output, self.canonical), (self.output, self.output)):
            with self.subTest(output=output, receipt=receipt):
                with self.assertRaises(package.PackageError):
                    installer.build_installer(self.canonical, self.canonical_digest, REVISION, output, receipt)
                self.assertEqual(original, self.canonical.read_bytes())
        alias = self.root / "alias.zip"
        alias.symlink_to(self.canonical)
        with self.assertRaises(package.PackageError):
            installer.build_installer(self.canonical, self.canonical_digest, REVISION, alias, self.receipt)
        alias.unlink()
        os.link(self.canonical, alias)
        with self.assertRaises(package.PackageError):
            installer.build_installer(self.canonical, self.canonical_digest, REVISION, alias, self.receipt)
        self.assertEqual(original, self.canonical.read_bytes())

    def test_symlinked_and_missing_inputs_are_rejected(self):
        self.build()
        for target in (self.output, self.receipt, self.canonical):
            with self.subTest(target=target):
                moved = target.with_suffix(target.suffix + ".original")
                target.rename(moved)
                target.symlink_to(moved)
                with self.assertRaises((package.PackageError, OSError)):
                    self.verify()
                target.unlink()
                with self.assertRaises(OSError):
                    self.verify()
                moved.rename(target)
        self.verify()

    def test_interrupted_publication_retains_safe_incomplete_output(self):
        incomplete_zip, incomplete_receipt = self.root / "incomplete.zip", self.root / "incomplete.json"
        real_link = os.link
        calls = []
        def interrupted(source, destination, **kwargs):
            calls.append(destination)
            if len(calls) == 2:
                raise OSError("simulated receipt publication failure")
            real_link(source, destination, **kwargs)
        with mock.patch.object(installer.os, "link", side_effect=interrupted):
            with self.assertRaises(OSError):
                installer.build_installer(self.canonical, self.canonical_digest, REVISION, incomplete_zip, incomplete_receipt)
        self.assertTrue(incomplete_zip.is_file())
        self.assertFalse(incomplete_receipt.exists())
        retained = incomplete_zip.read_bytes()
        with self.assertRaises(OSError):
            installer.verify_installer(incomplete_zip, incomplete_receipt, self.canonical, self.canonical_digest, REVISION)
        with self.assertRaises(package.PackageError):
            installer.build_installer(self.canonical, self.canonical_digest, REVISION, incomplete_zip, incomplete_receipt)
        self.assertEqual(retained, incomplete_zip.read_bytes())
        self.assertFalse(list(self.root.glob(".wordpress-*")))
        self.build()  # A new pair of destinations is safe to use for recovery.
        self.verify()

    def test_existing_and_dangling_outputs_are_refused_before_work(self):
        for path in (self.output, self.receipt):
            for dangling in (False, True):
                with self.subTest(path=path, dangling=dangling):
                    if dangling:
                        path.symlink_to(self.root / "absent-target")
                    else:
                        path.write_bytes(b"preserve existing bytes")
                    with mock.patch.object(package, "open_verified_package") as opened:
                        with self.assertRaises(package.PackageError):
                            installer.build_installer(self.canonical, self.canonical_digest, REVISION, self.output, self.receipt)
                        opened.assert_not_called()
                    if dangling:
                        self.assertTrue(path.is_symlink())
                        self.assertEqual(self.root / "absent-target", path.readlink())
                    else:
                        self.assertEqual(b"preserve existing bytes", path.read_bytes())
                    other = self.receipt if path == self.output else self.output
                    self.assertFalse(os.path.lexists(other))
                    path.unlink()

    def test_symlinked_output_parents_are_refused(self):
        actual = self.root / "actual"
        actual.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(actual, target_is_directory=True)
        for output, receipt in ((alias / "plugin.zip", self.receipt), (self.output, alias / "receipt.json")):
            with self.subTest(output=output, receipt=receipt):
                with self.assertRaises(package.PackageError):
                    installer.build_installer(self.canonical, self.canonical_digest, REVISION, output, receipt)
                self.assertEqual([], list(actual.iterdir()))
                self.assertFalse(self.output.exists())
                self.assertFalse(self.receipt.exists())
        new_output = self.root / "new/subdir/plugin.zip"
        new_receipt = self.root / "new/other/receipt.json"
        installer.build_installer(self.canonical, self.canonical_digest, REVISION, new_output, new_receipt)
        installer.verify_installer(new_output, new_receipt, self.canonical, self.canonical_digest, REVISION)

    def test_exclusive_publication_cannot_clobber_racing_file_or_symlink(self):
        real_link = os.link
        for position in (1, 2):
            for dangling in (False, True):
                with self.subTest(position=position, dangling=dangling):
                    for path in (self.output, self.receipt):
                        if os.path.lexists(path):
                            path.unlink()
                    calls = []
                    def race(source, destination, **kwargs):
                        calls.append(destination)
                        if len(calls) == position:
                            if dangling:
                                Path(destination).symlink_to(self.root / "absent-race-target")
                            else:
                                Path(destination).write_bytes(b"racing owner")
                        real_link(source, destination, **kwargs)
                    with mock.patch.object(installer.os, "link", side_effect=race):
                        with self.assertRaises(FileExistsError):
                            installer.build_installer(self.canonical, self.canonical_digest, REVISION, self.output, self.receipt)
                    target = self.output if position == 1 else self.receipt
                    if dangling:
                        self.assertTrue(target.is_symlink())
                        self.assertEqual(self.root / "absent-race-target", target.readlink())
                    else:
                        self.assertEqual(b"racing owner", target.read_bytes())
                    if position == 2:
                        self.assertTrue(self.output.is_file(), "first exclusively published ZIP must be retained")
                    self.assertFalse(list(self.root.glob(".wordpress-*")))

    def test_build_and_verify_cli_contract(self):
        shared = ["--canonical", str(self.canonical), "--canonical-sha256", self.canonical_digest,
                  "--revision", REVISION, "--receipt", str(self.receipt)]
        command = [sys.executable, str(TOOLS / "wordpress_installer.py")]
        result = subprocess.run(command + ["build", "--output", str(self.output), *shared], text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)
        built = json.loads(result.stdout)
        verified = subprocess.run(command + ["verify", "--installer", str(self.output), *shared], text=True, capture_output=True)
        self.assertEqual(0, verified.returncode, verified.stderr)
        self.assertEqual(built, json.loads(verified.stdout))
        self.output.write_bytes(b"not a ZIP")
        rejected = subprocess.run(command + ["verify", "--installer", str(self.output), *shared], text=True, capture_output=True)
        self.assertEqual(1, rejected.returncode)
        self.assertIn("WordPress installer rejected:", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
