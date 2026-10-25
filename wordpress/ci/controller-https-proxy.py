#!/usr/bin/env python3
"""Disposable loopback HTTPS-to-loopback HTTP proxy; no global CA changes/logged headers."""
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import ssl
import sys
from urllib.parse import urlsplit


def settings():
    work = Path(os.environ.get("PBIN_WP_FIXTURE", ""))
    backend = urlsplit(os.environ.get("PBIN_ACCEPTANCE_URL", ""))
    port = int(os.environ.get("PBIN_CONTROLLER_TLS_PORT", "18443"))
    if (os.environ.get("PBIN_CONTROLLER_GATE") != "1" or os.environ.get("GITHUB_ACTIONS") != "true"
            or work.resolve() != work or not work.name.startswith("pbin-wp-ci.")
            or backend.scheme != "http" or backend.hostname != "127.0.0.1"
            or backend.username or backend.password or backend.path or backend.query or backend.fragment
            or not backend.port or not 1024 < port < 65536):
        raise ValueError("Invalid disposable loopback proxy settings")
    secrets = json.loads((work / "controller-secrets.json").read_text())
    if not re.fullmatch(r"[0-9a-f]{64}", secrets["proxy_marker"]):
        raise ValueError("Invalid disposable proxy marker")
    return work, backend.port, port, secrets["proxy_marker"]


def serve():
    work, backend_port, port, marker = settings()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def forward(self):
            connection = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=90)
            try:
                if self.headers.get("Host") != "controller-fixture.invalid" or not self.path.startswith("/") or self.path.startswith("//"):
                    self.send_error(400, "Invalid fixture target")
                    return
                connection.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
                connection.putheader("Host", "controller-fixture.invalid")
                connection.putheader("X-Pbin-Fixture-Tls", marker)
                connection.putheader("Connection", "close")
                for name, value in self.headers.items():
                    if name.lower() not in {"host", "connection", "x-pbin-fixture-tls", "expect"}:
                        connection.putheader(name, value)
                connection.endheaders()
                transfer = self.headers.get("Transfer-Encoding")
                if transfer:
                    if transfer.lower() != "chunked":
                        raise ValueError("Unsupported fixture transfer")
                    total = 0
                    while True:
                        line = self.rfile.readline(128)
                        if not re.fullmatch(rb"[0-9a-fA-F]{1,8}\r\n", line):
                            raise ValueError("Invalid chunk framing")
                        size = int(line[:-2], 16)
                        total += size
                        if total > 70 * 1024 * 1024:
                            raise ValueError("Fixture proxy request bound")
                        connection.send(line)
                        if not size:
                            if self.rfile.read(2) != b"\r\n":
                                raise ValueError("Trailers not supported by fixture")
                            connection.send(b"\r\n")
                            break
                        remaining = size
                        while remaining:
                            data = self.rfile.read(min(131072, remaining))
                            if not data:
                                raise ValueError("Truncated body")
                            connection.send(data)
                            remaining -= len(data)
                        if self.rfile.read(2) != b"\r\n":
                            raise ValueError("Invalid chunk terminator")
                        connection.send(b"\r\n")
                else:
                    length = self.headers.get("Content-Length", "0")
                    if not re.fullmatch(r"[0-9]{1,8}", length) or int(length) > 70 * 1024 * 1024:
                        raise ValueError("Fixture proxy request bound")
                    remaining = int(length)
                    while remaining:
                        data = self.rfile.read(min(131072, remaining))
                        if not data:
                            raise ValueError("Truncated body")
                        connection.send(data)
                        remaining -= len(data)
                response = connection.getresponse()
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() not in {"connection", "transfer-encoding", "content-length"}:
                        self.send_header(name, value)
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    while data := response.read(131072):
                        self.wfile.write(data)
                self.close_connection = True
            except (OSError, ValueError, http.client.HTTPException):
                # No exception text, URLs, headers or credentials enter logs.
                self.close_connection = True
            finally:
                connection.close()

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = forward

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(work / "controller-cert.pem", work / "controller-key.pem")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print("READY", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        serve()
    except Exception:
        sys.exit("Disposable loopback HTTPS proxy failed")
