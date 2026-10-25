#!/usr/bin/env python3
"""Offline adversarial policy/transport tests. Never contacts GitHub or staging."""
from __future__ import annotations

import copy
from email.message import Message
import hashlib
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import package
import preview_client as client

A, B, C = "a" * 40, "b" * 40, "c" * 40
T1, T2, T3 = "1" * 64, "2" * 64, "3" * 64
USER = {"id": 7, "login": "r33drichards", "type": "User"}
REPO = {"id": 11, "full_name": client.REPOSITORY, "fork": False, "owner": USER}


def pr(state="open", revision=A):
    return {"number": 8, "state": state, "user": copy.deepcopy(USER),
            "head": {"sha": revision, "repo": copy.deepcopy(REPO)}, "base": {"repo": copy.deepcopy(REPO)}}


def run():
    return {"id": 23, "workflow_id": 31, "path": client.CI_PATH, "event": "pull_request",
            "status": "completed", "conclusion": "success", "head_sha": A, "run_attempt": 1,
            "repository": copy.deepcopy(REPO), "head_repository": copy.deepcopy(REPO),
            "actor": copy.deepcopy(USER), "triggering_actor": copy.deepcopy(USER),
            "pull_requests": [{"number": 8, "head": {"sha": A, "repo": {"id": 11}},
                               "base": {"sha": B, "repo": {"id": 11}}}]}


def jobs():
    values = []
    for name in sorted(client.JOBS):
        names = client.TEST_STEPS if name.startswith("Build") else client.ARTIFACT_STEPS
        values.append({"name": name, "run_id": 23, "run_attempt": 1, "head_sha": A,
                       "status": "completed", "conclusion": "success", "started_at": "2026-10-25T00:00:00Z",
                       "completed_at": "2026-10-25T00:02:00Z", "steps": [
                           {"name": n, "status": "completed", "conclusion": "success"} for n in names]})
    return values


def tree():
    paths = set(client.RECIPE_FILES) | {d + "test.txt" for d in client.RECIPE_DIRS}
    return {"truncated": False, "tree": [{"path": p, "mode": "100644", "type": "blob", "sha": B} for p in sorted(paths)]}


def response(record=None):
    return {"version": 2, "tenant": "pr-8", "record": record}


def record(token=T1, active=B, enabled=True, releases=None):
    return {"state_token": token, "enabled": enabled, "active": active,
            "releases": releases if releases is not None else {active: {"artifact_sha256": T1, "manifest_sha256": T2}}}


def health_headers(nonce=T1, revision=A, cache="no-store"):
    value = Message()
    for name, content in [("X-Pbin-Revision", revision), ("X-Pbin-Health-Nonce", nonce), ("Cache-Control", cache)]:
        if content is not None:
            value[name] = content
    return value


