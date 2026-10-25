<?php
defined('ABSPATH') || exit;

/** Storage has no serialized PHP objects and never uses WordPress posts/options
 * for user documents. Snapshots intentionally expose no update/delete method. */
final class PBIN_Store {
    public const SCHEMA_VERSION = '1';
    private $db;
    private string $prefix;

    public function __construct($db = null) {
        $this->db = $db ?? $GLOBALS['wpdb'];
        $this->prefix = $this->db->prefix . 'pbin_';
    }

    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $prefix = $wpdb->prefix . 'pbin_';
        $collate = $wpdb->get_charset_collate();
        $id = 'varchar(36) CHARACTER SET ascii COLLATE ascii_bin';
        dbDelta("CREATE TABLE {$prefix}pastes (
            id $id NOT NULL,
            created_at varchar(30) NOT NULL,
            language longtext NOT NULL,
            text longtext NOT NULL,
            title longtext NOT NULL,
            PRIMARY KEY  (id)
        ) ENGINE=InnoDB $collate;");
        dbDelta("CREATE TABLE {$prefix}diffs (
            id $id NOT NULL,
            created_at varchar(30) NOT NULL,
            old_text longtext NOT NULL,
            new_text longtext NOT NULL,
            PRIMARY KEY  (id)
        ) ENGINE=InnoDB $collate;");
        dbDelta("CREATE TABLE {$prefix}snapshots (
            id $id NOT NULL,
            paste_id $id NOT NULL,
            created_at varchar(30) NOT NULL,
            name longtext NOT NULL,
            language longtext NOT NULL,
            text longtext NOT NULL,
            title longtext NOT NULL,
            PRIMARY KEY  (id),
            KEY paste_created (paste_id,created_at,id)
        ) ENGINE=InnoDB $collate;");
        dbDelta("CREATE TABLE {$prefix}limits (
            bucket char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            available_at double NOT NULL,
            PRIMARY KEY  (bucket),
            KEY expiry (available_at)
        ) ENGINE=InnoDB $collate;");
        foreach (['pastes', 'diffs', 'snapshots', 'limits'] as $table) {
            if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($prefix . $table))) !== $prefix . $table) {
                throw new RuntimeException('pbin database migration failed');
            }
        }
        update_option('pbin_schema_version', self::SCHEMA_VERSION, false);
    }

    private function insert(string $table, array $row): void {
        if ($this->db->insert($this->prefix . $table, $row) === false) {
            throw new RuntimeException('pbin database insert failed');
        }
    }

    private function row(string $table, string $id): array {
        $row = $this->db->get_row($this->db->prepare("SELECT * FROM {$this->prefix}{$table} WHERE id = %s", $id), ARRAY_A);
        if (!$row) {
            if ($this->db->last_error) {
                throw new RuntimeException('pbin database read failed');
            }
            throw new OutOfBoundsException('record not found');
        }
        return $row;
    }

    private static function paste(array $r): array {
        return ['PK' => $r['id'], 'ID' => $r['id'], 'SK' => $r['created_at'], 'Text' => $r['text'], 'Language' => $r['language'], 'Title' => $r['title']];
    }

    private static function nowUTC(): DateTimeImmutable {
        return new DateTimeImmutable('now', new DateTimeZone('UTC'));
    }

    private static function snapshotCreatedAt(string $value): string {
        // DateTime keeps its own wide timestamp even on wasm32 PHP. Passing
        // through strtotime()/gmdate() would truncate dates outside 1901–2038.
        // As in Go's snapshotCreatedAt, preserve an invalid stored value rather
        // than turning it into the Unix epoch or interpreting relative text.
        if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})$/D', $value)) {
            return $value;
        }
        try {
            $date = new DateTimeImmutable(str_replace(',', '.', $value));
            $errors = DateTimeImmutable::getLastErrors();
            if ($errors !== false && ($errors['warning_count'] || $errors['error_count'])) { return $value; }
            return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
        } catch (Exception $error) {
            return $value;
        }
    }

    private static function snapshot(array $r): array {
        return self::paste($r) + ['PasteID' => $r['paste_id'], 'Name' => $r['name'], 'CreatedAt' => self::snapshotCreatedAt($r['created_at'])];
    }

    public function AddPaste(string $text, string $lang, string $title = ''): string {
        $id = wp_generate_uuid4();
        $this->insert('pastes', ['id' => $id, 'created_at' => self::nowUTC()->format('Y-m-d\TH:i:s\Z'), 'language' => $lang, 'text' => $text, 'title' => $title]);
        return $id;
    }

    public function GetPaste(string $id): array { return self::paste($this->row('pastes', $id)); }

    public function UpdatePaste(string $id, string $text, string $lang, string $title = ''): void {
        // A no-op update affects zero rows; distinguish it from a missing paste.
        $this->GetPaste($id);
        if ($this->db->update($this->prefix . 'pastes', ['text' => $text, 'language' => $lang, 'title' => $title], ['id' => $id]) === false) {
            throw new RuntimeException('pbin database update failed');
        }
    }

    public function AddDiff(string $old, string $new): string {
        $id = wp_generate_uuid4();
        $this->insert('diffs', ['id' => $id, 'created_at' => self::nowUTC()->format('Y-m-d\TH:i:s\Z'), 'old_text' => $old, 'new_text' => $new]);
        return $id;
    }

    public function GetDiff(string $id): array {
        $r = $this->row('diffs', $id);
        return ['PK' => $id, 'ID' => $id, 'SK' => $r['created_at'], 'OldText' => $r['old_text'], 'NewText' => $r['new_text']];
    }

    public function AddSnapshot(string $pasteID, string $name, string $text, string $lang, string $title): array {
        // Verify the parent exists even for non-HTTP callers.
        $this->GetPaste($pasteID);
        if ($name === '') {
            $adverbs = ['quietly', 'brightly', 'gently', 'happily', 'swiftly', 'calmly'];
            $adjectives = ['brave', 'gentle', 'nimble', 'cheerful', 'clever', 'curious'];
            $animals = ['otter', 'panda', 'heron', 'falcon', 'badger', 'sailfish'];
            $name = $adverbs[random_int(0, 5)] . '-' . $adjectives[random_int(0, 5)] . '-' . $animals[random_int(0, 5)];
        }
        $id = wp_generate_uuid4();
        $now = self::nowUTC();
        $this->insert('snapshots', ['id' => $id, 'paste_id' => $pasteID, 'created_at' => $now->format('Y-m-d\TH:i:s.u') . '000Z', 'name' => $name, 'language' => $lang, 'text' => $text, 'title' => $title]);
        return $this->GetSnapshot($id);
    }

    public function GetSnapshot(string $id): array { return self::snapshot($this->row('snapshots', $id)); }

    public function ListSnapshots(string $pasteID): array {
        $rows = $this->db->get_results($this->db->prepare("SELECT id,paste_id,created_at,name,language,title,'' AS text FROM {$this->prefix}snapshots WHERE paste_id = %s ORDER BY created_at DESC,id DESC", $pasteID), ARRAY_A);
        if ($this->db->last_error) { throw new RuntimeException('pbin snapshot listing failed'); }
        return array_map([self::class, 'snapshot'], $rows);
    }

    /** Atomic per-client/per-route limiter. Hash client addresses with the site's
     * salt; do not trust X-Forwarded-For supplied by a public client. */
    public function AllowRequest(string $route, float $rate): bool {
        $bucket = hash_hmac('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . "\0" . $route, wp_salt('nonce'));
        $now = microtime(true);
        $table = $this->prefix . 'limits';
        $this->db->query($this->db->prepare("INSERT IGNORE INTO $table (bucket,available_at) VALUES (%s,0)", $bucket));
        $changed = $this->db->query($this->db->prepare("UPDATE $table SET available_at=%f WHERE bucket=%s AND available_at <= %f", $now + 1 / $rate, $bucket, $now));
        if ($changed === false) { throw new RuntimeException('pbin rate limiter failed'); }
        // Bound storage without a global cron job; old buckets need not persist.
        if (random_int(1, 100) === 1) {
            $this->db->query($this->db->prepare("DELETE FROM $table WHERE available_at < %f LIMIT 1000", $now - 3600));
        }
        return $changed === 1;
    }
}
