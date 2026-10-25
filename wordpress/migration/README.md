# Offline legacy BoltDB migration

This is an **operator-run, dry-run-first tool**, not a migration receipt or an
automatic production cutover. No real backup, production database, credential,
application network endpoint or live service was accessed to develop it. The checked-in
fixture is entirely synthetic. Real WordPress/MySQL integration is a separate
pending hosted gate. The application still needs no Go server or Go runtime.

The tools are outside `wordpress/pbin`, are not packaged into the plugin, and
register no WordPress hook, public endpoint, cron job or auto-upgrade. The PHP
files refuse non-CLI execution. Do not copy this directory into a web root.

## Source inventory and compatibility boundary

The inspected public legacy source is
[`store.go` at `38c4267`](https://github.com/r33drichards/pastebin-public/blob/38c4267/store.go).
It implements **BoltDB**, not SQLite, and also has a separate DynamoDB backend.
The actual deployed backend and backup completeness still need operator
verification. This exporter supports only an explicitly supplied offline BoltDB
backup. It does not connect to DynamoDB or discover/open `pbin.db` automatically.

| Legacy bucket | Source fields, in export order | Default WordPress table columns |
| --- | --- | --- |
| pastes | PK, SK, Language, Text, Title | id, created_at, language, text, title |
| diffs | PK, SK, OldText, NewText | id, created_at, old_text, new_text |
| snapshots | PK, SK, PasteID, Name, Language, Text, Title | id, created_at, paste_id, name, language, text, title |
| snapshot_index | PasteID + NUL + SK + NUL + PK -> PK | Validated completely; represented by the existing snapshot index |

Mapping is identity, not generated UUIDs: each Bolt key must equal its record's
PK, which must have the UUID shape produced by the legacy code. Case is retained.
Every source field must be an explicitly present JSON string. Text, whitespace,
CRLF, empty strings, Unicode (including combining characters/emoji), NULs,
language, titles and snapshot names are preserved byte-for-byte. They are not
sanitized, trimmed, re-encoded with replacement characters or sent to providers.
Diffs contain old/new text, not paste-ID references; none are invented.

Important non-lossless/unsupported cases are **refused**, never silently skipped:

- Missing fields (including an older record with no Title), explicit nulls,
  unknown fields/buckets, nested buckets, duplicate JSON keys, invalid UTF-8,
  unpaired UTF-16 surrogate escapes and malformed/trailing JSON. Although Go's
  struct decoder may treat an absent Title like `""`, WordPress cannot preserve
  the distinction, so this tool does not silently collapse it.
- Unknown/non-UUID IDs, mismatches between key and PK, orphan snapshots,
  dangling/stale/missing/duplicate snapshot-index entries. Pre-snapshot databases
  may omit both snapshot buckets if there are no snapshots.
- Invalid timestamps or source timestamps exceeding the existing `varchar(30)`
  width. Normal RFC3339 paste/diff offsets and fixed nine-digit UTC snapshot
  timestamps fit and are retained exactly. A nanosecond timestamp with a numeric
  offset can exceed 30 bytes and is refused rather than normalized/truncated.
  The source has no separate paste-edit timestamp, so none can be reconstructed.
- Corrupt Bolt structure, changed backup bytes during reading, source/export
  bounds, incompatible destination schema/charset, trigger or foreign-key
  side effects, preview-instance targets and all differing existing target rows.

The existing public snapshot API deliberately renders `CreatedAt` to whole UTC
seconds; the underlying `SK`/`created_at` retains all nine source fractional
digits. This existing presentation behavior is not a lossy data conversion.
Snapshot history uses the unchanged raw timestamp and ID ordering, including
same-timestamp ties.

## Hard resource bounds

- Regular, non-symlink offline database file: 1 GiB maximum.
- Source JSON record and each row's total UTF-8 field bytes: 4 MiB maximum.
- All record field bytes together: 32 MiB maximum; at most 100,000 records.
- Export JSON: 64 MiB maximum, with a bounded parser depth of 16.
- Target: at most 1,000,000 rows per imported table. Every prepared insert must
  fit the destination's `max_allowed_packet` with a 1 KiB margin.

For this bounded in-memory implementation, budget 512 MiB or more for the CLI
processes. An oversized dataset requires a separately reviewed streaming or
batched migration design. There is no limit-bypass, skip-errors, chunked commit,
repair, delete, overwrite or upsert switch.

## Export an explicitly approved offline backup

Do not export a live writable database. Arrange an approved write freeze and
consistent backup using the deployment's supported backup procedure; copy the
backup to a private operator workspace. Keep the original backup untouched.
Never commit or publish a real backup, export, IDs, row hashes or receipts.
All operator stdout and stderr must go to new private mode-0600 receipt/log files
inside a trusted mode-0700 directory. Set `umask 077` and enable shell noclobber
before creating them; never reuse an existing permissive file or stream real-data
commands into shared terminal/CI logs. The examples assume that private directory
already exists and has been verified by the operator.

The one-shot export module pins [maintained bbolt 1.4.3](https://github.com/etcd-io/bbolt/releases/tag/v1.4.3),
the [Bolt-compatible maintained fork](https://github.com/etcd-io/bbolt/blob/v1.4.3/README.md).
It has no AWS dependency, server, credential lookup or live-database discovery.
Build it on a trusted machine with Go 1.23+ (tested locally with 1.24.8);
dependency download happens only at build time, not while the compiled exporter
handles the backup. Actual archived-Bolt compatibility is tested separately,
not inferred from a new-writer/new-reader-only roundtrip.

```sh
umask 077
set -o noclobber
GO_BIN=go PHP_BIN=php bash wordpress/ci/check-legacy-import-unit.sh
cd wordpress/migration/bolt-export
go mod verify
go build -mod=readonly -o /private/operator/pbin-bolt-export .
/private/operator/pbin-bolt-export \
  --backup=/private/operator/approved-offline-backup.db \
  --out=/private/operator/export.json \
  > /private/operator/export-receipt.json 2> /private/operator/export.stderr
```

The exporter opens Bolt with `ReadOnly: true`, runs its structural check and a
read transaction, checks all records and the snapshot index, and checks the
source SHA-256 before/after. It never opens a write transaction. Output is
deterministic for the same backup and is created with mode 0600. Publication
uses a complete temporary file and a no-overwrite hard link in the same
directory; an existing output file, including a symlink, is never overwritten.
No export is published if validation fails. A failed read identifies the bucket
and record ordinal where possible without logging text, titles or IDs.

The compact canonical JSON includes counts, each record's SHA-256 and a logical
content SHA-256. Row hashing uses `pbin-row-v1` + NUL + bucket name + NUL, then
each string's decimal UTF-8 byte length, `:`, and original bytes. Content hashing
uses `pbin-content-v1\n` followed by each row digest and `\n`, ordered by pastes,
diffs, snapshots and bytewise ID. Backup-file and export-file SHA-256 values are
separate from that logical digest. These hashes detect changes, not authorship;
the operator must obtain the backup and expected export hash from a trusted
source. No external person/service receives them automatically.

## Dry run and reviewed apply

Use PHP 8.1+ with the target site's trusted local WordPress core and an existing
default pbin schema. The command loads core in SHORTINIT mode, not active
plugins or preview routing. Use a fresh dedicated CLI process with query logging
disabled. Supply the exact canonical `wp-load.php` path, `DB_NAME`, export hash
from the export receipt, and `{$wpdb->prefix}pbin_` table prefix. There are no
inferred source/destination defaults or credentials in CLI arguments.

Before the global-scope WordPress bootstrap, the importer installs a non-removable
PHP output buffer that discards ordinary echo/print output, disables display/error
logging for its dedicated process, and converts ordinary unsuppressed bootstrap
warnings/exceptions to one fixed generic refusal. Bootstrap output is a failure;
exit/die/wp_die, even exit(0), receives a generic shutdown refusal and nonzero exit.
Global include semantics are preserved. No database operation is attempted after
those failures. The importer writes its own final receipt explicitly to STDOUT.

This is **not a sandbox or a universal logging guarantee**. Trusted wp-config.php,
db.php/other drop-ins and PHP startup configuration can write directly to STDOUT or
STDERR, create custom logs/processes, or override error handling. Direct descriptor
writes and configured log destinations bypass PHP buffering. Audit those trusted
files/settings and keep **all** operator stdout/stderr and configured PHP/WordPress
logs private even on an early bootstrap failure. Do not expose raw diagnostics or
claim that suppress_errors/SAVEQUERIES checks retroactively sanitized bootstrap.

The database account needs SELECT metadata/data access and, for apply, INSERT
on the three default pbin tables. TRIGGER metadata is hidden without TRIGGER
privilege: this tool requires a provable explicit direct TRIGGER or ALL
PRIVILEGES grant on the relevant tables, database or server before accepting an
empty trigger list. Role-only visibility is conservatively refused. It never
grants privileges; any access change needs separate operator authorization.
InnoDB, utf8mb4 throughout the connection and text columns, ascii_bin ID columns,
the exact existing column/index shapes and no target triggers/foreign keys are
required. No schema is installed or repaired by import.

```sh
umask 077
set -o noclobber
php -d memory_limit=512M wordpress/migration/import.php \
  --export=/private/operator/export.json \
  --export-sha256=EXACT_EXPORT_SHA256 \
  --wordpress-load=/absolute/site/wp-load.php \
  --database=EXACT_DB_NAME --table-prefix=wp_pbin_ \
  > /private/operator/dry-run.json 2> /private/operator/dry-run.stderr
```

Default reconciliation issues SELECT/SHOW only, with no transaction, INSERT,
UPDATE, DELETE or DDL. Review source/target counts, insert/identical/conflict
counts, content digest and target-bound `plan_sha256`. Differing existing IDs
produce a bounded hash-only conflict sample and exit 2. Identical existing rows
are safe no-ops; unrelated destination rows are retained, not treated as deleted
source rows. No plan is authorization to discard either side of a conflict.

After approving the backup, target, dry run, restore/rollback drill and write
freeze, repeat the command with all three explicit apply flags:
Use new private apply receipt/stderr filenames; preserve the reviewed dry-run
files rather than overwriting them.

```sh
  --apply --expect-plan-sha256=REVIEWED_PLAN_SHA256 --offline-writes-confirmed
```

This assertion does not freeze writers for you. Stop writes from the old Go
service, WordPress, other CLI jobs and any other database writers independently.
Production mutation/cutover still requires the user's explicit approval.

Apply starts one transaction, enables strict SQL mode only on its short-lived
connection (wpdb normally removes strict modes), repeats the reviewed plan under
row/metadata locks, inserts only absent IDs, checks warning counts, reads back
every imported field byte-for-byte and checks final counts before commit. No
existing row is rewritten, even when identical. Inserts have connection-ID and
per-transaction session-token guards so wpdb reconnect/replay cannot silently
autocommit on a replacement connection. A conflicting or stale plan, lost
connection, insert/readback failure or unexpected count causes rollback.

An interrupted transaction rolls back on connection close. If COMMIT may have
succeeded but its response was lost, exit 3 reports `commit-uncertain`; never
blindly retry. Keep writes frozen, run a fresh read-only reconciliation, and
review it. A successful prior commit yields all identical rows; an uncommitted
attempt yields the original insert plan. Obtain a new plan before applying.
Record source identity, exact importer revision, source/export/content digests,
counts and apply receipt privately. A successful import does not change routes.

## Verification and CI proposal

Run the independent offline gate, without replacing or skipping existing gates:

```sh
PHP_BIN=php GO_BIN=go bash wordpress/ci/check-legacy-import-unit.sh
bash wordpress/ci/check-unit.sh
```

The offline gate requires Go 1.23+, PHP 8.1+ and a C compiler for Go's race gate.
It makes a synthetic database with the **actual archived Bolt 1.3.1 writer** in a
separate, normal non-race subprocess, then reads that file using the maintained
bbolt exporter under both normal and `-race`/checkptr tests. Source bytes, records
and logical digest must match exactly. The old writer is a separate nested Go
module under `tests/legacy-writer`, accepts only a new output filename, and reads
only the digest-pinned checked-in synthetic JSON. It is not a dependency of the
exporter/importer and must never handle real data. This isolation is deliberate:
archived Bolt's writer crashes Go 1.24.8 checkptr in `Bucket.write` during fixture
creation. No checkptr/race checks are disabled for the maintained reader, and no
race-safety claim is made for that archived test-only writer.

Additional maintained-writer fixtures check unchanged source bytes and
deterministic export; PHP verifies both generated
and checked-in fixtures and exercises loss/refusal cases, Unicode,
nanoseconds, plans, conflicts, no-op reruns, interruption at each insert,
readback mismatch, commit uncertainty and reconnection-fenced SQL. Fake SQL
tests do **not** establish real MySQL behavior.

Required hosted gates (execution results are still pending, not implied by YAML):

1. `Required offline legacy migration checks` runs `check-legacy-import-unit.sh`
   alongside every existing PHP/JS/package gate. Its toolchain is Go 1.24.8 via
   exact-pinned official `actions/setup-go` v5.5.0, with C compiler/race support.
2. `Real WordPress legacy migration MySQL gate` runs
   `bash wordpress/ci/run-fixture.sh bash wordpress/ci/check-legacy-import.sh`
   against a fresh disposable fixture and the exact extracted plugin, separately
   from all retained HTTP/browser gates. It rejects non-local/non-random/non-fixture
   databases and verifies
   actual insert/readback, trigger metadata admission, transaction rollback,
   collisions, idempotence, public store/history behavior and preservation of
   every non-target table present in that fixture, then invokes the real CLI dry
   run. The separate existing two-tenant database gate remains required.
   Both step names must succeed in the trusted client's evidence. The complete
   migration source, dependency pins and fixtures are protected recipe inputs;
   a successful old workflow lacking these gates is not accepted.
3. The same MySQL gate also launches bounded, independent CLI subprocesses in
   that exact disposable loopback fixture. It SIGKILLs a writer after a real
   uncommitted insert, proves rollback and lock release, observes an InnoDB
   `LOCK WAIT` before releasing a competing same-ID writer, and verifies the
   loser cannot overwrite the winner. It kills only the verified worker's own
   database connection, then proves wpdb reconnection/replay refuses insertion
   rather than autocommitting on the new connection. Test-only row cleanup is
   limited to the exact synthetic winning ID; fixture fingerprints must match.
   A further bounded loopback packet proxy forwards the fixture's unchanged
   MySQL handshake/authentication and SQL, waits for the server's genuine OK to
   `COMMIT`, then closes the connection without forwarding any reply byte. It
   permits the actual wpdb reconnect, requires `CommitUncertain`, and verifies
   committed bytes and an identical-row dry run through an independent direct
   connection. It refuses TLS/compression rather than downgrading settings, logs
   no packets/credentials, accepts no remote target and lives at most 60 seconds.
   These are required hosted tests, not claims of passing until that exact head
   succeeds. Pure packet tests and exception doubles cannot close the real
   protocol-loss gate.
4. Retain all existing canonical HTTP, database-tenancy, browser/runner, native
   ZIP verification and package-provenance requirements. Do not publish a real
   backup/export as a CI artifact. The migration module is not added to pbin.zip.

No MySQL listener or local HTTP server was started during implementation. Hosted
results and any target Wasmer CLI/memory/permission limitations remain pending.

## Cutover and rollback gates still required

1. Inventory the **actual** deployed DB_TYPE, record counts, canonical/legacy
   links and complete backup location. Do not infer completeness from a working
   editor. Never delete the original service or backup as repository cleanup.
2. Rehearse on an isolated restored copy with the exact release and migration
   revision. Verify counts, hashes, every imported field, raw IDs, immutable
   snapshot history, diffs, and canonical route/browser/runner behavior.
3. Take verified pre-import WordPress and legacy backups and rehearse restoration.
   Establish the write-freeze start, owner, routing switch and rollback criteria.
   Since pastes have no edit timestamp, there is no trustworthy timestamp-only
   delta: take a final frozen backup and rerun the complete reconciliation. New
   target conflicts stop the process; this importer never merges them.
4. Change the redirect only after approved import/release/restore receipts and
   canonical routing tests. Preserve the old service and all backups throughout
   the explicitly agreed rollback window.
5. Before allowing post-cutover WordPress writes, prove how rollback retains
   those writes. This tool is **one-way** and is not a WordPress-to-Bolt delta
   exporter. A rollback to an old legacy backup would lose later writes and is
   unacceptable. Either keep the same authoritative WordPress data while
   rolling back only the compatible plugin release, or implement/rehearse an
   approved reverse reconciliation of all new/edited pastes, diffs and snapshots
   under a second freeze before returning to Go. Retaining a WordPress backup
   without making its later writes available does not prove a complete rollback.

Until those operational and hosted gates are met, this is migration tooling and
synthetic evidence only, not a claim that issue #2 or production cutover is done.
