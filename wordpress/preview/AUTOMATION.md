# Trusted PR preview client: disabled, proposed integration

`wordpress/tools/preview_client.py` is a real standard-library policy and HTTPS
client with offline tests. It is **not evidence that the REST controller is
installed, a credential exists, or a preview has deployed**. Production is not
addressed by this client. The fixed destination is
`https://pbin-staging.wasmer.app`; there is no arbitrary URL setting.

The `.example` workflow in `workflow-templates/` is deliberately outside
`.github/workflows` and does not execute. Existing secretless `ci.yml` is unchanged.
The CLI also rejects every operation unless `PBIN_PREVIEWS_ENABLED` is exactly
`true`, numeric reviewed IDs are configured, the checkout matches a reviewed
40-character `PBIN_CONTROL_SHA`, and the expected GitHub event/run is authenticated.
No real credentials or host mutations were used to test this code.

## Scope of trust

Only repository `r33drichards/pastebin-public` and authenticated GitHub account
`r33drichards` are trusted initially. Repository/owner numeric IDs must be recorded
from GitHub and reviewed; a matching display name, commit email, PR description,
label, or claimed author never grants authority. The upstream run's `actor` and
`triggering_actor`, the current PR author, and the control event actors must match
the one allowed numeric account and login. No forks or additional actors qualify.
A trusted author does not need an impossible approval of their own PR.

Trusted PHP on shared staging can access the WordPress process's database and
filesystem. Per-PR tables and pointers provide functional isolation, not a sandbox.
Never add untrusted contributors/forks or production secrets to this design.

## Promotion gates

The client re-reads GitHub REST API data rather than trusting artifact metadata or
an event's prose. It checks repository identity, open PR and exact current head,
same-repository head, CI workflow numeric ID and `.github/workflows/ci.yml` path,
successful completed `pull_request` run, unique PR association, both expected
successful jobs from the current attempt, and all named critical test steps.
Skipped tests are failures for deployment purposes. REST run paths may include a
bounded `@ref` suffix; only the exact expected path before it is accepted, and the
numeric workflow resource must independently report the exact path and active
state. The suffix is never used as a checkout ref or an authorization source.

Both the PR head and the recorded PR base must have exactly the reviewed baseline's
workflow, packager, loader/selector, and complete test/fixture trees (`wordpress/ci`,
`wordpress/tests`, `e2e`, `acceptance`). Tree SHA comparisons include additions,
deletions and modes, not only existing filenames. Truncated API results fail closed.
This is deliberately strict: legitimate changes to tests or the CI recipe require
reviewing a new control baseline, not a bypass or an automatically accepted pin.
The current immutable artifact is then downloaded from that exact CI run.

Artifact checks include its GitHub-reported SHA-256, exact name
`pbin-wordpress-SHA`, current run/repository/head IDs, nonexpiry, bounded size, and
creation during the successful artifact job's attempt. Missing GitHub digests or
ambiguous artifacts fail, even if download-artifact would merely warn. The outer
ZIP must contain exactly `pbin.zip`, `build.json`, and `SHA256SUMS`, all bounded
regular files. The nested archive is validated with the **pinned** `package.py`,
including every content digest, manifest inventory, revision, path and size limit.
Nothing downloaded is executed, imported, sourced or used to construct commands.

After downloading and verification, the client rechecks the upstream run/attempt,
reads the staging state, and re-reads the PR immediately before sending the mutation.
GitHub read errors and any mismatch stop promotion. This narrows but cannot make
GitHub and the separate staging database one atomic transaction; the close-event
reconciler and random token compare-and-swap protect against stale operations.

## Proposed REST contract, not installed by this change

All requests use the fixed HTTPS origin. JSON replies have exactly:

```json
{"version":2,"tenant":"pr-8","record":null}
```

`record: null` means absent. Otherwise `record` is exactly:

```json
{
  "state_token":"64 lowercase hexadecimal characters",
  "enabled":true,
  "active":"40 lowercase hexadecimal commit characters",
  "releases":{
    "40 lowercase hexadecimal commit characters":{
      "artifact_sha256":"64 lowercase hexadecimal characters",
      "manifest_sha256":"64 lowercase hexadecimal characters"
    }
  }
}
```

The active SHA must be in `releases`, including for a disabled tenant. Only an empty
retirement tombstone has `active: null`, `enabled: false`, `releases: {}`. An absent
tenant retirement must create that tombstone with a random 32-byte state token.
Every changed state rotates the token; exact no-ops compare the token first and
preserve it. Tokens must not be restored/reused during rollback (ABA protection).

- GET `/wp-json/pbin-previews/v1/tenants/pr-N` returns that envelope, HTTP 200.
- POST `/wp-json/pbin-previews/v1/tenants/pr-N/releases/SHA` receives raw ZIP bytes,
  `Content-Type: application/zip`, `X-Pbin-Artifact-Sha256`, and
  `X-Pbin-Expected-Token` (literal `none` only when initially absent).
- POST `/wp-json/pbin-previews/v1/tenants/pr-N/retire` receives
  `{"expected_token":null}` or the exact initially observed token.
- POST `/wp-json/pbin-previews/v1/tenants/pr-N/rollback` receives
  `{"expected_token":"TOKEN_RETURNED_BY_INSTALL","revision":"PRIOR_SHA"}`.
- Successful mutations return the resulting envelope with HTTP 200 or 201.
  CAS conflicts use 409 or 412, with no client token refresh/retry.

Install replies must confirm enabled state, the requested active SHA, its exact
artifact digest, and valid token rotation (or an identical no-op). The public health probe carries **no authorization** and uses a new random
32-byte lowercase-hex challenge on every request:
`/previews/pr-N/health?pbin-health-nonce=NONCE`. It sends request headers
`Cache-Control: no-cache, no-store` and `Pragma: no-cache`. Success requires HTTP
200, the `OK` body, one `X-Pbin-Revision` equal to the promoted full SHA, one
`X-Pbin-Health-Nonce` equal to the challenge, and one `Cache-Control` containing
`no-store` without a conflicting public/immutable/positive-age directive. A
positive or duplicated `Age` header also fails. Missing, duplicated, mismatched,
redirected or cacheable responses never count as healthy. Header multiplicity is
preserved rather than silently collapsed to a dictionary.

The trusted loader must stamp revision from the selected context and validate/echo
one bounded 64-lowerhex nonce **only on the exact health route**, replacing any
PR-provided values at header emission. It must not synthesize a healthy body:
the actual application health handler still has to return `OK`. An older cached
success for the same SHA fails because its nonce cannot match the new challenge.
This is freshness checking, not a sandbox or cryptographic attestation of trusted
branch PHP. A successful health result also requires the registry token/state to
remain unchanged after the probe. A failed new revision
may restore only the initially saved enabled release, confirmed retained with its
original digests, using the token returned by this client's install. A failed first
release is retired with that token. If the PR state/head changed, or a newer tenant
state wins, the operation stops rather than overriding it. A failed health check
on an unchanged/no-op installation is reported without fabricating rollback state.

The server must authorize a dedicated preview-management capability, validate the
ZIP again with the matching verifier, enforce registry CAS and budgets atomically,
and expose no production management operation. Do not wire this client to a mock
server and label that a working Wasmer deployment.

## Credential and transport boundary

The application password is only read from the staging environment's secret and
sent as Basic auth to the one fixed staging HTTPS origin. Creating that password,
its persistent access and any environment/permission changes require explicit
user approval at action time. Store no credential in repository files, artifacts,
logs, PR comments or command arguments. Never use a production/admin credential.

Neither staging auth nor GitHub auth follows a redirect. GitHub artifact downloads
permit only HTTPS storage redirects issued by the authenticated API, under
`.blob.core.windows.net` or `.actions.githubusercontent.com`, without GitHub auth.
Unknown storage hosts fail closed and require review. Signed URLs and response
bodies never appear in client errors. Timeouts/server errors after a mutation cause
one read-only state inspection and an uncertain result; they do not replay the
request or authorize using a newer token. A future fresh run must start again with
current GitHub eligibility, not just refresh the database token.

