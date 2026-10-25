#!/usr/bin/env python3
"""Deterministic, self-checking packages for trusted pbin preview revisions."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from typing import BinaryIO, Iterator
import zipfile


class PackageError(ValueError):
    """A package or its declared identity failed validation."""


REVISION_RE = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_RE = re.compile(r"[0-9a-f]{64}\Z")
PR_RE = re.compile(r"[1-9][0-9]{0,9}\Z")
MANIFEST = "manifest.json"
REQUIRED_FILES = {"pbin/pbin.php", "pbin/runtime.php"}
BLOCKED_COMPONENTS = {"mu-plugins", "preview", "releases", ".git", ".github"}
BLOCKED_NAMES = {"registry.json", ".registry.lock", "wp-config.php", ".htaccess", ".user.ini", "php.ini"}
CHUNK_SIZE = 128 * 1024


@dataclass(frozen=True)
class Limits:
    max_archive_bytes: int = 64 * 1024 * 1024
    max_expanded_bytes: int = 64 * 1024 * 1024
    max_file_bytes: int = 32 * 1024 * 1024
    max_manifest_bytes: int = 1024 * 1024
    max_files: int = 8192
    max_compression_ratio: int = 200

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in vars(self).values()):
            raise PackageError("Package limits must be positive integers")


def checked_revision(value: str) -> str:
    if not isinstance(value, str) or not REVISION_RE.fullmatch(value):
        raise PackageError("Revision must be a lowercase, full 40-character commit SHA")
    return value


def checked_digest(value: str) -> str:
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        raise PackageError("Digest must be a lowercase SHA-256 value")
    return value


def checked_pr(value: str | int) -> str:
    value = str(value)
    if not PR_RE.fullmatch(value):
        raise PackageError("PR number must be a positive integer of at most 10 digits")
    return "pr-" + value


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PackageError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def strict_json(data: bytes) -> object:
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(PackageError("Invalid JSON constant")))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackageError("Invalid JSON document") from error


def checked_path(name: str) -> str:
    if not isinstance(name, str) or len(name) > 1024 or "\\" in name:
        raise PackageError("Invalid package path")
    parts = name.split("/")
    if len(parts) > 20 or any(not part or part in {".", ".."} or len(part) > 255
                             or not re.fullmatch(r"[a-zA-Z0-9_.-]+", part) for part in parts):
        raise PackageError("Unsafe package path: " + repr(name))
    if name == MANIFEST:
        return name
    if len(parts) < 2 or parts[0] != "pbin":
        raise PackageError("Only manifest.json and pbin payload files are allowed")
    if any(part.lower() in BLOCKED_COMPONENTS or part.lower() in BLOCKED_NAMES for part in parts[1:]):
        raise PackageError("Control-plane/configuration files cannot be packaged: " + name)
    return name


def validate_manifest(data: bytes, limits: Limits = Limits()) -> dict:
    if len(data) > limits.max_manifest_bytes:
        raise PackageError("Manifest exceeds size limit")
    manifest = strict_json(data)
    if not isinstance(manifest, dict) or set(manifest) != {"version", "revision", "files"}:
        raise PackageError("Unsupported manifest fields")
    if type(manifest["version"]) is not int or manifest["version"] != 1:
        raise PackageError("Unsupported manifest version")
    checked_revision(manifest["revision"])
    files = manifest["files"]
    if not isinstance(files, dict) or not REQUIRED_FILES.issubset(files) or len(files) > limits.max_files:
        raise PackageError("Missing runtime entrypoints or excessive file count")
    folded = set()
    total = 0
    for name, record in files.items():
        checked_path(name)
        if name == MANIFEST or name.casefold() in folded:
            raise PackageError("Duplicate or reserved manifest file path")
        folded.add(name.casefold())
        if not isinstance(record, dict) or set(record) != {"sha256", "size"}:
            raise PackageError("Invalid manifest file record")
        checked_digest(record["sha256"])
        if type(record["size"]) is not int or not 0 <= record["size"] <= limits.max_file_bytes:
            raise PackageError("Invalid or excessive file size")
        total += record["size"]
    for name in files:
        parts = name.casefold().split("/")
        if any("/".join(parts[:index]) in folded for index in range(1, len(parts))):
            raise PackageError("Conflicting file and directory paths")
    if total + len(data) > limits.max_expanded_bytes:
        raise PackageError("Expanded package exceeds size limit")
    return manifest


def _hash_stream(stream: BinaryIO, maximum: int, output: BinaryIO | None = None) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(min(CHUNK_SIZE, maximum - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > maximum:
            raise PackageError("File exceeds its size limit")
        digest.update(chunk)
        if output is not None:
            output.write(chunk)
    return digest.hexdigest(), size


def file_sha256(path: Path | str) -> str:
    with open(path, "rb") as stream:
        return _hash_stream(stream, os.fstat(stream.fileno()).st_size)[0]


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.compress_type = zipfile.ZIP_STORED
    return info


def build_package(source: Path | str, revision: str, output: Path | str,
                  limits: Limits = Limits()) -> dict:
    """Package every regular source file; never silently omit symlinks or assets."""
    checked_revision(revision)
    source = Path(source).absolute()
    output = Path(output).absolute()
    if source.is_symlink() or not source.is_dir():
        raise PackageError("Source must be a real directory")
    if output.is_relative_to(source):
        raise PackageError("Package output must be outside its source tree")
    paths = {}
    for directory, directories, filenames in os.walk(source, followlinks=False):
        for name in directories + filenames:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise PackageError("Source contains a symlink or special file: " + str(path))
            if stat.S_ISREG(mode):
                archive_name = checked_path("pbin/" + path.relative_to(source).as_posix())
                paths[archive_name] = path
    files = {}
    for name, path in sorted(paths.items()):
        with path.open("rb") as stream:
            digest, size = _hash_stream(stream, limits.max_file_bytes)
        files[name] = {"sha256": digest, "size": size}
    manifest_data = canonical_json({"version": 1, "revision": revision, "files": files})
    validate_manifest(manifest_data, limits)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".pbin-package-", suffix=".zip", dir=output.parent)
    try:
        with os.fdopen(fd, "w+b") as stream:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
                archive.writestr(_zip_info(MANIFEST), manifest_data)
                for name, path in sorted(paths.items()):
                    with path.open("rb") as original, archive.open(_zip_info(name), "w") as target:
                        digest, size = _hash_stream(original, limits.max_file_bytes, target)
                    if {"sha256": digest, "size": size} != files[name]:
                        raise PackageError("Source changed while packaging: " + name)
            if stream.tell() > limits.max_archive_bytes:
                raise PackageError("Archive exceeds size limit")
            stream.flush()
            os.fsync(stream.fileno())
        digest = file_sha256(temporary)
        os.replace(temporary, output)
        return {"artifact": str(output), "artifact_sha256": digest, "revision": revision,
                "manifest_sha256": hashlib.sha256(manifest_data).hexdigest(), "file_count": len(files),
                "uncompressed_bytes": sum(record["size"] for record in files.values()) + len(manifest_data)}
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class VerifiedPackage:
    def __init__(self, archive: zipfile.ZipFile, digest: str, limits: Limits):
        self.archive = archive
        self.artifact_sha256 = digest
        self.limits = limits
        entries = archive.infolist()
        if len(entries) > limits.max_files + 1:
            raise PackageError("Archive has too many files")
        names = set()
        total = 0
        for entry in entries:
            name = checked_path(entry.filename)
            if entry.orig_filename != name or name.casefold() in names:
                raise PackageError("Duplicate or NUL-containing ZIP filename")
            names.add(name.casefold())
            mode = entry.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or entry.is_dir() or entry.external_attr & 0x10:
                raise PackageError("Only regular files are allowed in packages")
            if entry.flag_bits & (1 | 0x40) or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise PackageError("Encrypted or unsupported ZIP entry")
            maximum = limits.max_manifest_bytes if name == MANIFEST else limits.max_file_bytes
            if entry.file_size > maximum or entry.file_size < 0 or entry.compress_size < 0:
                raise PackageError("ZIP entry exceeds size limit")
            if entry.file_size > max(1, entry.compress_size) * limits.max_compression_ratio:
                raise PackageError("Suspicious ZIP compression ratio")
            total += entry.file_size
        if total > limits.max_expanded_bytes:
            raise PackageError("Expanded archive exceeds size limit")
        if MANIFEST not in names:
            raise PackageError("Missing manifest")
        self.manifest_data = archive.read(MANIFEST)
        self.manifest = validate_manifest(self.manifest_data, limits)
        self.manifest_sha256 = hashlib.sha256(self.manifest_data).hexdigest()
        if {entry.filename for entry in entries} != set(self.manifest["files"]) | {MANIFEST}:
            raise PackageError("Manifest does not match ZIP inventory")
        for name, record in self.manifest["files"].items():
            if archive.getinfo(name).file_size != record["size"]:
                raise PackageError("ZIP and manifest file sizes disagree")
        self.uncompressed_bytes = total
        self.revision = self.manifest["revision"]
        self.verify()

    def extract(self, destination: Path | str):
        """Extract only to a newly created directory under an existing real parent."""
        destination = Path(destination).absolute()
        if destination.parent.resolve(strict=True) != destination.parent:
            raise PackageError("Extraction parent must not contain symlinks")
        destination.mkdir(mode=0o755)  # Exclusive creation; never reuse a directory.
        try:
            self.verify(destination)
        except BaseException:
            shutil.rmtree(destination)
            raise

    def verify(self, destination: Path | None = None):
        for name, record in self.manifest["files"].items():
            with self.archive.open(name) as source:
                if destination is None:
                    digest, size = _hash_stream(source, record["size"])
                else:
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("xb") as output:
                        digest, size = _hash_stream(source, record["size"], output)
                        output.flush()
                        os.fsync(output.fileno())
            if digest != record["sha256"] or size != record["size"]:
                raise PackageError("Payload checksum mismatch: " + name)
        if destination is not None:
            with (destination / MANIFEST).open("xb") as output:
                output.write(self.manifest_data)
                output.flush()
                os.fsync(output.fileno())


@contextmanager
def open_verified_package(path: Path | str, expected_sha256: str,
                          limits: Limits = Limits()) -> Iterator[VerifiedPackage]:
    checked_digest(expected_sha256)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limits.max_archive_bytes:
            raise PackageError("Artifact must be a regular file within the archive size limit")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            # Validate and extract the same private snapshot, even if the source
            # artifact is replaced or modified concurrently by an uploader.
            with tempfile.TemporaryFile(mode="w+b") as snapshot:
                digest, _ = _hash_stream(stream, limits.max_archive_bytes, snapshot)
                if digest != expected_sha256:
                    raise PackageError("Artifact SHA-256 mismatch")
                snapshot.seek(0)
                with zipfile.ZipFile(snapshot, "r") as archive:
                    yield VerifiedPackage(archive, digest, limits)
    except (zipfile.BadZipFile, KeyError, RuntimeError, NotImplementedError, EOFError) as error:
        raise PackageError("Invalid ZIP package: " + str(error)) from error
    finally:
        if descriptor != -1:
            os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "pbin")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path, metavar="ZIP")
    parser.add_argument("--sha256")
    parser.add_argument("--extract-to", type=Path)
    args = parser.parse_args()
    try:
        if args.verify is not None:
            if args.output is not None or args.sha256 is None:
                raise PackageError("Verification requires --sha256 and cannot use --output")
            with open_verified_package(args.verify, args.sha256) as package:
                if package.revision != checked_revision(args.revision):
                    raise PackageError("Artifact revision does not match requested revision")
                if args.extract_to is not None:
                    package.extract(args.extract_to)
                result = {"artifact_sha256": package.artifact_sha256, "revision": package.revision,
                          "manifest_sha256": package.manifest_sha256,
                          "file_count": len(package.manifest["files"]),
                          "uncompressed_bytes": package.uncompressed_bytes}
        else:
            if args.output is None or args.sha256 is not None or args.extract_to is not None:
                raise PackageError("Build requires --output; verification flags require --verify")
            result = build_package(args.source, args.revision, args.output)
        print(json.dumps(result, sort_keys=True))
    except (PackageError, OSError) as error:
        parser.exit(1, "Package rejected: " + str(error) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
