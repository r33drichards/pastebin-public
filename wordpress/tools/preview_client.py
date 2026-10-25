#!/usr/bin/env python3
"""Fail-closed trusted-PR policy and proposed staging REST client (stdlib only).

This client does not install its server, create credentials, or authorize trust.
Read wordpress/preview/AUTOMATION.md before configuring a privileged workflow.
"""
from __future__ import annotations

import base64
from datetime import datetime
from dataclasses import dataclass
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import package

REPOSITORY = "r33drichards/pastebin-public"
OWNER = "r33drichards"
API = "https://api.github.com"
STAGING = "https://pbin-staging.wasmer.app"
CI_PATH = ".github/workflows/ci.yml"
CONTROL_PATH = ".github/workflows/preview-reconcile.yml"
JOBS = {"Build, unit, real WordPress and browser gates", "Retain tested immutable package (not deployment)"}
TEST_STEPS = {
    "Required syntax and unit checks", "Build reproducible artifact and extract exact bytes for tests",
    "Real WordPress, MySQL and Chromium tests against the built package",
    "Real WordPress controller HTTPS and authentication gate",
    "Install standard ZIP through WordPress Plugin_Upgrader",
    "Canonical /paste routing on a real WordPress site", "Verify artifact did not change while tested",
    "Transfer tested artifact to gated artifact job", "Transfer tested WordPress installer",
}
ARTIFACT_STEPS = {"Download this run's tested bytes only", "Verify transported archive and exact revision",
                  "Retain the exact tested package", "Verify transported WordPress installer",
                  "Retain exact tested WordPress installer"}
RECIPE_FILES = {CI_PATH, "wordpress/tools/package.py", "wordpress/tools/wordpress_installer.py", "wordpress/preview/loader.php",
                "wordpress/preview/selector.php"}
RECIPE_DIRS = ("wordpress/preview/", "wordpress/ci/", "wordpress/tests/", "e2e/", "acceptance/")
MAX_BUNDLE = 70 * 1024 * 1024
MAX_JSON = 8 * 1024 * 1024
TOKEN_RE = re.compile(r"[0-9a-f]{64}\Z")


class Rejected(ValueError):
    """No deployment is authorized by the supplied facts."""


class TransportError(Rejected):
    """Sanitized transport failure: never includes headers, response bodies or URLs."""


class UncertainOutcome(Rejected):
    """One read-only observation is attached; it never authorizes a replay."""
    def __init__(self, observed):
        self.observed = observed
        super().__init__("Mutation outcome uncertain; current state inspected without replay")


class Conflict(Rejected):
    """Do not retry a mutation with a fresh token in the same operation."""


def require(value, message):
    if not value:
        raise Rejected(message)


def identifier(value):
    require(type(value) is int and value > 0, "Invalid numeric GitHub identifier")
    return value


def sha(value):
    try:
        return package.checked_revision(value)
    except package.PackageError as error:
        raise Rejected("Invalid full revision") from error


def workflow_path(value, expected):
    """REST run paths may append @ref; never use that suffix as a checkout ref."""
    return isinstance(value, str) and (value == expected or bool(
        re.fullmatch(re.escape(expected) + r"@[A-Za-z0-9_./-]{1,255}", value)))


def header_values(headers, name):
    """Preserve multiplicity: converting HTTPMessage to dict hides duplicates."""
    if hasattr(headers, "get_all"):
        return headers.get_all(name, [])
    return [value for key, value in headers.items() if key.lower() == name.lower()]


def one_header(headers, name):
    values = header_values(headers, name)
    require(len(values) == 1 and isinstance(values[0], str), "Missing or duplicate response header")
    return values[0].strip()


