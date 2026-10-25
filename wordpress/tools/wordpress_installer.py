#!/usr/bin/env python3
"""Derive and verify WordPress-installer ZIPs without changing canonical packages.

The canonical envelope has a root manifest.json and pbin/**. WordPress's normal
Plugin_Upgrader requires the distributable to contain only pbin/**. This adapter
copies the verified payload byte-for-byte into a deterministic ZIP and writes a
separate, deterministic receipt. The receipt is not a signature or authorization:
verification requires the canonical envelope and its independently trusted digest.

Examples:
  wordpress_installer.py build --canonical pbin.zip --canonical-sha256 DIGEST \
    --revision SHA --output pbin-wordpress.zip --receipt pbin-wordpress.json
  wordpress_installer.py verify --installer pbin-wordpress.zip \
    --receipt pbin-wordpress.json --canonical pbin.zip \
    --canonical-sha256 DIGEST --revision SHA

Both commands print a JSON summary. Build requires new output and receipt paths,
refuses symlinked parent directories, and publishes exclusively without overwrite.
If publication is interrupted after the ZIP appears, that incomplete output is
retained safely; inspect it and choose new destinations for retry. Verification
rejects incomplete or mismatched pairs. Neither command installs, activates,
uploads, or executes plugin PHP. Verify immediately before consuming locally controlled files;
a successful check does not protect a pathname from a subsequent external write.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from typing import BinaryIO
import zipfile

import package

FORMAT = "pbin-wordpress-installer"
RECEIPT_FIELDS = {"version", "format", "revision", "canonical_artifact_sha256",
                  "canonical_manifest_sha256", "installer_sha256", "files"}


def _read_regular(path: Path | str, maximum: int) -> bytes:
    """Read bounded bytes once without following a symlink or blocking on a FIFO."""
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise package.PackageError("Input must be a regular file within its size limit")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            data = stream.read(maximum + 1)
            if len(data) > maximum:
                raise package.PackageError("Input exceeds its size limit")
            return data
    finally:
        if descriptor != -1:
            os.close(descriptor)


def _hash_regular(path: Path | str, maximum: int) -> tuple[str, int]:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise package.PackageError("Installer must be a regular file within the archive size limit")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            return package._hash_stream(stream, maximum)
    finally:
        if descriptor != -1:
            os.close(descriptor)


def _distinct_paths(canonical: Path, installer: Path, receipt: Path):
    paths = (canonical, installer, receipt)
    for index, path in enumerate(paths):
        for other in paths[index + 1:]:
            if path.resolve() == other.resolve() or (path.exists() and other.exists() and os.path.samefile(path, other)):
                raise package.PackageError("Canonical artifact, installer and receipt must use distinct files")


def _check_destination(path: Path, create_parents: bool = False):
    if os.path.lexists(path):
        raise package.PackageError("Output already exists; choose a new destination: " + str(path))
    parent = path.parent
    for directory in [*reversed(parent.parents), parent]:
        try:
            mode = directory.lstat().st_mode
        except FileNotFoundError:
            if not create_parents:
                break
            directory.mkdir(mode=0o755, exist_ok=True)
            mode = directory.lstat().st_mode
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
            raise package.PackageError("Output parent must contain only real directories: " + str(directory))


def _publish_new(temporary: str, target: Path):
    _check_destination(target)
    # The exclusive link itself, not the preflight exists check, prevents a
    # competing creator (including a dangling symlink) from being overwritten.
    os.link(temporary, target, follow_symlinks=False)
    descriptor = os.open(target.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                         | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _derive(verified: package.VerifiedPackage, stream: BinaryIO) -> tuple[str, int]:
    """Use canonical validation/metadata helpers, copying only approved payload."""
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, record in sorted(verified.manifest["files"].items()):
            # validate_manifest already limits names to safe pbin/** files and
            # rejects duplicates, traversal, configuration and control-plane files.
            with verified.archive.open(name, "r") as source, archive.open(package._zip_info(name), "w") as target:
                digest, size = package._hash_stream(source, record["size"], target)
            if {"sha256": digest, "size": size} != record:
                raise package.PackageError("Canonical payload changed during installer derivation")
    stream.flush()
    if stream.tell() > verified.limits.max_archive_bytes:
        raise package.PackageError("Installer exceeds archive size limit")
    stream.seek(0)
    return package._hash_stream(stream, verified.limits.max_archive_bytes)


def _receipt(verified: package.VerifiedPackage, installer_sha256: str) -> dict:
    return {"version": 1, "format": FORMAT, "revision": verified.revision,
            "canonical_artifact_sha256": verified.artifact_sha256,
            "canonical_manifest_sha256": verified.manifest_sha256,
            "installer_sha256": installer_sha256, "files": verified.manifest["files"]}


def _validate_receipt(data: bytes, limits: package.Limits) -> dict:
    receipt = package.strict_json(data)
    if not isinstance(receipt, dict) or set(receipt) != RECEIPT_FIELDS:
        raise package.PackageError("Unsupported installer receipt fields")
    if type(receipt["version"]) is not int or receipt["version"] != 1 or receipt["format"] != FORMAT:
        raise package.PackageError("Unsupported installer receipt format")
    for key in ("canonical_artifact_sha256", "canonical_manifest_sha256", "installer_sha256"):
        package.checked_digest(receipt[key])
    # Reuse the canonical manifest schema and bounds, not a second path/inventory
    # parser with potentially weaker validation rules.
    package.validate_manifest(package.canonical_json({"version": 1, "revision": receipt["revision"],
                                                     "files": receipt["files"]}), limits)
    return receipt


def _summary(value: dict, receipt_data: bytes, installer: Path, receipt: Path, size: int) -> dict:
    return {"installer": str(installer), "receipt": str(receipt), "revision": value["revision"],
            "installer_sha256": value["installer_sha256"],
            "receipt_sha256": hashlib.sha256(receipt_data).hexdigest(),
            "canonical_artifact_sha256": value["canonical_artifact_sha256"],
            "canonical_manifest_sha256": value["canonical_manifest_sha256"],
            "installer_bytes": size, "file_count": len(value["files"]),
            "uncompressed_bytes": sum(record["size"] for record in value["files"].values())}


def build_installer(canonical: Path | str, canonical_sha256: str, revision: str,
                    output: Path | str, receipt: Path | str,
                    limits: package.Limits = package.Limits()) -> dict:
    """Derive a ZIP containing pbin/** only and its bound sidecar receipt."""
    package.checked_revision(revision)
    canonical, output, receipt = (Path(path).absolute() for path in (canonical, output, receipt))
    _distinct_paths(canonical, output, receipt)
    _check_destination(output)
    _check_destination(receipt)
    temporary_zip = temporary_receipt = None
    try:
        with package.open_verified_package(canonical, canonical_sha256, limits) as verified:
            if verified.revision != revision:
                raise package.PackageError("Canonical revision does not match requested revision")
            _check_destination(output, create_parents=True)
            _check_destination(receipt, create_parents=True)
            descriptor, temporary_zip = tempfile.mkstemp(prefix=".wordpress-installer-", suffix=".zip", dir=output.parent)
            with os.fdopen(descriptor, "w+b") as stream:
                digest, size = _derive(verified, stream)
                os.fsync(stream.fileno())
            value = _receipt(verified, digest)
            receipt_data = package.canonical_json(value)
            _validate_receipt(receipt_data, limits)
            if len(receipt_data) > limits.max_manifest_bytes + 1024:
                raise package.PackageError("Installer receipt exceeds size limit")
            descriptor, temporary_receipt = tempfile.mkstemp(prefix=".wordpress-receipt-", suffix=".json", dir=receipt.parent)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(receipt_data)
                stream.flush()
                os.fsync(stream.fileno())
        # Two separate files cannot be published atomically together. Publish
        # exclusively, receipt last. On failure retain any already-published file
        # instead of deleting a pathname another actor might now own. Only our
        # private temporary names are removed below; retries need new destinations.
        _publish_new(temporary_zip, output)
        _publish_new(temporary_receipt, receipt)
        return _summary(value, receipt_data, output, receipt, size)
    finally:
        for temporary in (temporary_zip, temporary_receipt):
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)


def verify_installer(installer: Path | str, receipt: Path | str, canonical: Path | str,
                     canonical_sha256: str, revision: str,
                     limits: package.Limits = package.Limits()) -> dict:
    """Verify against the exact deterministic derivative of a trusted envelope.

Do not trust the receipt's self-declared installer hash or inventory. Regenerating
from a fully verified canonical package binds every installer byte, including ZIP
structure/metadata, to the approved payload. Extra/missing/duplicate/traversal or
symlink entries therefore cannot be accepted even with a rewritten receipt.
No installer entry is extracted or executed during this check.
    """
    package.checked_revision(revision)
    canonical, installer, receipt = (Path(path).absolute() for path in (canonical, installer, receipt))
    _distinct_paths(canonical, installer, receipt)
    receipt_data = _read_regular(receipt, limits.max_manifest_bytes + 1024)
    value = _validate_receipt(receipt_data, limits)
    with package.open_verified_package(canonical, canonical_sha256, limits) as verified:
        if verified.revision != revision:
            raise package.PackageError("Canonical revision does not match requested revision")
        with tempfile.TemporaryFile(mode="w+b") as expected:
            expected_digest, expected_size = _derive(verified, expected)
        if value != _receipt(verified, expected_digest):
            raise package.PackageError("Installer receipt does not match the verified canonical derivative")
    actual_digest, size = _hash_regular(installer, limits.max_archive_bytes)
    if actual_digest != expected_digest or size != expected_size:
        raise package.PackageError("Installer bytes do not match the verified canonical derivative")
    return _summary(value, receipt_data, installer, receipt, size)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="derive a standard plugin ZIP and bound sidecar")
    build.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify", help="verify both against a trusted canonical envelope")
    verify.add_argument("--installer", type=Path, required=True)
    for command in (build, verify):
        command.add_argument("--canonical", type=Path, required=True)
        command.add_argument("--canonical-sha256", required=True)
        command.add_argument("--revision", required=True)
        command.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = build_installer(args.canonical, args.canonical_sha256, args.revision, args.output, args.receipt)
        else:
            result = verify_installer(args.installer, args.receipt, args.canonical, args.canonical_sha256, args.revision)
        print(json.dumps(result, sort_keys=True))
    except (package.PackageError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, "WordPress installer rejected: " + str(error) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