class ScriptedHTTP:
    def __init__(self, results):
        self.results, self.calls = list(results), []

    def request(self, method, url, headers=None, data=None, maximum=None):
        self.calls.append((method, url, headers or {}, data, maximum))
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.policy = client.Policy(11, 7, 31, C)

    def test_eligible_without_impossible_self_approval(self):
        self.assertEqual(self.policy.pr(pr(), 8, "open"), A)
        self.assertEqual(self.policy.run(run(), 8, A), B)
        self.policy.jobs(jobs(), 23, 1, A)
        self.policy.recipes(tree(), tree())

    def test_reject_actors_author_forks_ids_and_stale_heads(self):
        mutations = [lambda r: r["actor"].update(login="attacker"),
                     lambda r: r["triggering_actor"].update(id=99),
                     lambda r: r["repository"].update(id=12),
                     lambda r: r["head_repository"].update(fork=True),
                     lambda r: r.update(head_sha=B), lambda r: r.update(conclusion="failure"),
                     lambda r: r.update(path=".github/workflows/evil.yml"),
                     lambda r: r.update(workflow_id=32), lambda r: r.update(event="push"),
                     lambda r: r["pull_requests"][0]["head"].update(sha=B),
                     lambda r: r["pull_requests"][0]["head"]["repo"].update(id=999),
                     lambda r: r["actor"].update(type="Bot")]
        for change in mutations:
            with self.subTest(change=change):
                value = run(); change(value)
                with self.assertRaises(client.Rejected): self.policy.run(value, 8, A)
        for change in [lambda p: p.update(state="closed"), lambda p: p["user"].update(id=99),
                       lambda p: p["head"]["repo"].update(full_name="attacker/pastebin-public")]:
            value = pr(); change(value)
            with self.assertRaises(client.Rejected): self.policy.pr(value, 8, "open")

    def test_skipped_missing_duplicate_or_wrong_attempt_jobs_fail(self):
        for change in [lambda j: j.pop(), lambda j: j.append(j[0]),
                       lambda j: j[0].update(run_attempt=2), lambda j: j[0].update(conclusion="skipped"),
                       lambda j: j[0]["steps"][0].update(conclusion="skipped")]:
            value = jobs(); change(value)
            with self.assertRaises(client.Rejected): self.policy.jobs(value, 23, 1, A)

    def test_changed_or_truncated_recipe_rejected(self):
        for change in [lambda t: t.update(truncated=True), lambda t: t["tree"].pop(),
                       lambda t: t["tree"][0].update(sha=A),
                       lambda t: t["tree"].append({"path": "e2e/new-test.cjs", "sha": A, "mode": "100644", "type": "blob"})]:
            value = tree(); change(value)
            with self.assertRaises(client.Rejected): self.policy.recipes(tree(), value)
        value = tree(); value["tree"].append({"path": "wordpress/pbin/runtime.php", "sha": A})
        self.policy.recipes(tree(), value)  # Application edits are the intended payload.

    def test_complete_controller_tree_is_part_of_reviewed_recipe(self):
        for path in ("wordpress/preview/mysql-registry.php", "wordpress/preview/control/rest.php",
                     "wordpress/preview/control/native-package.php", "wordpress/preview/health.php"):
            baseline = tree()
            baseline["tree"].append({"path": path, "sha": B, "mode": "100644", "type": "blob"})
            for change in (lambda t: t["tree"][-1].update(sha=A),
                           lambda t: t["tree"][-1].update(mode="100755"),
                           lambda t: t["tree"].pop()):
                candidate = copy.deepcopy(baseline); change(candidate)
                with self.assertRaises(client.Rejected): self.policy.recipes(baseline, candidate)

    def test_documented_workflow_path_suffix_is_not_a_new_workflow(self):
        for path in (client.CI_PATH, client.CI_PATH + "@main", client.CI_PATH + "@refs/pull/8/merge"):
            value = run(); value["path"] = path; self.policy.run_identity(value)
        for path in (client.CI_PATH + "@", client.CI_PATH + "@main@evil", client.CI_PATH + "@x\n",
                     client.CI_PATH + ".evil@main", "../" + client.CI_PATH):
            value = run(); value["path"] = path
            with self.assertRaises(client.Rejected): self.policy.run_identity(value)
        self.policy.workflow({"id": 31, "path": client.CI_PATH, "state": "active"}, 31, client.CI_PATH)
        for value in ({"id": 32, "path": client.CI_PATH, "state": "active"},
                      {"id": 31, "path": client.CI_PATH + "@main", "state": "active"},
                      {"id": 31, "path": client.CI_PATH, "state": "disabled_manually"}):
            with self.assertRaises(client.Rejected): self.policy.workflow(value, 31, client.CI_PATH)

    def test_missing_rerun_identity_and_ghost_sender_never_inherit_trust(self):
        for field in ("actor", "triggering_actor"):
            value = run(); del value[field]
            with self.assertRaises(client.Rejected): self.policy.run_identity(value)
        for value in (None, {"login": "ghost", "id": 10137, "type": "User"},
                      {"login": "r33drichards", "id": 7, "type": "Bot"}):
            with self.assertRaises(client.Rejected): self.policy.user(value)
        with self.assertRaises(client.Rejected):
            client.document(b'{"sender":{"id":7},"sender":{"id":99}}')

    def test_missing_or_duplicate_pr_and_step_records_fail(self):
        for pulls in ([], run()["pull_requests"] * 2):
            value = run(); value["pull_requests"] = pulls
            with self.assertRaises(client.Rejected): self.policy.run(value, 8, A)
        value = jobs(); value[0]["steps"].append(value[0]["steps"][0])
        with self.assertRaises(client.Rejected): self.policy.jobs(value, 23, 1, A)

    def test_tenant_strict_schema_and_tombstones(self):
        self.assertTrue(client.Tenant.parse(response(), 8).absent)
        self.assertFalse(client.Tenant.parse(response(record()), 8).absent)
        tombstone = record(active=None, enabled=False, releases={})
        self.assertFalse(client.Tenant.parse(response(tombstone), 8).enabled)
        for mutate in [lambda v: v.update(version=1), lambda v: v.update(tenant="pr-9"),
                       lambda v: v["record"].update(state_token=A),
                       lambda v: v["record"].update(active=None),
                       lambda v: v["record"].update(extra=True),
                       lambda v: v["record"]["releases"][B].update(artifact_sha256="no")]:
            value = response(record()); mutate(value)
            with self.assertRaises(client.Rejected): client.Tenant.parse(value, 8)


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name); source = root / "source"; source.mkdir()
        (source / "pbin.php").write_text("<?php /* never executed */")
        (source / "runtime.php").write_text("<?php /* never executed */")
        path = root / "pbin.zip"
        self.report = package.build_package(source, A, path)
        self.payload = path.read_bytes()
        self.files = {"pbin.zip": self.payload, "build.json": package.canonical_json(self.report),
                      "SHA256SUMS": (self.report["artifact_sha256"] + "  pbin.zip\n").encode()}

    def tearDown(self):
        self.tmp.cleanup()

    def bundle(self, extra=None):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name, data in self.files.items(): archive.writestr(name, data)
            if extra: archive.writestr(*extra)
        return output.getvalue()

    def artifact(self, data):
        return {"id": 55, "name": "pbin-wordpress-" + A, "expired": False,
                "size_in_bytes": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                "created_at": "2026-10-25T00:01:00Z",
                "workflow_run": {"id": 23, "repository_id": 11, "head_repository_id": 11, "head_sha": A}}

    def test_exact_bundle_and_artifact_are_accepted(self):
        data = self.bundle()
        self.assertEqual(client.unpack_bundle(data, A), (self.payload, self.report["artifact_sha256"]))
        client.Policy(11, 7, 31, C).artifact([self.artifact(data)], 23, A, jobs()[1])

    def test_hash_mismatch_wrong_revision_and_path_traversal_fail(self):
        with self.assertRaises(client.Rejected): client.unpack_bundle(self.bundle(), B)
        with self.assertRaises(client.Rejected): client.unpack_bundle(self.bundle(("../evil.py", b"bad")), A)
        self.files["SHA256SUMS"] = (T1 + "  pbin.zip\n").encode()
        with self.assertRaises(client.Rejected): client.unpack_bundle(self.bundle(), A)

    def test_symlink_and_duplicate_members_fail(self):
        link = zipfile.ZipInfo("other"); link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(client.Rejected): client.unpack_bundle(self.bundle((link, b"pbin.zip")), A)
        # Replacing an expected regular file with a symlink is rejected too.
        del self.files["build.json"]
        link.filename = "build.json"
        with self.assertRaises(client.Rejected): client.unpack_bundle(self.bundle((link, b"target")), A)

    def test_missing_duplicate_expired_wrong_attempt_artifact_fail(self):
        artifact = self.artifact(self.bundle()); policy = client.Policy(11, 7, 31, C)
        for artifacts in [[], [artifact, artifact], [dict(artifact, expired=True)],
                          [dict(artifact, digest=None)], [dict(artifact, created_at="2026-10-24T00:01:00Z")]]:
            with self.assertRaises(client.Rejected): policy.artifact(artifacts, 23, A, jobs()[1])

    def test_github_redirect_drops_auth_and_digest_failure_is_hard(self):
        data = self.bundle(); artifact = self.artifact(data)
        http = ScriptedHTTP([(302, {"Location": "https://store.blob.core.windows.net/object?signed=secret"}, b""),
                             (200, {}, data)])
        self.assertEqual(client.GitHub("fake-token", http).download(artifact), data)
        self.assertIn("Authorization", http.calls[0][2]); self.assertEqual(http.calls[1][2], {})
        http = ScriptedHTTP([(302, {"Location": "https://evil.example/object"}, b"")])
        with self.assertRaises(client.Rejected): client.GitHub("fake-token", http).download(artifact)
        self.assertEqual(len(http.calls), 1)
        http = ScriptedHTTP([(302, {"Location": "https://store.blob.core.windows.net/object"}, b""), (200, {}, b"bad")])
        with self.assertRaises(client.Rejected): client.GitHub("fake-token", http).download(artifact)

    def reconciler(self, *, health=True, close=False, head_change=False, conflict=False, before=None):
        bundle = self.bundle(); artifact = self.artifact(bundle); outer = self
        class GitHub:
            def __init__(self): self.pr_reads = 0
            def get(self, path):
                if not path: return REPO
                if path.startswith("/pulls/"):
                    self.pr_reads += 1
                    return pr("closed" if close else "open", B if head_change and self.pr_reads > 1 else A)
                if path.startswith("/actions/runs/"): return run()
                if path == "/actions/workflows/31": return {"id": 31, "path": client.CI_PATH, "state": "active"}
                if path.startswith("/git/trees/"): return tree()
                raise AssertionError(path)
            def collection(self, path, key): return jobs() if key == "jobs" else [artifact]
            def download(self, value): return bundle
        class Staging:
            def __init__(self):
                self.before = before or client.Tenant.parse(response(record()), 8)
                self.mutations = []
                self.installed = None
            def state(self, number): return self.installed or self.before
            def install(self, number, revision, payload, digest, expected):
                self.mutations.append(("install", expected.token))
                if conflict: raise client.Conflict("changed")
                releases = dict(self.before.releases)
                releases[A] = {"artifact_sha256": digest, "manifest_sha256": outer.report["manifest_sha256"]}
                self.installed = client.Tenant(T2, True, A, releases)
                return self.installed
            def healthy(self, number, revision):
                self.assert_revision = revision
                return health
            def action(self, number, action, expected, revision=None):
                self.mutations.append((action, expected.token, revision))
                if action == "rollback": return client.Tenant(T3, True, revision, self.before.releases)
                return client.Tenant(T3, False, self.before.active, self.before.releases)
        github, staging = GitHub(), Staging()
        return client.Reconciler(client.Policy(11, 7, 31, C), github, staging)

    def test_full_offline_promotion(self):
        worker = self.reconciler()
        self.assertEqual(worker.promote(23)["result"], "active")
        self.assertEqual(worker.staging.mutations, [("install", T1)])
        self.assertEqual(worker.github.pr_reads, 2)

    def test_stale_head_cannot_promote_and_conflict_never_retries(self):
        worker = self.reconciler(head_change=True)
        with self.assertRaises(client.Rejected): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [])
        worker = self.reconciler(conflict=True)
        with self.assertRaises(client.Conflict): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [("install", T1)])

    def test_failed_health_rolls_back_only_with_own_new_token(self):
        worker = self.reconciler(health=False)
        with self.assertRaisesRegex(client.Rejected, "health failed"): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [("install", T1), ("rollback", T2, B)])

    def test_failed_first_health_retires_using_own_token(self):
        worker = self.reconciler(health=False, before=client.Tenant(None, False, None, {}))
        with self.assertRaisesRegex(client.Rejected, "health failed"): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [("install", None), ("retire", T2, None)])

    def test_late_ci_event_retires_already_closed_pr(self):
        worker = self.reconciler(close=True)
        self.assertEqual(worker.promote(23)["result"], "retired")
        self.assertEqual(worker.staging.mutations, [("retire", T1, None)])

    def test_stale_rollback_never_refreshes_token(self):
        worker = self.reconciler(health=False)
        def stale(number, action, expected, revision=None):
            worker.staging.mutations.append((action, expected.token, revision))
            raise client.Conflict("newer state wins")
        worker.staging.action = stale
        with self.assertRaises(client.Conflict): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [("install", T1), ("rollback", T2, B)])

    def test_newer_state_after_health_is_not_reported_as_our_success(self):
        worker = self.reconciler()
        calls = 0
        def state(number):
            nonlocal calls
            calls += 1
            return worker.staging.before
        worker.staging.state = state
        with self.assertRaisesRegex(client.Rejected, "changed during health"): worker.promote(23)
        self.assertEqual(worker.staging.mutations, [("install", T1)])

    def test_idempotent_install_keeps_token_and_does_not_invent_rollback(self):
        initial = client.Tenant(T1, True, A, {A: {"artifact_sha256": self.report["artifact_sha256"],
                                                "manifest_sha256": self.report["manifest_sha256"]}})
        for healthy in (True, False):
            worker = self.reconciler(health=healthy, before=initial)
            def install(number, revision, payload, digest, expected):
                worker.staging.mutations.append(("install", expected.token))
                return expected
            worker.staging.install = install
            if healthy:
                self.assertEqual(worker.promote(23)["result"], "active")
            else:
                with self.assertRaisesRegex(client.Rejected, "unchanged preview"): worker.promote(23)
            self.assertEqual(worker.staging.mutations, [("install", T1)])

    def test_idempotent_retirement_accepts_unchanged_token(self):
        initial = client.Tenant(T1, False, None, {})
        worker = self.reconciler(close=True, before=initial)
        worker.staging.action = lambda *args: initial
        self.assertEqual(worker.retire(8)["result"], "retired")

    def test_closed_pr_retirement_and_absent_tombstone(self):
        worker = self.reconciler(close=True, before=client.Tenant(None, False, None, {}))
        self.assertEqual(worker.retire(8)["result"], "retired")
        self.assertEqual(worker.staging.mutations, [("retire", None, None)])
        worker = self.reconciler()
        with self.assertRaises(client.Rejected): worker.retire(8)
        self.assertEqual(worker.staging.mutations, [])