@dataclass(frozen=True)
class Policy:
    repository_id: int
    owner_id: int
    ci_workflow_id: int
    control_sha: str

    def __post_init__(self):
        for number in (self.repository_id, self.owner_id, self.ci_workflow_id):
            identifier(number)
        sha(self.control_sha)

    def user(self, value):
        require(isinstance(value, dict) and value.get("login") == OWNER
                and value.get("id") == self.owner_id and value.get("type") == "User",
                "Actor or PR author is not the explicitly trusted authenticated account")

    def repository(self, value):
        require(isinstance(value, dict) and value.get("id") == self.repository_id
                and value.get("full_name") == REPOSITORY and value.get("fork") is False,
                "Repository identity mismatch or fork")
        self.user(value.get("owner"))

    def pr(self, value, number, state):
        require(value.get("number") == identifier(number) and value.get("state") == state,
                "PR state/number no longer eligible")
        self.repository(value.get("base", {}).get("repo"))
        self.repository(value.get("head", {}).get("repo"))
        self.user(value.get("user"))
        return sha(value.get("head", {}).get("sha"))

    def workflow(self, value, workflow_id, path):
        require(value.get("id") == identifier(workflow_id) and value.get("path") == path
                and value.get("state") == "active", "Workflow resource identity/path/state mismatch")

    def run_identity(self, value):
        self.repository(value.get("repository"))
        self.repository(value.get("head_repository"))
        self.user(value.get("actor"))
        self.user(value.get("triggering_actor"))
        require(value.get("workflow_id") == self.ci_workflow_id and workflow_path(value.get("path"), CI_PATH),
                "Untrusted workflow identity/path")
        require(value.get("event") == "pull_request" and value.get("status") == "completed"
                and value.get("conclusion") == "success", "CI is not a successful completed PR run")

    def run(self, value, number, revision):
        self.run_identity(value)
        require(value.get("head_sha") == revision, "CI did not test the exact current head")
        pulls = value.get("pull_requests", [])
        require(len(pulls) == 1 and pulls[0].get("number") == number
                and pulls[0].get("head", {}).get("sha") == revision
                and pulls[0].get("head", {}).get("repo", {}).get("id") == self.repository_id
                and pulls[0].get("base", {}).get("repo", {}).get("id") == self.repository_id,
                "Ambiguous or mismatched run-to-PR association")
        return sha(pulls[0].get("base", {}).get("sha"))

    def jobs(self, jobs, run_id, attempt, revision):
        require(len(jobs) == len(JOBS) and {j.get("name") for j in jobs} == JOBS,
                "Missing, duplicate or unexpected CI job")
        for job in jobs:
            require(job.get("run_id") == run_id and job.get("run_attempt") == attempt
                    and job.get("head_sha") == revision and job.get("status") == "completed"
                    and job.get("conclusion") == "success", "CI job provenance/result mismatch")
            expected = TEST_STEPS if job["name"].startswith("Build,") else ARTIFACT_STEPS
            steps = job.get("steps", [])
            for name in expected:
                matches = [s for s in steps if s.get("name") == name]
                require(len(matches) == 1 and matches[0].get("status") == "completed"
                        and matches[0].get("conclusion") == "success", "Required CI step did not pass")

    def recipes(self, baseline, candidate):
        def inventory(tree):
            require(tree.get("truncated") is False and isinstance(tree.get("tree"), list),
                    "Incomplete Git tree; recipe comparison cannot be trusted")
            selected = {}
            for entry in tree["tree"]:
                path = entry.get("path", "")
                if path in RECIPE_FILES or path.startswith(RECIPE_DIRS):
                    require(path not in selected, "Duplicate protected recipe path")
                    selected[path] = (entry.get("mode"), entry.get("type"), sha(entry.get("sha")))
            require(RECIPE_FILES.issubset(selected), "Protected recipe is incomplete")
            require(all(any(p.startswith(d) for p in selected) for d in RECIPE_DIRS),
                    "Protected test directory is missing")
            return selected
        require(inventory(baseline) == inventory(candidate),
                "CI recipe/test/packager differs from the reviewed control baseline")

    def artifact(self, artifacts, run_id, revision, artifact_job):
        name = "pbin-wordpress-" + revision
        matches = [a for a in artifacts if a.get("name") == name]
        require(len(matches) == 1, "Expected one unambiguous immutable artifact")
        artifact = matches[0]
        provenance = artifact.get("workflow_run", {})
        require(artifact.get("expired") is False and 0 < artifact.get("size_in_bytes", 0) <= MAX_BUNDLE
                and provenance.get("id") == run_id and provenance.get("repository_id") == self.repository_id
                and provenance.get("head_repository_id") == self.repository_id
                and provenance.get("head_sha") == revision, "Artifact provenance/size/expiry mismatch")
        digest = artifact.get("digest", "")
        require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest),
                "GitHub artifact SHA-256 is required")
        identifier(artifact.get("id"))
        try:
            created, started, finished = (datetime.fromisoformat(v.replace("Z", "+00:00")) for v in
                                          (artifact["created_at"], artifact_job["started_at"], artifact_job["completed_at"]))
            require(created.tzinfo is not None and started <= created <= finished,
                    "Artifact was not uploaded during this successful attempt")
        except (KeyError, ValueError, TypeError):
            raise Rejected("Invalid artifact/job timestamps") from None
        return artifact


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HTTP:
    """Every redirect is explicit. Request/response contents never enter exceptions."""
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, url, headers=None, data=None, maximum=MAX_JSON):
        try:
            request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                # Even error bodies may contain secrets or unbounded debug output.
                if 200 <= status < 300:
                    body = response.read(maximum + 1)
                    require(len(body) <= maximum, "Response exceeds size limit")
                else:
                    body = b""
                return status, response.headers, body
        except (OSError, ValueError, http.client.HTTPException):
            raise TransportError("HTTPS request failed; outcome may be uncertain") from None


