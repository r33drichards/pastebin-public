# The supported application backend is WordPress/PHP/MySQL.
unit:
    bash wordpress/ci/check-unit.sh

package revision output="/tmp/pbin.zip":
    python3 wordpress/tools/package.py --source wordpress/pbin --revision "{{revision}}" --output "{{output}}"

# Requires the disposable database/core/artifact variables in wordpress/ci/README.md.
integration:
    bash wordpress/ci/run-fixture.sh bash wordpress/ci/run-contracts.sh
