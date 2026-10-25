#!/usr/bin/env python3
"""Actual WordPress/controller HTTPS acceptance; connects ONLY to its loopback fixture."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
from urllib.parse import parse_qs, urlencode, urlsplit

HOST = "controller-fixture.invalid"
ROOT = Path(__file__).resolve().parents[2]


def require(value, label):
    if not value:
        raise AssertionError(label)


class LoopbackHTTPS(http.client.HTTPSConnection):
    def __init__(self, context, port):
        super().__init__(HOST, 443, context=context, timeout=90)
        self.fixture_port = port

    def connect(self):
        # SNI and hostname verification remain HOST; only the network destination
        # is the explicitly guarded loopback listener, never DNS/external hosts.
        raw = socket.create_connection(("127.0.0.1", self.fixture_port), timeout=self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=HOST)


def run():
    work = Path(os.environ.get("PBIN_WP_FIXTURE", ""))
    require(os.environ.get("PBIN_CONTROLLER_GATE") == "1" and os.environ.get("GITHUB_ACTIONS") == "true", "hosted disposable gate required")
    require(work.resolve() == work and work.name.startswith("pbin-wp-ci."), "canonical disposable directory required")
    require(re.fullmatch(r"pbin_ci_[a-f0-9]{24}", os.environ.get("PBIN_TEST_DB_NAME", "")), "random disposable database required")
    port = int(os.environ.get("PBIN_CONTROLLER_TLS_PORT", "18443"))
    require(1024 < port < 65536, "invalid TLS port")
    private = work / "controller-secrets.json"
    require(not private.is_symlink() and private.stat().st_mode & 0o077 == 0, "private credentials permissions")
    credentials = json.loads(private.read_text())
    artifact = json.loads((work / "controller-artifacts.json").read_text())
    context = ssl.create_default_context(cafile=str(work / "controller-cert.pem"))
    require(context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED, "TLS validation must remain enabled")
    auth = "Basic " + base64.b64encode((credentials["username"] + ":" + credentials["password"]).encode()).decode()
    other_auth = "Basic " + base64.b64encode((credentials["other_username"] + ":" + credentials["other_password"]).encode()).decode()
    cookie = credentials["cookie_name"] + "=" + credentials["cookie"]
    storage = work / "controller-private"

    def request(method, path, body=None, headers=None, *, authorized=False, chunked=False):
        require(path.startswith("/") and not path.startswith("//") and "\r" not in path and "\n" not in path, "relative fixture path required")
        outgoing = dict(headers or {})
        if authorized:
            outgoing["Authorization"] = auth
        connection = LoopbackHTTPS(context, port)
        try:
            connection.request(method, path, body=body, headers=outgoing, encode_chunked=chunked)
            response = connection.getresponse()
            data = response.read(8 * 1024 * 1024 + 1)
            require(len(data) <= 8 * 1024 * 1024, "bounded response required")
            return response.status, response.getheaders(), data
        finally:
            connection.close()

    def one(headers, name):
        values = [value for key, value in headers if key.lower() == name.lower()]
        require(len(values) == 1, "expected one " + name + " header")
        return values[0]

    def endpoint(n, suffix=""):
        return f"/wp-json/pbin-previews/v1/tenants/pr-{n}" + suffix

    def state(n, headers=None):
        status, _, body = request("GET", endpoint(n), headers=headers, authorized=headers is None)
        require(status == 200, "authorized status request")
        doc = json.loads(body)
        require(set(doc) == {"version", "tenant", "record"} and doc["version"] == 2 and doc["tenant"] == f"pr-{n}", "state envelope")
        return doc["record"]

    def post(n, suffix, value, expected=200):
        status, _, body = request("POST", endpoint(n, suffix), json.dumps(value).encode(), {"Content-Type": "application/json"}, authorized=True)
        require(status == expected, "JSON mutation response for " + suffix)
        return json.loads(body).get("record") if status == 200 else None

    def install(n, token=None, upgrade=False, expected=200, chunked=False):
        path = Path(artifact["upgrade_artifact" if upgrade else "artifact"])
        digest = artifact["upgrade_digest" if upgrade else "digest"]
        revision = artifact["upgrade_revision" if upgrade else "revision"]
        require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, "fixture archive changed")
        headers = {"Content-Type": "application/zip", "X-Pbin-Artifact-Sha256": digest, "X-Pbin-Expected-Token": token or "none"}
        if not chunked:
            headers["Content-Length"] = str(path.stat().st_size)
        with path.open("rb") as body:
            status, _, data = request("POST", endpoint(n, "/releases/" + revision), body, headers, authorized=True, chunked=chunked)
        require(status == expected, f"archive mutation pr-{n} upgrade={upgrade}: HTTP {status}, expected {expected}")
        if status == 200:
            record = json.loads(data)["record"]
            require(record["enabled"] and record["active"] == revision and record["releases"][revision]["artifact_sha256"] == digest, "installed artifact identity")
            return record
        return None

    def health(n, revision):
        nonce = secrets.token_hex(32)
        status, headers, body = request("GET", f"/previews/pr-{n}/health?" + urlencode({"pbin-health-nonce": nonce}), headers={"Cache-Control": "no-cache, no-store", "Pragma": "no-cache"})
        require(status == 200 and body == b"OK", "actual plugin health body")
        require(one(headers, "X-Pbin-Revision") == revision and one(headers, "X-Pbin-Health-Nonce") == nonce, "fresh nonce and exact selected revision")
        require("no-store" in {part.strip().lower() for part in one(headers, "Cache-Control").split(",")}, "uncacheable health")
        return headers

    def inventory():
        return sorted(str(path.relative_to(storage)) for path in storage.rglob("*"))

    def fixture_control(action):
        result = subprocess.run([os.environ.get("PHP_BIN", "php"), str(ROOT / "wordpress/ci/prepare-controller-site.php"), action], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode == 0, "disposable fixture control failed")

    baseline = inventory()
    invalid_zip = b"not a zip; authorization must reject before installation"
    bad_headers = {"Content-Type": "application/zip", "X-Pbin-Artifact-Sha256": hashlib.sha256(invalid_zip).hexdigest(), "X-Pbin-Expected-Token": "none"}
    route = endpoint(910201, "/releases/" + artifact["revision"])
    for credentials_headers in ({}, {"Authorization": "Basic " + base64.b64encode(b"invalid:invalid").decode()}, {"Authorization": other_auth}, {"Cookie": cookie}, {"Cookie": cookie, "X-WP-Nonce": "invalid"}):
        status, _, _ = request("POST", route, invalid_zip, bad_headers | credentials_headers)
        require(status == 403 and inventory() == baseline, "unauthorized request must reject before any spool/publication")
    cookie_headers = {"Cookie": cookie, "X-WP-Nonce": credentials["nonce"]}
    require(state(910201, cookie_headers) is None and state(910201) is None, "real admin nonce and scoped app-password paths")
    cookie_status, _, cookie_body = request("POST", endpoint(910204, "/retire"), b'{"expected_token":null}', {"Content-Type": "application/json"} | cookie_headers)
    require(cookie_status == 200 and json.loads(cookie_body)["record"]["enabled"] is False, "real administrator cookie mutation with REST nonce")
    query_route = "/?" + urlencode({"rest_route": "/pbin-previews/v1/tenants/pr-910201"})
    require(request("GET", query_route, headers=cookie_headers)[0] == 200, "query-form route with real cookie nonce")
    require(request("GET", query_route)[0] == 403, "query-form route remains private")
    fixture_control("deny-capability")
    require(request("GET", endpoint(910201), authorized=True)[0] == 403, "approved app principal without capability denied")
    fixture_control("restore-capability")
    require(request("DELETE", endpoint(910201), authorized=True)[0] == 405, "unknown method denied")
    require(request("POST", endpoint(910201, "/unknown"), b"{}", authorized=True)[0] == 404, "unknown controller route denied")
    require(request("POST", endpoint(910201, "/retire"), b'{"expected_token":null,"expected_token":null}', {"Content-Type": "application/json"}, authorized=True)[0] == 400, "duplicate JSON denied")
    require(request("POST", route, invalid_zip, bad_headers, authorized=True)[0] == 400, "authenticated invalid native ZIP denied")
    require(state(910201) is None, "invalid archive created registry state")
    require(set(inventory()) - set(baseline) <= {"releases/pr-910201", "data/pr-910201"}, "invalid archive left unexpected package/spool state")
    print("PASS: real WordPress REST cookie nonce/app-password/capability, routes and invalid body boundaries", flush=True)

    a = install(910201)
    health(910201, artifact["revision"])
    require(state(910201) == a, "health leaves token/state unchanged")
    require(install(910201, a["state_token"]) == a, "exact install no-op")
    install(910201, expected=409)
    b = install(910202, chunked=True)
    health(910202, artifact["revision"])
    require(request("GET", "/previews/pr-910201/health?pbin-health-nonce=invalid")[0] == 404, "bad health nonce denied")

    def mount(n):
        return f"/previews/pr-{n}"

    def form_request(method, path, values):
        return request(method, path, urlencode(values).encode(), {"Content-Type": "application/x-www-form-urlencoded"})

    def create(n, text):
        status, headers, _ = form_request("POST", mount(n) + "/paste", {"text": text, "lang": "text"})
        require(status == 301, "preview paste creation")
        location = one(headers, "Location")
        require(location.startswith(mount(n) + "/paste?"), "tenant-local paste redirect")
        return parse_qs(urlsplit(location).query)["id"][0]

    def raw(n, ident):
        return request("GET", mount(n) + "/paste?" + urlencode({"id": ident + ".txt"}))

    a_id = create(910201, "A original λ 😀")
    b_id = create(910202, "B unchanged λ 😀")
    status, _, snapshot_body = request("POST", mount(910201) + "/snapshot", urlencode({"id": a_id, "name": "checkpoint"}).encode(), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    require(status == 200, "A snapshot creation")
    snapshot = json.loads(snapshot_body)
    require(form_request("PUT", mount(910201) + "/paste", {"id": a_id, "text": "A updated", "lang": "python", "title": "A title"})[0] == 200, "A update")
    require(raw(910201, a_id)[2] == b"A updated" and raw(910202, b_id)[2].decode() == "B unchanged λ 😀", "tenant data independence")
    require(raw(910202, a_id)[0] == 404 and request("GET", mount(910202) + "/snapshot?" + urlencode({"id": snapshot["id"]}))[0] == 404, "cross-tenant IDs denied")
    require(request("GET", snapshot["url"] + ".txt")[2].decode() == "A original λ 😀", "immutable snapshot")
    asset = mount(910201) + "/_releases/" + artifact["revision"] + "/static/css/app.css"
    original_css = request("GET", asset)[2]

    upgraded = install(910201, a["state_token"], upgrade=True)
    require(one(health(910201, artifact["upgrade_revision"]), "X-Pbin-CI-Fixture") == "controller-upgraded", "actual upgraded PHP executed")
    health(910202, artifact["revision"])
    require(state(910202) == b and request("GET", asset)[2] == original_css, "B state and retained old assets unchanged")
    require(request("GET", asset.replace(artifact["revision"], artifact["upgrade_revision"]))[2] != original_css, "actual upgraded CSS selected")
    rolled = post(910201, "/rollback", {"expected_token": upgraded["state_token"], "revision": artifact["revision"]})
    require(rolled["state_token"] not in {a["state_token"], upgraded["state_token"]}, "rollback ABA fencing")
    health(910201, artifact["revision"])
    require(raw(910201, a_id)[2] == b"A updated" and raw(910202, b_id)[2].decode() == "B unchanged λ 😀", "data survives rollback")
    install(910201, a["state_token"], upgrade=True, expected=409)
    retired = post(910201, "/retire", {"expected_token": rolled["state_token"]})
    require(not retired["enabled"] and retired["releases"] == rolled["releases"], "retirement retains releases")
    require(request("GET", mount(910201) + "/health")[0] == 404 and request("GET", asset)[0] == 404, "retired code and assets unavailable")
    install(910201, rolled["state_token"], expected=409)
    post(910201, "/rollback", {"expected_token": rolled["state_token"], "revision": artifact["revision"]}, expected=409)
    tombstone = post(910203, "/retire", {"expected_token": None})
    require(tombstone["active"] is None and tombstone["releases"] == {} and not tombstone["enabled"], "absent-close tombstone")
    install(910203, expected=409)
    health(910202, artifact["revision"])
    require(state(910202) == b, "unrelated tenant state unchanged through all mutations")
    require(request("GET", "/health")[0] == 200, "ordinary WordPress plugin healthy")
    fixture_control("check-default")
    print("PASS: native ZIP install, real MySQL-selected nonce health, two-tenant data/assets, upgrade/rollback/ABA/retirement", flush=True)


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        # Assertion labels are fixed source strings. Never include response bodies,
        # exception text, headers, Basic auth, cookie values or secret file contents.
        label = str(error) if isinstance(error, AssertionError) else type(error).__name__
        sys.exit("Controller HTTPS gate failed: " + label)
