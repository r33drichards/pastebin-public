"""Offline fixture guard/TLS-routing/artifact tests; no listener, DB, or real credentials."""
import importlib.util
import json
import os
import re
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

    def test_wrapper_preserves_wordpress_rest_namespace_with_canonical_mount(self):
        path = CI / 'run-controller-fixture.sh'
        prefix = path.read_text().split('bash "$ROOT/wordpress/ci/run-fixture.sh"', 1)[0]
        env = dict(os.environ, CI='true', GITHUB_ACTIONS='true', PBIN_SOURCE_SHA='a' * 40,
                   PBIN_TEST_ARTIFACT='/unused.zip', PBIN_TEST_ARTIFACT_SHA256='b' * 64,
                   PBIN_TEST_BASE_PATH='/wrong', PBIN_TEST_EDITOR_AT_BASE='0')
        result = subprocess.run(['bash', '-c', prefix + '\nprintf "%s %s" "$PBIN_TEST_BASE_PATH" "$PBIN_TEST_EDITOR_AT_BASE"', str(path)],
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '/paste 1')
        self.assertEqual(result.stderr, '')
        self.assertIn('request("GET", "/paste/health")', (CI / 'controller-http-contract.py').read_text())

    def test_large_post_setting_is_bounded_and_only_for_hosted_controller(self):
        source = (CI / 'run-fixture.sh').read_text()
        setting = source.split('# BEGIN bounded fixture POST setting', 1)[1].split('# END bounded fixture POST setting', 1)[0]
        self.assertIn('-d "post_max_size=$POST_MAX_SIZE"', source)
        cases = [('', '', '', 0, '16M'), ('1', 'true', 'true', 0, '70M'),
                 ('1', '', '', 1, None), ('1', 'true', '', 1, None)]
        for gate, ci, github, status, value in cases:
            env = dict(os.environ, PBIN_CONTROLLER_GATE=gate, CI=ci, GITHUB_ACTIONS=github)
            result = subprocess.run(['bash', '-c', setting + '\nprintf "%s" "$POST_MAX_SIZE"'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, status)
            if value is not None:
                self.assertEqual(result.stdout, value)
            else:
                self.assertIn('requires the hosted fixture', result.stdout)
            self.assertEqual(result.stderr, '')

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

    def test_trusted_controller_copy_list_contains_all_control_modules(self):
        source = (CI / 'prepare-controller-site.php').read_text()
        copy_list = next(line for line in source.splitlines() if "foreach ([" in line and "$pbinControllerSource . '/control/'" in line)
        copied = set(re.findall(r"'([a-z-]+\.php)'", copy_list.split("] as $file)", 1)[0]))
        expected = {path.name for path in (ROOT / 'wordpress/preview/control').glob('*.php')}
        self.assertEqual(copied, expected)
        self.assertIn('quota-recipe.php', copied)
        self.assertIn('static-assets.php', copied)

    def test_preview_http_fixture_copies_trusted_static_server(self):
        with tempfile.TemporaryDirectory(prefix='pbin-wp-ci.') as temp:
            work = Path(temp).resolve()
            source = work / 'source'
            (source / 'static/css').mkdir(parents=True)
            (source / 'pbin.php').write_text('<?php // inert test entry\n')
            (source / 'runtime.php').write_text('<?php\nnamespace Pbin\\Plugin;\n')
            (source / 'static/css/app.css').write_text('body { color: black; }\n')
            artifact = work / 'original.zip'
            result = subprocess.run([sys.executable, str(ROOT / 'wordpress/tools/package.py'), '--source', str(source), '--revision', 'a' * 40, '--output', str(artifact)], check=True, capture_output=True, text=True)
            digest = json.loads(result.stdout)['artifact_sha256']
            env = dict(os.environ, PBIN_WP_FIXTURE=str(work), PBIN_WP_TEST_SITE=str(work / 'site'), PBIN_TEST_ARTIFACT=str(artifact), PBIN_TEST_ARTIFACT_SHA256=digest)
            subprocess.run([sys.executable, str(CI / 'prepare-previews.py')], env=env, capture_output=True, text=True, check=True)
            target = work / 'site/wp-content/mu-plugins/pbin-preview'
            for name in ('loader.php', 'selector.php', 'health.php', 'control/static-assets.php'):
                self.assertEqual((target / name).read_bytes(), (ROOT / 'wordpress/preview' / name).read_bytes())
            self.assertFalse((target / 'control/quota-recipe.php').exists(), 'File fixture is not a MySQL control-plane deployment')

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
