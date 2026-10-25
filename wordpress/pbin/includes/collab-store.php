<?php
defined('ABSPATH') || exit;
require_once __DIR__ . '/ot.php';

final class PBIN_CollabException extends RuntimeException {}

/** MySQL is the room authority, not a socket process's cached document. Every
 * mutation holds the same paste/room locks and commits paste+revision+history+seq
 * together. There is no delayed save capable of overwriting a newer HTTP PUT. */
final class PBIN_CollabStore {
    public const SCHEMA_VERSION = '1';
    public const MAX_DOCUMENT = 2 << 20;
    public const MAX_HISTORY = 2000;
    private $db;
    private string $prefix;
    private int $historyMax;

    public function __construct($db = null, int $historyMax = self::MAX_HISTORY) {
        if ($historyMax < 2 || $historyMax > self::MAX_HISTORY) { throw new InvalidArgumentException('invalid history limit'); }
        $this->db = $db ?? $GLOBALS['wpdb'];
        $this->prefix = $this->db->prefix . 'pbin_';
        $this->historyMax = $historyMax;
    }

    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $prefix = $wpdb->prefix . 'pbin_'; $collate = $wpdb->get_charset_collate();
        $id = 'varchar(36) CHARACTER SET ascii COLLATE ascii_bin';
        dbDelta("CREATE TABLE {$prefix}rooms (
            paste_id $id NOT NULL,
            session_id $id NOT NULL,
            revision bigint unsigned NOT NULL DEFAULT 0,
            hist_base bigint unsigned NOT NULL DEFAULT 0,
            doc_utf16 longblob NOT NULL,
            language longtext NOT NULL,
            title longtext NOT NULL,
            PRIMARY KEY  (paste_id)
        ) ENGINE=InnoDB $collate;");
        dbDelta("CREATE TABLE {$prefix}history (
            paste_id $id NOT NULL,
            revision bigint unsigned NOT NULL,
            operation longtext NOT NULL,
            client_key varbinary(64) NOT NULL,
            PRIMARY KEY  (paste_id,revision)
        ) ENGINE=InnoDB $collate;");
        dbDelta("CREATE TABLE {$prefix}sequences (
            paste_id $id NOT NULL,
            client_key varbinary(64) NOT NULL,
            last_seq bigint unsigned NOT NULL,
            PRIMARY KEY  (paste_id,client_key)
        ) ENGINE=InnoDB $collate;");
        foreach (['rooms', 'history', 'sequences'] as $table) {
            if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($prefix . $table))) !== $prefix . $table) {
                throw new RuntimeException('pbin collaboration database migration failed');
            }
        }
        update_option('pbin_collab_schema_version', self::SCHEMA_VERSION, false);
    }

    private function query(string $query) {
        $result = $this->db->query($query);
        if ($result === false) { throw new RuntimeException('pbin collaboration database query failed'); }
        return $result;
    }
    private function row(string $query): ?array {
        $row = $this->db->get_row($query, ARRAY_A);
        if ($this->db->last_error) { throw new RuntimeException('pbin collaboration database read failed'); }
        return $row;
    }
    private function rows(string $query): array {
        $rows = $this->db->get_results($query, ARRAY_A);
        if ($this->db->last_error) { throw new RuntimeException('pbin collaboration history read failed'); }
        return $rows ?? [];
    }
    private function insert(string $table, array $data): void {
        if ($this->db->insert($this->prefix . $table, $data) === false) { throw new RuntimeException('pbin collaboration database insert failed'); }
    }
    private function update(string $table, array $data, array $where): void {
        if ($this->db->update($this->prefix . $table, $data, $where) === false) { throw new RuntimeException('pbin collaboration database update failed'); }
    }
    private function transaction(callable $fn) {
        $this->query('START TRANSACTION');
        try {
            $result = $fn();
            $this->query('COMMIT');
            return $result;
        } catch (Throwable $error) {
            $this->db->query('ROLLBACK');
            // Never retry an uncertain COMMIT or acknowledge a failed write.
            // Reconnecting with the same client key/sequence resolves a commit
            // that reached MySQL but whose response was lost.
            throw $error;
        }
    }
    private static function normalize(string $text): string { return str_replace(["\r\n", "\r"], "\n", $text); }
    private static function key(string $key): string {
        if (strlen($key) > 64) { throw new InvalidArgumentException('client key too long'); }
        return $key;
    }

    /** Lock ordering is always paste, then room, then history/sequence. */
    private function lockRoom(string $id): array {
        $paste = $this->row($this->db->prepare("SELECT * FROM {$this->prefix}pastes WHERE id=%s FOR UPDATE", $id));
        if ($paste === null) { throw new PBIN_CollabException('paste not found'); }
        $room = $this->row($this->db->prepare("SELECT * FROM {$this->prefix}rooms WHERE paste_id=%s FOR UPDATE", $id));
        if ($room === null) {
            $room = ['paste_id' => $id, 'session_id' => wp_generate_uuid4(), 'revision' => 0, 'hist_base' => 0,
                'doc_utf16' => PBIN_UTF16::fromUTF8(self::normalize($paste['text'])), 'language' => $paste['language'], 'title' => $paste['title']];
            $this->insert('rooms', $room);
        }
        $room['revision'] = (int) $room['revision']; $room['hist_base'] = (int) $room['hist_base'];
        return $room;
    }
    private function lastSeq(string $id, string $key): int {
        if ($key === '') { return 0; }
        $row = $this->row($this->db->prepare("SELECT last_seq FROM {$this->prefix}sequences WHERE paste_id=%s AND client_key=%s", $id, $key));
        return $row === null ? 0 : (int) $row['last_seq'];
    }
    private function state(array $room, string $key = ''): array {
        return ['text' => PBIN_UTF16::toUTF8($room['doc_utf16']), 'lang' => $room['language'], 'title' => $room['title'],
            'rev' => $room['revision'], 'session' => $room['session_id'], 'lastSeq' => $this->lastSeq($room['paste_id'], $key), 'histBase' => $room['hist_base']];
    }
    private function history(array $room, int $revision): array {
        if ($revision < $room['hist_base'] || $revision > $room['revision']) { throw new PBIN_CollabException('resync'); }
        $rows = $this->rows($this->db->prepare("SELECT revision,operation,client_key FROM {$this->prefix}history WHERE paste_id=%s AND revision>%d AND revision<=%d ORDER BY revision", $room['paste_id'], $revision, $room['revision']));
        if (count($rows) !== $room['revision'] - $revision) { throw new PBIN_CollabException('resync'); }
        return $rows;
    }

    public function load(string $id, string $key = ''): array {
        self::key($key);
        return $this->transaction(fn() => $this->state($this->lockRoom($id), $key));
    }

    /** Persist an operation already transformed to the current revision. */
    private function applyLocked(array $room, PBIN_TextOp $op, string $key, int $seq = 0, ?string $rawPasteText = null, bool $enforceEditorLimit = true): array {
        if ($enforceEditorLimit && $op->targetLength() > self::MAX_DOCUMENT) { throw new PBIN_CollabException('document too large'); }
        $document = $op->Apply($room['doc_utf16']);
        if ($room['revision'] === PHP_INT_MAX) { throw new PBIN_CollabException('revision limit reached'); }
        $room['doc_utf16'] = $document; ++$room['revision'];
        $this->insert('history', ['paste_id' => $room['paste_id'], 'revision' => $room['revision'], 'operation' => $op->MarshalJSON(), 'client_key' => $key]);
        if ($room['revision'] - $room['hist_base'] > $this->historyMax) {
            $room['hist_base'] = $room['revision'] - intdiv($this->historyMax, 2);
            $this->query($this->db->prepare("DELETE FROM {$this->prefix}history WHERE paste_id=%s AND revision<=%d", $room['paste_id'], $room['hist_base']));
        }
        $this->update('rooms', ['revision' => $room['revision'], 'hist_base' => $room['hist_base'], 'doc_utf16' => $document, 'language' => $room['language'], 'title' => $room['title']], ['paste_id' => $room['paste_id']]);
        $text = PBIN_UTF16::toUTF8($document);
        $this->update('pastes', ['text' => $rawPasteText ?? $text, 'language' => $room['language'], 'title' => $room['title']], ['id' => $room['paste_id']]);
        if ($key !== '' && $seq > 0) {
            $this->query($this->db->prepare("INSERT INTO {$this->prefix}sequences (paste_id,client_key,last_seq) VALUES (%s,%s,%d) ON DUPLICATE KEY UPDATE last_seq=VALUES(last_seq)", $room['paste_id'], $key, $seq));
        }
        return ['rev' => $room['revision'], 'op' => $op->wire(), 'session' => $room['session_id'], 'key' => $key, 'text' => $text, 'lang' => $room['language'], 'title' => $room['title']];
    }

    public function apply(string $id, int $rev, int $seq, string $key, array $wire): array {
        self::key($key); $op = PBIN_TextOp::fromWire($wire);
        return $this->transaction(function () use ($id, $rev, $seq, $key, $op) {
            $room = $this->lockRoom($id);
            if ($key !== '' && $seq > 0 && $seq <= $this->lastSeq($id, $key)) { throw new PBIN_CollabException('duplicate operation'); }
            foreach ($this->history($room, $rev) as $entry) {
                [$op] = PBIN_TextOp::TransformOps($op, PBIN_TextOp::fromJSON($entry['operation']));
            }
            return $this->applyLocked($room, $op, $key, $seq);
        });
    }

    public function replace(string $id, string $text, string $lang, string $title): array {
        return $this->transaction(function () use ($id, $text, $lang, $title) {
            $room = $this->lockRoom($id);
            $op = (new PBIN_TextOp())->Delete(PBIN_UTF16::length($room['doc_utf16']))->InsertString(self::normalize($text));
            $room['language'] = $lang; $room['title'] = $title;
            // Preserve the HTTP raw-text contract (including CRLF). The live
            // editor normalizes newlines, as Go does, and the next live edit
            // persists its normalized document. This does not delay any write.
            // The public raw HTTP API accepts larger documents than the live
            // editor. Keep replacement atomic even for those documents; only
            // incoming collaborative edits enforce the 2 Mi code-unit cap.
            return $this->applyLocked($room, $op, '', 0, $text, false);
        });
    }

    public function setLanguage(string $id, string $language): array {
        if (strlen($language) > 64) { throw new PBIN_CollabException('language too long'); }
        return $this->transaction(function () use ($id, $language) {
            $room = $this->lockRoom($id); $changed = $room['language'] !== $language;
            if ($changed) {
                $this->update('rooms', ['language' => $language], ['paste_id' => $id]);
                $this->update('pastes', ['language' => $language], ['id' => $id]);
            }
            return ['rev' => $room['revision'], 'lang' => $language, 'changed' => $changed];
        });
    }

    public function changesSince(string $id, int $revision): array {
        return $this->transaction(function () use ($id, $revision) {
            $room = $this->lockRoom($id); $changes = [];
            foreach ($this->history($room, $revision) as $entry) {
                $changes[] = ['rev' => (int) $entry['revision'], 'op' => PBIN_TextOp::fromJSON($entry['operation'])->wire(), 'key' => $entry['client_key']];
            }
            // Language/title are included even without a new text revision.
            return ['rev' => $room['revision'], 'session' => $room['session_id'], 'histBase' => $room['hist_base'], 'lang' => $room['language'], 'title' => $room['title'], 'changes' => $changes];
        });
    }
}