def document(body):
    try:
        value = package.strict_json(body)
    except package.PackageError:
        raise Rejected("Invalid JSON response") from None
    require(isinstance(value, dict), "Expected a JSON object")
    return value


class GitHub:
    def __init__(self, token, http=None):
        require(bool(token), "Missing GitHub read token")
        self.http = http or HTTP()
        self.headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pbin-trusted-preview-client"}

    def request(self, path, maximum=MAX_JSON):
        require(path.startswith("/repos/" + REPOSITORY + "/") or path == "/repos/" + REPOSITORY,
                "GitHub request outside the fixed repository")
        require("#" not in path and "\\" not in path and ":" not in path, "Invalid GitHub path")
        return self.http.request("GET", API + path, self.headers, maximum=maximum)

    def get(self, suffix):
        status, _, body = self.request("/repos/" + REPOSITORY + suffix)
        require(status == 200, "GitHub API read rejected (HTTP " + str(status) + ")")
        return document(body)

    def collection(self, suffix, key):
        # Fail closed on truncation rather than trusting an incomplete job/artifact list.
        value = self.get(suffix + ("&" if "?" in suffix else "?") + "per_page=100")
        values = value.get(key)
        require(isinstance(values, list) and value.get("total_count") == len(values),
                "Incomplete GitHub collection")
        return values

    def download(self, artifact):
        status, headers, body = self.request("/repos/" + REPOSITORY + "/actions/artifacts/"
                                            + str(identifier(artifact["id"])) + "/zip", MAX_BUNDLE)
        require(status == 302, "Expected GitHub's artifact download redirect")
        location = one_header(headers, "Location")
        for _ in range(3):
            parsed = urllib.parse.urlsplit(location)
            host = parsed.hostname or ""
            require(parsed.scheme == "https" and parsed.port in (None, 443)
                    and not parsed.username and not parsed.password and not parsed.fragment
                    and (host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com")),
                    "Artifact redirect is not an allowed GitHub storage HTTPS origin")
            # NO GitHub token on this request or any subsequent redirect.
            status, headers, body = self.http.request("GET", location, maximum=MAX_BUNDLE)
            if status == 200:
                require("sha256:" + hashlib.sha256(body).hexdigest() == artifact["digest"],
                        "Downloaded GitHub artifact SHA-256 mismatch")
                return body
            require(status in (301, 302, 303, 307, 308), "Artifact download failed")
            location = one_header(headers, "Location")
        raise Rejected("Too many artifact redirects")


def unpack_bundle(data, revision):
    """Read exactly three bounded regular members; no extractall, imports or execution."""
    require(len(data) <= MAX_BUNDLE, "Artifact bundle too large")
    limits = {"pbin.zip": package.Limits().max_archive_bytes, "build.json": 1024 * 1024, "SHA256SUMS": 128}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(len(entries) == 3 and {e.filename for e in entries} == set(limits), "Unexpected artifact inventory")
            files = {}
            for entry in entries:
                require(entry.orig_filename == entry.filename and not entry.is_dir()
                        and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                        and not entry.external_attr & 0x10 and not entry.flag_bits & (1 | 0x40)
                        and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        and 0 <= entry.file_size <= limits[entry.filename]
                        and entry.file_size <= max(1, entry.compress_size) * 200,
                        "Unsafe or oversized artifact member")
                with archive.open(entry) as stream:
                    files[entry.filename] = stream.read(limits[entry.filename] + 1)
                require(len(files[entry.filename]) == entry.file_size, "Artifact member size mismatch")
    except (zipfile.BadZipFile, RuntimeError, EOFError, NotImplementedError):
        raise Rejected("Invalid artifact ZIP") from None
    report = document(files["build.json"])
    digest = hashlib.sha256(files["pbin.zip"]).hexdigest()
    require(report.get("revision") == sha(revision) and report.get("artifact_sha256") == digest,
            "Build report revision/checksum mismatch")
    require(files["SHA256SUMS"] == (digest + "  pbin.zip\n").encode(), "Artifact checksum manifest mismatch")
    with tempfile.TemporaryDirectory(prefix="pbin-verify-") as directory:
        payload = Path(directory) / "pbin.zip"
        payload.write_bytes(files["pbin.zip"])
        with package.open_verified_package(payload, digest) as verified:
            require(verified.revision == revision and report.get("manifest_sha256") == verified.manifest_sha256
                    and report.get("file_count") == len(verified.manifest["files"])
                    and report.get("uncompressed_bytes") == verified.uncompressed_bytes,
                    "Verified package and build report disagree")
    return files["pbin.zip"], digest


@dataclass(frozen=True)
class Tenant:
    token: str | None
    enabled: bool
    active: str | None
    releases: dict

    @property
    def absent(self):
        return self.token is None

    @classmethod
    def parse(cls, value, number):
        require(set(value) == {"version", "tenant", "record"} and type(value.get("version")) is int
                and value["version"] == 2 and value.get("tenant") == package.checked_pr(number),
                "Staging tenant protocol/identity mismatch")
        record = value["record"]
        if record is None:
            return cls(None, False, None, {})
        require(isinstance(record, dict) and set(record) == {"state_token", "enabled", "active", "releases"},
                "Unexpected tenant record")
        token, enabled, active, releases = (record[k] for k in ("state_token", "enabled", "active", "releases"))
        require(isinstance(token, str) and TOKEN_RE.fullmatch(token) and type(enabled) is bool
                and isinstance(releases, dict) and len(releases) <= 100, "Invalid tenant state")
        require(active is not None or (not enabled and not releases), "Invalid tenant tombstone")
        if active is not None:
            sha(active)
            require(active in releases, "Active tenant revision is not retained")
        for revision, release in releases.items():
            sha(revision)
            require(isinstance(release, dict) and set(release) == {"artifact_sha256", "manifest_sha256"},
                    "Invalid release metadata")
            for digest in release.values():
                require(isinstance(digest, str) and TOKEN_RE.fullmatch(digest), "Invalid retained release digest")
        return cls(token, enabled, active, releases)


class Staging:
    def __init__(self, username, application_password, http=None):
        require(bool(username) and bool(application_password) and ":" not in username,
                "Missing/invalid dedicated staging credential")
        self.http = http or HTTP()
        basic = base64.b64encode((username + ":" + application_password).encode()).decode()
        self.headers = {"Authorization": "Basic " + basic, "Accept": "application/json"}

    def request(self, method, number, suffix="", body=None, extra=None):
        tenant = package.checked_pr(number)
        headers = dict(self.headers)
        headers.update(extra or {})
        try:
            status, _, data = self.http.request(method, STAGING + "/wp-json/pbin-previews/v1/tenants/" + tenant + suffix,
                                               headers, body, maximum=64 * 1024)
            if status in (409, 412):
                raise Conflict("Tenant changed; a fresh GitHub reconciliation is required, not a token retry")
            if status >= 500 or (200 <= status < 300 and status not in (200, 201)):
                raise TransportError("Staging server error; mutation outcome may be uncertain")
            require(status in (200, 201), "Staging request rejected (HTTP " + str(status) + "); do not retry blindly")
            try:
                return Tenant.parse(document(data), number)
            except Rejected:
                if method != "GET":
                    raise TransportError("Mutation returned an invalid state; outcome uncertain") from None
                raise
        except (TransportError, OSError):
            if method == "GET":
                raise TransportError("Staging state read failed") from None
            try:
                observed = self.state(number)
            except (Rejected, OSError):
                observed = None
            raise UncertainOutcome(observed) from None

    def state(self, number):
        return self.request("GET", number)

    def install(self, number, revision, payload, digest, expected):
        return self.request("POST", number, "/releases/" + sha(revision), payload,
                            {"Content-Type": "application/zip", "X-Pbin-Artifact-Sha256": package.checked_digest(digest),
                             "X-Pbin-Expected-Token": expected.token or "none"})

    def action(self, number, action, expected, revision=None):
        require(action in {"retire", "rollback"}, "Unknown tenant action")
        data = {"expected_token": expected.token}
        if action == "rollback":
            data["revision"] = sha(revision)
        return self.request("POST", number, "/" + action, package.canonical_json(data),
                            {"Content-Type": "application/json"})

    def healthy(self, number, revision):
        # Non-secret challenge defeats stale successful health for the same SHA.
        revision = sha(revision)
        nonce = secrets.token_hex(32)
        require(TOKEN_RE.fullmatch(nonce), "Invalid generated health challenge")
        url = STAGING + "/previews/" + package.checked_pr(number) + "/health?pbin-health-nonce=" + nonce
        status, headers, body = self.http.request(
            "GET", url, {"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"}, maximum=128)
        if status != 200 or body.strip() != b"OK":
            return False
        try:
            echoed_revision = one_header(headers, "X-Pbin-Revision")
            echoed_nonce = one_header(headers, "X-Pbin-Health-Nonce")
            directives = [part.strip().lower() for part in one_header(headers, "Cache-Control").split(",")]
        except Rejected:
            return False
        age = header_values(headers, "Age")
        return (not age or (len(age) == 1 and age[0].strip() == "0")) and (
                echoed_revision == revision and echoed_nonce == nonce and directives.count("no-store") == 1
                and not any(part in {"public", "immutable"} or
                            (part.startswith(("max-age=", "s-maxage=")) and part.split("=", 1)[1] != "0")
                            for part in directives))


class Reconciler:
    def __init__(self, policy, github, staging):
        self.policy, self.github, self.staging = policy, github, staging

    def current(self, number, state="open", revision=None):
        current = self.policy.pr(self.github.get("/pulls/" + str(identifier(number))), number, state)
        require(revision is None or current == revision, "PR head changed before mutation")
        return current

    def promote(self, run_id):
        policy, github = self.policy, self.github
        policy.repository(github.get(""))
        run = github.get("/actions/runs/" + str(identifier(run_id)))
        require(run.get("id") == run_id, "Run ID mismatch")
        pulls = run.get("pull_requests", [])
        require(len(pulls) == 1, "Run must identify exactly one PR")
        number = identifier(pulls[0].get("number"))
        policy.run_identity(run)
        policy.workflow(github.get("/actions/workflows/" + str(policy.ci_workflow_id)),
                        policy.ci_workflow_id, CI_PATH)
        current_pr = github.get("/pulls/" + str(number))
        if current_pr.get("state") == "closed":
            # A late successful CI event must not swallow pending close cleanup.
            policy.pr(current_pr, number, "closed")
            return self.retire(number)
        revision = policy.pr(current_pr, number, "open")
        base = policy.run(run, number, revision)
        attempt = identifier(run.get("run_attempt"))
        jobs = github.collection("/actions/runs/" + str(run_id) + "/attempts/" + str(attempt) + "/jobs", "jobs")
        policy.jobs(jobs, run_id, attempt, revision)
        baseline = github.get("/git/trees/" + policy.control_sha + "?recursive=1")
        for candidate in {base, revision}:
            policy.recipes(baseline, github.get("/git/trees/" + candidate + "?recursive=1"))
        artifact = policy.artifact(github.collection("/actions/runs/" + str(run_id) + "/artifacts", "artifacts"),
                                   run_id, revision, next(j for j in jobs if j["name"].startswith("Retain")))
        payload, digest = unpack_bundle(github.download(artifact), revision)
        latest_run = github.get("/actions/runs/" + str(run_id))
        policy.run(latest_run, number, revision)
        require(latest_run.get("run_attempt") == attempt, "CI attempt changed during reconciliation")
        before = self.staging.state(number)
        # No work or network calls between the final GitHub read and mutation.
        self.current(number, revision=revision)
        installed = self.staging.install(number, revision, payload, digest, before)
        require(installed.enabled and installed.active == revision
                and (installed.token != before.token or installed == before)
                and installed.releases[revision]["artifact_sha256"] == digest,
                "Staging did not confirm a new active state; outcome is uncertain")
        try:
            healthy = self.staging.healthy(number, revision)
        except (Rejected, OSError):
            healthy = False
        if healthy:
            require(self.staging.state(number) == installed,
                    "Preview state changed during health check; no stale result or rollback")
            return {"result": "active", "pr": number, "revision": revision, "artifact_sha256": digest}
        require(installed != before, "Existing unchanged preview failed health; no new mutation to roll back")
        # Only use the token returned by OUR install, never fetch a fresher token.
        self.current(number, revision=revision)
        if before.enabled and before.active is not None:
            require(installed.releases.get(before.active) == before.releases[before.active],
                    "Retained rollback target not confirmed")
            restored = self.staging.action(number, "rollback", installed, before.active)
            require(restored.enabled and restored.active == before.active
                    and restored.releases.get(before.active) == before.releases[before.active]
                    and restored.token != installed.token, "Rollback not confirmed; outcome uncertain")
        else:
            retired = self.staging.action(number, "retire", installed)
            require(not retired.enabled and retired.token is not None and retired.token != installed.token,
                    "Failed first release retirement not confirmed")
        raise Rejected("Preview health failed; guarded rollback/retirement completed")

    def retire(self, number):
        self.policy.repository(self.github.get(""))
        self.current(number, "closed")
        before = self.staging.state(number)
        self.current(number, "closed")
        retired = self.staging.action(number, "retire", before)
        require(not retired.enabled and retired.token is not None
                and (retired.token != before.token or retired == before),
                "Retirement/tombstone not confirmed")
        return {"result": "retired", "pr": number}


def main():
    try:
        require(os.environ.get("PBIN_PREVIEWS_ENABLED") == "true", "Preview automation is disabled")
        policy = Policy(int(os.environ["PBIN_REPOSITORY_ID"]), int(os.environ["PBIN_OWNER_ID"]),
                        int(os.environ["PBIN_CI_WORKFLOW_ID"]), os.environ["PBIN_CONTROL_SHA"])
        root = Path(__file__).resolve().parents[2]
        actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        require(actual == policy.control_sha, "Client/packager checkout is not the reviewed control SHA")
        dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], text=True)
        require(not dirty, "Trusted control checkout contains modified tracked files")
        # Event file is only used for numeric dispatch, never shell code or URLs.
        with Path(os.environ["GITHUB_EVENT_PATH"]).open("rb") as event_file:
            event_bytes = event_file.read(MAX_JSON + 1)
        require(len(event_bytes) <= MAX_JSON, "Event too large")
        event = document(event_bytes)
        policy.repository(event.get("repository"))
        policy.user(event.get("sender"))
        github = GitHub(os.environ["GH_TOKEN"])
        control = github.get("/actions/runs/" + str(identifier(int(os.environ["GITHUB_RUN_ID"]))))
        policy.repository(control.get("repository"))
        policy.repository(control.get("head_repository"))
        policy.user(control.get("actor"))
        policy.user(control.get("triggering_actor"))
        require(workflow_path(control.get("path"), CONTROL_PATH), "Unexpected privileged control workflow")
        control_workflow_id = identifier(control.get("workflow_id"))
        policy.workflow(github.get("/actions/workflows/" + str(control_workflow_id)),
                        control_workflow_id, CONTROL_PATH)
        name = os.environ.get("GITHUB_EVENT_NAME")
        require(control.get("event") == name, "Control event mismatch")
        staging = Staging(os.environ["PBIN_STAGING_USER"], os.environ["PBIN_STAGING_APPLICATION_PASSWORD"])
        reconciler = Reconciler(policy, github, staging)
        if name == "workflow_run":
            require(event.get("action") == "completed", "Only completed CI events are supported")
            result = reconciler.promote(identifier(event.get("workflow_run", {}).get("id")))
        elif name == "pull_request_target":
            require(event.get("action") == "closed", "Privileged PR event is restricted to closed cleanup")
            result = reconciler.retire(identifier(event.get("pull_request", {}).get("number")))
        else:
            raise Rejected("Unsupported control trigger")
        print(json.dumps(result, sort_keys=True))
        return 0
    except Rejected as error:
        print("Preview reconciliation stopped: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        # No traceback: exceptions from network/filesystem/JSON may contain data.
        print("Preview reconciliation rejected or uncertain; no automatic mutation retry. See policy and run metadata.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