class TransportTest(unittest.TestCase):
    def test_staging_credentials_do_not_follow_redirect(self):
        http = ScriptedHTTP([(302, {"Location": "https://evil.example"}, b"")])
        staging = client.Staging("preview-user", "fake-password", http)
        with self.assertRaises(client.Rejected): staging.state(8)
        self.assertEqual(len(http.calls), 1)
        self.assertTrue(http.calls[0][1].startswith(client.STAGING + "/"))

    def test_health_never_has_auth(self):
        http = ScriptedHTTP([(200, health_headers(), b"OK")])
        with patch.object(client.secrets, "token_hex", return_value=T1):
            self.assertTrue(client.Staging("preview-user", "fake-password", http).healthy(8, A))
        self.assertNotIn("Authorization", http.calls[0][2])
        self.assertEqual(http.calls[0][2]["Cache-Control"], "no-cache, no-store")

    def test_timeout_inspects_status_once_but_does_not_replay(self):
        http = ScriptedHTTP([client.TransportError("timeout"), (200, {}, package.canonical_json(response(record())))])
        staging = client.Staging("preview-user", "fake-password", http)
        with self.assertRaises(client.UncertainOutcome) as caught:
            staging.action(8, "retire", client.Tenant.parse(response(record()), 8))
        self.assertEqual(caught.exception.observed.token, T1)
        self.assertEqual([call[0] for call in http.calls], ["POST", "GET"])

    def test_conflict_does_not_fetch_fresh_token(self):
        http = ScriptedHTTP([(409, {}, b"")]); staging = client.Staging("user", "fake", http)
        with self.assertRaises(client.Conflict): staging.action(8, "retire", client.Tenant(None, False, None, {}))
        self.assertEqual(len(http.calls), 1)

    def test_incomplete_github_collection_rejected(self):
        http = ScriptedHTTP([(200, {}, package.canonical_json({"total_count": 2, "jobs": [{}]}))])
        with self.assertRaises(client.Rejected):
            client.GitHub("fake-token", http).collection("/actions/runs/23/jobs", "jobs")

    def test_invalid_mutation_response_inspects_without_replay(self):
        http = ScriptedHTTP([(200, {}, b"not JSON"), (200, {}, package.canonical_json(response()))])
        with self.assertRaises(client.UncertainOutcome):
            client.Staging("user", "fake", http).action(8, "retire", client.Tenant(None, False, None, {}))
        self.assertEqual([call[0] for call in http.calls], ["POST", "GET"])

    def test_public_health_redirect_never_follows(self):
        http = ScriptedHTTP([(302, {"Location": "https://other.example"}, b"")])
        self.assertFalse(client.Staging("user", "fake", http).healthy(8, A))
        self.assertEqual(len(http.calls), 1)

    def test_health_requires_exact_fresh_revision_nonce_and_noncacheability(self):
        variants = [health_headers(revision=None), health_headers(revision=B), health_headers(revision=A.upper()),
                    health_headers(nonce=None), health_headers(nonce=T2), health_headers(cache=None),
                    health_headers(cache="public, max-age=60"), health_headers(cache="no-store, max-age=60"),
                    health_headers(cache="no-store, public"), health_headers(cache="no-store, immutable")]
        for name in ("X-Pbin-Revision", "x-pbin-revision", "X-Pbin-Health-Nonce", "Cache-Control"):
            duplicate = health_headers(); duplicate[name] = "no-store" if name == "Cache-Control" else T1
            variants.append(duplicate)
        aged = health_headers(); aged["Age"] = "1"; variants.append(aged)
        for headers in variants:
            http = ScriptedHTTP([(200, headers, b"OK")])
            with self.subTest(headers=list(headers.items())), patch.object(client.secrets, "token_hex", return_value=T1):
                self.assertFalse(client.Staging("user", "fake", http).healthy(8, A))

    def test_same_sha_stale_cached_health_is_not_success(self):
        http = ScriptedHTTP([(200, health_headers(T1), b"OK"), (200, health_headers(T1), b"OK")])
        staging = client.Staging("user", "fake", http)
        with patch.object(client.secrets, "token_hex", side_effect=[T1, T2]):
            self.assertTrue(staging.healthy(8, A))
            self.assertFalse(staging.healthy(8, A))
        self.assertNotEqual(http.calls[0][1], http.calls[1][1])

    def test_each_health_probe_has_a_new_bounded_nonce(self):
        class EchoHTTP(ScriptedHTTP):
            def request(self, method, url, headers=None, **kwargs):
                self.calls.append((method, url, headers))
                nonce = client.urllib.parse.parse_qs(client.urllib.parse.urlsplit(url).query)["pbin-health-nonce"][0]
                self_nonce = client.TOKEN_RE.fullmatch(nonce)
                if not self_nonce: raise AssertionError("bad nonce")
                return 200, health_headers(nonce), b"OK"
        http = EchoHTTP([]); staging = client.Staging("user", "fake", http)
        self.assertTrue(staging.healthy(8, A)); self.assertTrue(staging.healthy(8, A))
        self.assertNotEqual(http.calls[0][1], http.calls[1][1])
        self.assertTrue(all("Authorization" not in call[2] for call in http.calls))

    def test_transport_preserves_duplicate_header_fields(self):
        headers = health_headers(); headers["X-Pbin-Revision"] = A
        class Response:
            code = 200
            def __init__(self): self.headers = headers
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b"OK"
        http = client.HTTP()
        with patch.object(http.opener, "open", return_value=Response()):
            _, received, _ = http.request("GET", client.STAGING + "/health")
        self.assertEqual(client.header_values(received, "x-pbin-revision"), [A, A])
        with self.assertRaises(client.Rejected): client.one_header(received, "X-Pbin-Revision")

    def test_duplicate_redirect_location_is_rejected_without_download(self):
        headers = Message(); headers["Location"] = "https://a.blob.core.windows.net/a"
        headers["Location"] = "https://b.blob.core.windows.net/b"
        http = ScriptedHTTP([(302, headers, b"")])
        with self.assertRaises(client.Rejected): client.GitHub("fake", http).download({"id": 55})
        self.assertEqual(len(http.calls), 1)

    def test_default_cli_is_disabled_and_does_not_print_credentials(self):
        script = Path(client.__file__)
        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True,
                                env={"PBIN_STAGING_APPLICATION_PASSWORD": "do-not-leak"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("disabled", result.stderr)
        self.assertNotIn("do-not-leak", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
