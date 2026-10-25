#!/usr/bin/env bash
# A second disposable hosted fixture, never a live host or local implementation run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Controller HTTP gate requires the fresh GitHub runner'; exit 1; }
: "${PBIN_SOURCE_SHA:?Provide the exact tested source revision}"
: "${PBIN_TEST_ARTIFACT:?Provide the exact previously tested package}"
: "${PBIN_TEST_ARTIFACT_SHA256:?Provide its exact SHA-256}"
export PBIN_CONTROLLER_GATE=1
export PBIN_CONTROLLER_ARTIFACT="$PBIN_TEST_ARTIFACT"
export PBIN_CONTROLLER_ARTIFACT_SHA256="$PBIN_TEST_ARTIFACT_SHA256"
# Do not prepare or modify the existing file-registry preview fixture.
unset PBIN_TEST_ARTIFACT PBIN_TEST_ARTIFACT_SHA256 PBIN_TEST_PREVIEW_ROOT PBIN_TEST_BASE_PATH PBIN_TEST_EDITOR_AT_BASE PBIN_TEST_RESULTS_DIR
bash "$ROOT/wordpress/ci/run-fixture.sh" bash "$ROOT/wordpress/ci/controller-contracts.sh"
