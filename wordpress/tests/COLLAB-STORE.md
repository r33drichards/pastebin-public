# Transactional collaboration storage checks

`includes/collab-store.php` owns canonical room revisions in MySQL. It uses the
same `wpdb` connection/prefix as ordinary paste storage and requires the ordinary
paste migration before `PBIN_CollabStore::install()`.

API:

- `load(id, key='')`: text, lang, title, rev, session, lastSeq, histBase.
- `apply(id, rev, seq, key, wireArray)`: rev, transformed op, session, key, text,
  lang, title. Duplicate sequences, stale/future revisions, invalid operations
  and oversized documents are rejected without changing state.
- `replace(id, text, lang, title)`: the same operation result. Replacement becomes
  a revision in the same ordered history as WebSocket edits.
  Raw HTTP replacements are not subject to the live editor's 2 Mi UTF-16 limit;
  incoming collaborative operations remain capped and may shrink a larger raw
  document back below that limit. Large replacements remain atomically coherent,
  rather than reproducing the Go active-room stale-save inconsistency.
- `setLanguage(id, lang)`: rev, lang, changed. As in Go, a language change does not
  create a text revision; it atomically updates room and paste metadata.
- `changesSince(id, rev)`: rev, session, histBase, lang, title, changes. Each change
  contains rev, op and key. Metadata is included even when there is no text change.

Transactions always lock the paste row and then its room row, followed by history
and sequence records. This consistent lock order serializes HTTP replacement and
all WebSocket workers, including initial room creation. Paste text, binary UTF-16
room document, revision, operation history and sequence acknowledgment are committed
together. A failed or uncertain commit is never automatically retried or acknowledged.
A client reconnecting with the same key/sequence can resolve an uncertain response.

The history limit is 2000, compacted to 1000 like the Go implementation. Tests use
the optional constructor limit of 4 to cover repeated compaction efficiently. A
revision older than histBase must reload; missing history is never silently skipped.
Sessions and client sequences persist across socket-process restarts. History is
bounded; session/sequence reclamation is deliberately not implemented without a
safe lifecycle policy, since deleting active dedup state can duplicate edits.

Initial room loads normalize CRLF/CR to LF without mutating the raw paste. HTTP
replacement keeps the exact submitted raw text in the paste row while recording
normalized live-editor text, matching the original split until a live edit next
saves. Unicode surrogate halves remain intact in the room's LONGBLOB; conversion
to UTF-8 at the JSON/paste boundary replaces unpaired halves like Go.

Run the real MySQL tests after creating an isolated HTTP fixture:

```sh
PBIN_WP_TOOLCHAIN=/path/to/toolchain bash wordpress/tests/run-http-acceptance.sh
# Copy the retained fixture path printed by that command:
PBIN_WP_TOOLCHAIN=/path/to/toolchain \
PBIN_WP_FIXTURE=/tmp/pbin-wp-acceptance.XXXXXX \
  bash wordpress/tests/run-collab-store-tests.sh
```

All processes run within one command so they share the same local networking
namespace. The second runner restarts only the disposable fixture database; it
does not start or configure an external service. The test refuses a non-fixture
WordPress directory or a database not named `pbin_acceptance`.

The large-raw-HTTP regression was checked acceptance-first: the new independent
test passes on the Go reference, failed with WordPress's accidental inherited OT
cap (500 instead of 200), then passed after the raw replacement exemption. A
separate active-room reference probe confirmed an existing Go inconsistency:
PUT of 2,097,153 bytes returned 200 and initially read back completely, but the
active room's delayed save restored the previous 8-byte text after 2.4 seconds.
This port deliberately keeps the replacement and live revision coherent instead
of copying that data-loss behavior. Live edits remain subject to the original
2 Mi code-unit cap and can reduce a larger raw document below it.

Coverage includes idempotent migrations, load/init, synchronous raw persistence,
durable sequence deduplication, stale/future revisions, transaction rollback on
invalid/oversized operations, history replay/compaction, stable sessions, normalized
newlines, binary surrogate storage and subsequent Unicode edits. It also runs 20
two-process races behind an actual database row-lock barrier: ten edit/edit races
and ten HTTP-replacement/edit races, verifying revision ordering, no lost updates,
metadata preservation and canonical paste/history agreement. This is independent
of, and does not replace, the repository's black-box HTTP/WebSocket acceptance tests.