## Activation checklist (not performed)

1. Review and test the controller and registry protocol against disposable MySQL
   and the actual staging host; confirm persistent volume/HTTPS capability and
   secret isolation. Confirm staging budget and quota without upgrading a plan.
2. Approve and create the narrowly scoped staging credential and protected GitHub
   `staging-previews` environment. Record reviewed numeric repository, owner, and
   CI workflow IDs. Do not widen the actor list.
3. Review the complete client/packager/recipe at an immutable commit, configure its
   `PBIN_CONTROL_SHA`, and validate the live GitHub JSON schemas and artifact digest
   semantics. Update the baseline only through another explicit review.
4. Review/copy the proposed workflow to `.github/workflows/preview-reconcile.yml`
   on the default branch. Its `workflow_run` event checks the existing secretless
   CI; `pull_request_target` is **closed-only cleanup** and never checks out PR code.
   It has read-only GitHub permissions and no package install/caches. Protect the
   default-branch control workflow from unreviewed changes.
5. Set IDs and staging username variables, then explicitly enable
   `PBIN_PREVIEWS_ENABLED=true`. Both a configured pin and the enable flag are
   required. The example uses per-PR staging concurrency groups, with
   `cancel-in-progress: false`, to serialize each tenant across events.
6. Prove two-PR create/edit/snapshot isolation, upgrade/rollback of only one tenant,
   close cleanup, close-versus-build and concurrent-token conflicts, and no effect
   on production. Failures require investigation, not a claim of acceptance.

GitHub concurrency groups may replace an older **pending** run, even with
`cancel-in-progress: false`. The per-PR group avoids dropping another tenant's
cleanup, and a late successful CI event for an already-closed trusted PR performs
retirement instead of promotion. Each run reconciles current state rather than
replaying old desired state. Events can still be missed during outages or disabled
workflow periods; the client is not a periodic full-repository cleanup mechanism.
Decide on a reviewed recovery sweep before relying on unattended lifecycle cleanup.

## GitHub event identity review

GitHub documents `github.actor` as the original run initiator; rerun
`github.triggering_actor` can be different, while reruns retain the original
actor's privileges. Both authenticated REST identities remain separately required
here. The repository owner is not a substitute for either actor or the PR author.
The official Octokit completed-event example includes `sender`, `workflow_run.actor`
and `workflow_run.triggering_actor`; it does not establish they are universally
equal. GitHub also warns that unresolved event senders can be the `ghost` account.
This client deliberately rejects missing/ghost/bot/unallowlisted identities, rather
than inheriting trust from a familiar name or treating a service event as permission.

No actual completed-event payload from this repository's deployment workflow has
been collected. Capture and review only the necessary non-secret identity fields
before activation, including an original run and rerun; do not dump complete
contexts/tokens into logs. If the real event differs, investigate it without
silently adding accounts or weakening the policy.

Sources: [GitHub contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context),
[webhook sender semantics](https://docs.github.com/en/webhooks/webhook-events-and-payloads#the-sender-property),
[official completed-event example](https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/workflow_run/completed.payload.json).

## Offline verification

```sh
python3 -m unittest discover -s wordpress/tests -p 'test_preview_client.py' -v
bash wordpress/ci/check-unit.sh
```

The existing CI recipe remains unchanged, so its `check-unit.sh` does not yet run
the new client tests. Run these tests separately during control-plane review;
adding them to CI changes the reviewed recipe and needs a new control baseline.
These tests use only fake records, synthetic archives and injected transports.
They are not real GitHub or Wasmer acceptance tests.

References: [GitHub artifacts REST API](https://docs.github.com/en/rest/actions/artifacts),
[workflow runs REST API](https://docs.github.com/en/rest/actions/workflow-runs),
[workflow jobs REST API](https://docs.github.com/en/rest/actions/workflow-jobs),
[workflow event security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
