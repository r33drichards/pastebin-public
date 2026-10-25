# WordPress execution boundary: release gate

The browser runners are retained for compatibility, not certified as a security
sandbox. **Production promotion remains blocked on a real execution boundary.**
A passing runtime regression or the response guard below does not close this
release gate. Do not test an untrusted paste against a real signed-in session.

## Defense in depth implemented now

Every plugin-rendered document is private/no-store and varies by Cookie. The
central template renderer returns script-free plain text with restrictive CSP
instead of HTML when WordPress reports any signed-in user (403), or when the
WordPress authentication function is unavailable (503). It covers canonical,
alias and preview routes because they share the same renderer. It guards future
templates too rather than maintaining a list of runner-bearing routes. Guest
rendering and the existing runner assets are unchanged. Plain-text/API and health
responses are not execution documents and remain available.

The unit gate checks all five current templates for guest, authenticated and
uninitialized-auth states, with synthetic booleans only. It checks denial status,
absence of scripts/paste content, future-template denial and retained guest
runner loading. It is not a browser-origin, cache/CDN or adversarial test.

## Why this is not sufficient isolation

- A guest page or worker can remain alive while another tab subsequently signs
  into WordPress. Authentication is not immutable for a browser profile.
- Worker files are also physically present under public `wp-content` URLs;
  PHP document policy is not a blanket server policy for those files.
- `runReactCode` transforms JSX and calls `new Function` in the editor page.
  It therefore shares page authority, not just a worker's authority.
- Python uses Pyodide with the JavaScript bridge, including debugger evaluation.
- JS/TS debugging executes instrumented JavaScript in a worker. Deleting a few
  worker globals is capability reduction, not a proof of confinement.
- Clojure uses SCI/Scittle in its worker; JavaScript interop requires isolation.
- TLA+, Runno/WASI and QuickJS have different runtime/module-loading contracts.
  A claim about one engine cannot be transferred to all engines.
- Cross-origin isolation (COOP/COEP and SharedArrayBuffer availability) is not
  isolation from the page origin, and is not a credential boundary.

## Deployment design needed before release

A dedicated **cookie-free execution origin** is the clearest boundary. This must
not be a hostname that receives domain-wide WordPress/admin/provider cookies.
Host only immutable, verified runner assets there, with no admin UI, provider
secrets or privileged endpoints. The WordPress editor remains a host UI and sends
bounded code/input messages to a sandboxed runner frame. The frame owns JSX DOM
rendering and every worker/debugger/runtime, including imports and output files.

The message protocol must validate exact frame/source, origin where non-opaque,
per-frame nonce, request identity, message shape and output limits. Do not accept
arbitrary fetch URLs, HTML injection, navigation commands or authentication data
from the frame. Termination must tear down the whole runtime context. Debug
shared-memory support needs explicit COOP/COEP/CORP/CORS validation across the
chosen host and frame; do not silently relax sandboxing to recover it.

An opaque iframe sandbox (`allow-scripts` without `allow-same-origin`) may avoid
provisioning another origin, but is not a drop-in wrapper here. Existing runners
use same-origin Worker URLs, dynamic imports, CDN resources, local storage and
SharedArrayBuffer. Asset loading, opaque-origin CORS and credentialed network
behavior must be proven for every runtime; restoring `allow-same-origin` to fix
those errors would undo the intended boundary. An opaque frame alone is not a
claim that credential-bearing cross-origin requests cannot be sent. Do not use
this path without an explicit network/credential design and compatibility proof.

## Required verification and approvals

1. Approve the concrete execution origin, cookie-domain separation and any new
   hosting/configuration changes. No new service or DNS change is made by this
   document or the response guard.
2. Implement the frame bridge and move all execution paths out of the privileged
   editor realm; include Run, debug/step/watch/evaluate, imports, JSX, preview,
   repeated execution, cancellation and persisted/restored tabs.
3. Run normal positive/negative capability tests in disposable fixtures: host UI
   continues working, frame cannot operate on host DOM/storage, output protocol
   rejects wrong sources/nonces and oversized/malformed messages, later login in
   another tab does not grant runtime authority, and runtime assets still load.
   This is a verification plan, not permission to rerun a previously denied test.
4. Verify actual deployment headers, cookies, CDN caching and every preserved
   language family on the selected configuration before removing this gate.
