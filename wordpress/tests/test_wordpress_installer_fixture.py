"""Offline checks of the hosted WordPress installer gate; no local DB/listener."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / 'wordpress/ci'


class WordPressInstallerFixtureTests(unittest.TestCase):
    def test_guard_refuses_non_hosted_execution_before_archive_reads(self):
        source = (CI / 'run-fixture.sh').read_text()
        guard = source.split('# BEGIN guarded WordPress installer fixture', 1)[1].split('# END guarded WordPress installer fixture', 1)[0]
        for ci, github in [('', ''), ('true', ''), ('', 'true')]:
            env = dict(os.environ, PBIN_INSTALLER_GATE='1', CI=ci, GITHUB_ACTIONS=github)
            result = subprocess.run(['bash', '-c', guard], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, 'WordPress installer gate requires the fresh hosted fixture\n')
            self.assertEqual(result.stderr, '')

    def test_installer_gate_never_preplaces_plugin(self):
        source = (CI / 'run-fixture.sh').read_text()
        self.assertIn('if [[ "${PBIN_INSTALLER_GATE:-}" != 1 ]]; then\n    ln -s "$PLUGIN"', source)
        install = (CI / 'install.php').read_text()
        self.assertLess(install.index("require __DIR__ . '/install-package.php'"), install.index("activate_plugin('pbin/pbin.php')"))
        gate = (CI / 'install-package.php').read_text()
        self.assertIn("$rejected->install($canonical", gate)
        self.assertIn("incompatible_archive_no_plugins", gate)
        self.assertIn("$rejection = $rejected->skin->result;", gate)
        self.assertIn("$result === true || !is_wp_error($rejection)", gate)
        self.assertIn("$upgrader->install($installer", gate)
        self.assertIn("$actual !== $expected", gate)
        self.assertIn("$upgrader->plugin_info() !== 'pbin/pbin.php'", gate)
        self.assertNotIn('get_error_message(', gate)

    def test_installer_gate_is_mandatory_and_recipe_pinned(self):
        import sys
        sys.path.insert(0, str(ROOT / 'wordpress/tools'))
        import preview_client
        self.assertIn('Install standard ZIP through WordPress Plugin_Upgrader', preview_client.TEST_STEPS)
        self.assertIn('Transfer tested WordPress installer', preview_client.TEST_STEPS)
        self.assertIn('Verify transported WordPress installer', preview_client.ARTIFACT_STEPS)
        self.assertIn('Retain exact tested WordPress installer', preview_client.ARTIFACT_STEPS)
        self.assertIn('wordpress/tools/wordpress_installer.py', preview_client.RECIPE_FILES)
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('PBIN_INSTALLER_GATE:', workflow)
        self.assertIn('run-fixture.sh node --test wordpress/ci/canonical-http-contract.test.mjs', workflow)
        self.assertIn('name: pbin-wordpress-installer-${{ env.PBIN_SOURCE_SHA }}', workflow)
        self.assertIn('python3 wordpress/tools/wordpress_installer.py verify --installer installer/', workflow)


if __name__ == '__main__':
    unittest.main()
