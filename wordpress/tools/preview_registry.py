#!/usr/bin/env python3
"""Trusted, local staging installer. Never run this control plane from a PR ZIP."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import re
import secrets
import os
from pathlib import Path
import shutil
import stat
import tempfile

from package import (Limits, MANIFEST, PackageError, canonical_json, checked_digest,
                     checked_pr, checked_revision, file_sha256,
                     open_verified_package, strict_json, validate_manifest)


class RegistryError(PackageError):
    pass


@dataclass(frozen=True)
class Budget:
    max_active: int = 2
    max_revisions: int = 3
    max_total_bytes: int = 256 * 1024 * 1024

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in vars(self).values()):
            raise RegistryError("Budgets must be positive integers")


def _directory(path: Path, create: bool = False):
    """Refuse symlinked components, not only a symlink in the final component."""
    path = path.absolute()
    for component in [*reversed(path.parents), path]:
        try:
            mode = component.lstat().st_mode
        except FileNotFoundError:
            if not create:
                raise RegistryError("Missing directory: " + str(component))
            component.mkdir(mode=0o755, exist_ok=True)
            mode = component.lstat().st_mode
            _sync_directory(component.parent)
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
            raise RegistryError("Not a real directory: " + str(component))


def _regular(path: Path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise RegistryError("Not a single-link regular file: " + str(path))
    return metadata


def _sync_directory(path: Path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _walk_files(path: Path):
    _directory(path)
    for directory, directories, names in os.walk(path, followlinks=False):
        for name in directories:
            _directory(Path(directory) / name)
        for name in names:
            child = Path(directory) / name
            yield child, _regular(child)


TOKEN_RE = re.compile(r"[0-9a-f]{64}\Z")


def checked_token(value: str) -> str:
    if not isinstance(value, str) or not TOKEN_RE.fullmatch(value):
        raise RegistryError("State token must be an opaque 64-character lowercase hex value, not a revision SHA")
    return value


def _new_token(previous: str | None = None) -> str:
    token = checked_token(secrets.token_hex(32))
    if token == previous:
        raise RegistryError("Random state token did not change; refusing mutation")
    return token


def _validate_registry(value: object, allow_legacy: bool = False) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "tenants"}:
        raise RegistryError("Unsupported registry fields")
    version = value["version"]
    if type(version) is not int or version not in (1, 2) or not isinstance(value["tenants"], dict):
        raise RegistryError("Unsupported registry version")
    if version == 1 and not allow_legacy:
        raise RegistryError("Registry version 1 requires explicit migrate-v1 before mutations")
    for tenant, record in value["tenants"].items():
        if not isinstance(tenant, str) or not tenant.startswith("pr-") or checked_pr(tenant[3:]) != tenant:
            raise RegistryError("Invalid tenant name")
        fields = {"enabled", "active", "releases"} | ({"state_token"} if version == 2 else set())
        if not isinstance(record, dict) or set(record) != fields:
            raise RegistryError("Invalid tenant record")
        if version == 2:
            checked_token(record["state_token"])
        if type(record["enabled"]) is not bool or not isinstance(record["releases"], dict):
            raise RegistryError("Invalid tenant state")
        if record["active"] is None:
            # The only nullable-active state is an absent-before-close tombstone.
            if version != 2 or record["enabled"] or record["releases"]:
                raise RegistryError("Invalid disabled tombstone")
        else:
            checked_revision(record["active"])
            if record["active"] not in record["releases"]:
                raise RegistryError("Active revision has no release record")
        for revision, release in record["releases"].items():
            checked_revision(revision)
            if not isinstance(release, dict) or set(release) != {"artifact_sha256", "manifest_sha256"}:
                raise RegistryError("Invalid release record")
            checked_digest(release["artifact_sha256"])
            checked_digest(release["manifest_sha256"])
    return value


def _read_registry(root: Path, allow_legacy: bool = False) -> dict:
    path = root / "registry.json"
    if not os.path.lexists(path):
        return {"version": 2, "tenants": {}}
    metadata = _regular(path)
    if metadata.st_size > 1024 * 1024:
        raise RegistryError("Registry exceeds size limit")
    return _validate_registry(strict_json(path.read_bytes()), allow_legacy)


def _write_registry(root: Path, registry: dict):
    content = canonical_json(_validate_registry(registry))
    if len(content) > 1024 * 1024:
        raise RegistryError("Registry exceeds size limit")
    destination = root / "registry.json"
    if os.path.lexists(destination):
        _regular(destination)
    descriptor, temporary = tempfile.mkstemp(prefix=".registry-", dir=root)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        _sync_directory(root)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def _locked(root: Path):
    try:
        import fcntl
    except ImportError as error:
        raise RegistryError("POSIX file locking is required; no unsafe unlocked fallback") from error
    _directory(root, create=True)
    path = root / ".registry.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RegistryError("Unsafe registry lock file")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        current = path.lstat()
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise RegistryError("Registry lock was replaced")
        yield
    finally:
        os.close(descriptor)


def _check_cas(registry: dict, tenant: str, expected_token: str | None):
    if expected_token is not None:
        checked_token(expected_token)
    record = registry["tenants"].get(tenant)
    actual = record["state_token"] if record is not None else None
    if actual != expected_token:
        # Tokens are concurrency versions, not credentials. Do not offer an
        # automatic refresh: a stale deploy must revalidate its original intent.
        raise RegistryError("Tenant state changed; expected token no longer matches")


def _mutation_result(tenant: str, record: dict, changed: bool) -> dict:
    return {"tenant": tenant, "active": record["active"], "enabled": record["enabled"],
            "state_token": record["state_token"], "changed": changed}


def _disk_revisions(root: Path, tenant: str, record: dict | None) -> set[str]:
    base = root / "releases" / tenant
    result = set()
    if os.path.lexists(base):
        _directory(base)
        for path in base.iterdir():
            checked_revision(path.name)
            _directory(path)
            result.add(path.name)
    if record and not set(record["releases"]).issubset(result):
        raise RegistryError("Registered release directory is missing")
    return result


def storage_bytes(root: Path) -> int:
    """Count retained releases, tenant data, and leftovers; exclude control files."""
    total = 0
    for path, metadata in _walk_files(root):
        if path in {root / ".registry.lock", root / "registry.json"}:
            continue
        total += metadata.st_size
    return total


def _check_budget(root: Path, registry: dict, tenant: str, revision: str,
                  added_bytes: int, budget: Budget):
    active = sum(record["enabled"] for name, record in registry["tenants"].items() if name != tenant) + 1
    if active > budget.max_active:
        raise RegistryError("Active PR budget exceeded; retire a preview first")
    tenants = set(registry["tenants"]) | {tenant}
    releases = root / "releases"
    if os.path.lexists(releases):
        _directory(releases)
        for directory in releases.iterdir():
            if not directory.name.startswith("pr-") or checked_pr(directory.name[3:]) != directory.name:
                raise RegistryError("Invalid retained tenant directory")
            _directory(directory)
            tenants.add(directory.name)
    for name in tenants:
        disk = _disk_revisions(root, name, registry["tenants"].get(name))
        if name == tenant:
            disk.add(revision)
        if len(disk) > budget.max_revisions:
            raise RegistryError("Retained revision budget exceeded; no retained release was deleted")
    if storage_bytes(root) + added_bytes > budget.max_total_bytes:
        raise RegistryError("Storage budget exceeded; no retained data was deleted")


def _verify_release(directory: Path, revision: str, expected_manifest_sha256: str,
                    limits: Limits = Limits()):
    _directory(directory)
    manifest_path = directory / MANIFEST
    if _regular(manifest_path).st_size > limits.max_manifest_bytes:
        raise RegistryError("Retained manifest exceeds size limit")
    content = manifest_path.read_bytes()
    if hashlib.sha256(content).hexdigest() != expected_manifest_sha256:
        raise RegistryError("Retained manifest checksum mismatch")
    manifest = validate_manifest(content, limits)
    if manifest["revision"] != revision:
        raise RegistryError("Retained manifest revision mismatch")
    expected = set(manifest["files"]) | {MANIFEST}
    actual = {path.relative_to(directory).as_posix() for path, _ in _walk_files(directory)}
    if actual != expected:
        raise RegistryError("Retained release inventory mismatch")
    for name, record in manifest["files"].items():
        path = directory / name
        if path.stat().st_size != record["size"] or file_sha256(path) != record["sha256"]:
            raise RegistryError("Retained file checksum mismatch: " + name)


def _seal_release(directory: Path, seal_root: bool = True):
    for current, directories, filenames in os.walk(directory, topdown=False):
        for name in filenames:
            os.chmod(Path(current) / name, 0o444)
        os.chmod(current, 0o555 if seal_root or Path(current) != directory else 0o755)
        _sync_directory(Path(current))


def _remove_temporary(directory: Path):
    # This deletes only the fresh, unpublished scratch directory owned by this call.
    # It never receives a retained release or tenant data path.
    for current, directories, filenames in os.walk(directory):
        os.chmod(current, 0o700)
    shutil.rmtree(directory)


def install(root: Path | str, pr: str | int, artifact: Path | str, sha256: str,
            expected_token: str | None, budget: Budget = Budget(),
            expected_revision: str | None = None, limits: Limits = Limits()) -> dict:
    root = Path(root).absolute()
    tenant = checked_pr(pr)
    if expected_revision is not None:
        checked_revision(expected_revision)
    with open_verified_package(artifact, sha256, limits) as package:
        if expected_revision is not None and package.revision != expected_revision:
            raise RegistryError("Artifact revision does not match requested revision")
        with _locked(root):
            registry = _read_registry(root)
            _check_cas(registry, tenant, expected_token)
            record = registry["tenants"].get(tenant)
            release = {"artifact_sha256": package.artifact_sha256, "manifest_sha256": package.manifest_sha256}
            if record and package.revision in record["releases"] and record["releases"][package.revision] != release:
                raise RegistryError("Immutable revision already has a different artifact")
            destination = root / "releases" / tenant / package.revision
            existing = os.path.lexists(destination)
            if existing:
                _verify_release(destination, package.revision, package.manifest_sha256, limits)
            _check_budget(root, registry, tenant, package.revision,
                          0 if existing else package.uncompressed_bytes, budget)
            _directory(destination.parent, create=True)
            _directory(root / "data" / tenant, create=True)
            if existing:
                # A crash may have occurred after rename but before mode sealing.
                _seal_release(destination)
            if not existing:
                temporary = Path(tempfile.mkdtemp(prefix=".incoming-", dir=root))
                try:
                    package.verify(temporary)
                    _seal_release(temporary, seal_root=False)
                    # All conforming installers hold the same lock. Never replace an existing release.
                    if os.path.lexists(destination):
                        raise RegistryError("Immutable destination appeared during installation")
                    os.rename(temporary, destination)
                    os.chmod(destination, 0o555)
                    _sync_directory(destination)
                    _sync_directory(destination.parent)
                finally:
                    if temporary.exists():
                        _remove_temporary(temporary)
            changed = record is None or not record["enabled"] or record["active"] != package.revision
            if record is None:
                record = {"enabled": False, "active": None, "releases": {}, "state_token": None}
                registry["tenants"][tenant] = record
            if changed:
                record["state_token"] = _new_token(record["state_token"])
                record["releases"][package.revision] = release
                record["active"] = package.revision
                record["enabled"] = True
                _write_registry(root, registry)
            return {**_mutation_result(tenant, record, changed),
                    "artifact_sha256": package.artifact_sha256, "storage_bytes": storage_bytes(root)}


def rollback(root: Path | str, pr: str | int, revision: str, expected_token: str | None,
             budget: Budget = Budget()) -> dict:
    root = Path(root).absolute()
    tenant = checked_pr(pr)
    checked_revision(revision)
    with _locked(root):
        registry = _read_registry(root)
        _check_cas(registry, tenant, expected_token)
        record = registry["tenants"].get(tenant)
        if record is None or revision not in record["releases"]:
            raise RegistryError("Rollback target is not retained")
        _verify_release(root / "releases" / tenant / revision, revision,
                        record["releases"][revision]["manifest_sha256"])
        _check_budget(root, registry, tenant, revision, 0, budget)
        changed = not record["enabled"] or record["active"] != revision
        if changed:
            record["state_token"] = _new_token(record["state_token"])
            record["active"] = revision
            record["enabled"] = True
            _write_registry(root, registry)
        return _mutation_result(tenant, record, changed)


def retire(root: Path | str, pr: str | int, expected_token: str | None) -> dict:
    root = Path(root).absolute()
    tenant = checked_pr(pr)
    with _locked(root):
        registry = _read_registry(root)
        _check_cas(registry, tenant, expected_token)
        record = registry["tenants"].get(tenant)
        changed = record is None or record["enabled"]
        if record is None:
            record = {"enabled": False, "active": None, "releases": {}, "state_token": None}
            registry["tenants"][tenant] = record
        if changed:
            record["state_token"] = _new_token(record["state_token"])
            record["enabled"] = False
            _write_registry(root, registry)
        return _mutation_result(tenant, record, changed)


def status(root: Path | str) -> dict:
    root = Path(root).absolute()
    with _locked(root):
        return {"registry": _read_registry(root, allow_legacy=True), "storage_bytes": storage_bytes(root)}


def migrate_v1(root: Path | str) -> dict:
    """Explicit format migration, serialized with all mutations; never implicit."""
    root = Path(root).absolute()
    with _locked(root):
        registry = _read_registry(root, allow_legacy=True)
        if registry["version"] == 2:
            return {"migrated": False, "registry": registry}
        tokens = set()
        for record in registry["tenants"].values():
            token = _new_token()
            if token in tokens:
                raise RegistryError("Random migration tokens collided; refusing migration")
            tokens.add(token)
            record["state_token"] = token
        registry["version"] = 2
        _write_registry(root, registry)
        return {"migrated": True, "registry": registry}


def _expected(value: str) -> str | None:
    return None if value == "none" else checked_token(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--max-active", type=int, default=2)
    parser.add_argument("--max-revisions", type=int, default=3)
    parser.add_argument("--max-total-bytes", type=int, default=256 * 1024 * 1024)
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("install")
    add.add_argument("--pr", required=True)
    add.add_argument("--artifact", type=Path, required=True)
    add.add_argument("--sha256", required=True)
    add.add_argument("--revision")
    undo = commands.add_parser("rollback")
    undo.add_argument("--pr", required=True)
    undo.add_argument("--revision", required=True)
    remove = commands.add_parser("retire")
    remove.add_argument("--pr", required=True)
    for command in (add, undo, remove):
        command.add_argument("--expected-token", required=True)
    commands.add_parser("status")
    commands.add_parser("migrate-v1")
    args = parser.parse_args()
    try:
        budget = Budget(args.max_active, args.max_revisions, args.max_total_bytes)
        if args.command == "install":
            result = install(args.root, args.pr, args.artifact, args.sha256,
                             _expected(args.expected_token), budget, args.revision)
        elif args.command == "rollback":
            result = rollback(args.root, args.pr, args.revision, _expected(args.expected_token), budget)
        elif args.command == "retire":
            result = retire(args.root, args.pr, _expected(args.expected_token))
        elif args.command == "migrate-v1":
            result = migrate_v1(args.root)
        else:
            result = status(args.root)
        print(json.dumps(result, sort_keys=True))
    except (PackageError, OSError) as error:
        parser.exit(1, "Preview operation rejected: " + str(error) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
