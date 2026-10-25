"""Offline fixture guard/TLS-routing/artifact tests; no listener, DB, or real credentials."""
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / 'wordpress/ci'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, CI / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class ControllerFixtureTests(unittest.TestCase):
    def test_proxy_rejects_nonfixture_before_reading_credentials(self):
        proxy = module('fixture_proxy', 'controller-https-proxy.py')
        with patch.dict(os.environ, {'PBIN_CONTROLLER_GATE': '', 'PBIN_WP_FIXTURE': '/tmp', 'PBIN_ACCEPTANCE_URL': 'http://external.invalid:8080'}, clear=True):
            with self.assertRaises(ValueError):
                proxy.settings()

    def test_proxy_only_accepts_loopback_backend_and_bounded_port(self):
        proxy = module('fixture_proxy', 'controller-https-proxy.py')
        with tempfile.TemporaryDirectory(prefix='pbin-wp-ci.') as temp:
            work = Path(temp).resolve()
            (work / 'controller-secrets.json').write_text(json.dumps({'proxy_marker': 'a' * 64}))
            env = {'PBIN_CONTROLLER_GATE': '1', 'GITHUB_ACTIONS': 'true', 'PBIN_WP_FIXTURE': str(work), 'PBIN_ACCEPTANCE_URL': 'http://127.0.0.1:18081'}
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(proxy.settings()[1:3], (18081, 18443))
                for backend in ['https://127.0.0.1:18081', 'http://localhost:18081', 'http://external.invalid:18081', 'http://user:pass@127.0.0.1:18081', 'http://127.0.0.1:18081/path']:
                    with patch.dict(os.environ, {'PBIN_ACCEPTANCE_URL': backend}):
                        with self.assertRaises(ValueError):
                            proxy.settings()
                with patch.dict(os.environ, {'PBIN_CONTROLLER_TLS_PORT': '443'}):
                    with self.assertRaises(ValueError):
                        proxy.settings()

    def test_client_pins_loopback_transport_and_validated_server_name(self):
        client = module('fixture_client', 'controller-http-contract.py')
        context = Mock()
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        connection = client.LoopbackHTTPS(context, 18443)
        raw = object()
        with patch.object(client.socket, 'create_connection', return_value=raw) as connect:
            connection.connect()
        connect.assert_called_once_with(('127.0.0.1', 18443), timeout=90)
        context.wrap_socket.assert_called_once_with(raw, server_hostname='controller-fixture.invalid')

    def test_hosted_wrapper_refuses_local_execution_without_starting_server(self):
        result = subprocess.run(['bash', str(CI / 'run-controller-fixture.sh')], env={'PATH': os.environ['PATH'], 'CI': 'false', 'GITHUB_ACTIONS': 'false'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('fresh GitHub runner', result.stdout)

    def test_authenticated_fixture_never_tails_raw_error_logs(self):
        source = (CI / 'run-fixture.sh').read_text()
        function = source.split('# BEGIN bounded fixture diagnostics', 1)[1].split('\n', 1)[1].split('# END bounded fixture diagnostics', 1)[0]
        self.assertIn('if [[ "$status" != 0 ]]; then fixture_failure_logs; fi', source)
        self.assertIn('"$WORK/install.log" || { fixture_failure_logs; exit 1; }', source)
        with tempfile.TemporaryDirectory() as work:
            for log in ('install', 'php', 'wp-debug'):
                Path(work, log + '.log').write_text('SYNTHETIC_PRIVATE_ERROR_TEXT\n')
            for protected in ('1', ''):
                env = dict(os.environ, WORK=work, PBIN_CONTROLLER_GATE=protected)
                result = subprocess.run(['bash', '-c', function + '\nfixture_failure_logs'], env=env,
                                        capture_output=True, text=True, check=True)
                if protected:
                    self.assertEqual(result.stdout, 'Authenticated controller fixture failed; raw logs withheld\n')
                else:
                    self.assertEqual(result.stdout.count('SYNTHETIC_PRIVATE_ERROR_TEXT'), 3)
                self.assertEqual(result.stderr, '')

    def test_artifact_preparation_uses_exact_sha_and_separate_upgrade(self):
        with tempfile.TemporaryDirectory(prefix='pbin-wp-ci.') as temp:
            work = Path(temp).resolve()
            source = work / 'source'
            (source / 'static/css').mkdir(parents=True)
            (source / 'pbin.php').write_text('<?php // inert test entry\n')
            (source / 'runtime.php').write_text('<?php\nnamespace Pbin\\Plugin;\n')
            (source / 'static/css/app.css').write_text('body { color: black; }\n')
            revision = 'a' * 40
            result = subprocess.run([sys.executable, str(ROOT / 'wordpress/tools/package.py'), '--source', str(source), '--revision', revision, '--output', str(work / 'original.zip')], check=True, capture_output=True, text=True)
            original = json.loads(result.stdout)
            env = dict(os.environ, PBIN_CONTROLLER_GATE='1', PBIN_WP_FIXTURE=str(work), PBIN_CONTROLLER_ARTIFACT=str(work / 'original.zip'), PBIN_CONTROLLER_ARTIFACT_SHA256=original['artifact_sha256'], PBIN_SOURCE_SHA=revision)
            prepared = subprocess.run([sys.executable, str(CI / 'prepare-controller-artifacts.py')], env=env, capture_output=True, text=True)
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            records = json.loads((work / 'controller-artifacts.json').read_text())
            self.assertEqual(records['revision'], revision)
            self.assertNotEqual(records['upgrade_revision'], revision)
            self.assertNotEqual(records['upgrade_digest'], records['digest'])
            self.assertEqual(Path(records['artifact']), work / 'original.zip')
            checked = subprocess.run([sys.executable, str(ROOT / 'wordpress/tools/package.py'), '--verify', records['upgrade_artifact'], '--sha256', records['upgrade_digest'], '--revision', records['upgrade_revision']], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == '__main__':
    unittest.main()
