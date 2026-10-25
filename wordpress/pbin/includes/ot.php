<?php
defined('ABSPATH') || exit;

/** UTF-16 code-unit strings are stored as compact little-endian binary strings.
 * This preserves lone surrogate units during OT just like Go's []uint16. Convert
 * to/from UTF-8 only at JSON/database boundaries, not between transformations. */
final class PBIN_UTF16 {
    public static function length(string $units): int {
        if ((strlen($units) & 1) !== 0) { throw new InvalidArgumentException('UTF-16 buffer must contain complete code units'); }
        return intdiv(strlen($units), 2);
    }

    public static function fromUTF8(string $text): string {
        // Fast path is independent of mbstring's global replacement setting.
        if (function_exists('mb_convert_encoding') && preg_match('//u', $text) === 1) {
            return mb_convert_encoding($text, 'UTF-16LE', 'UTF-8');
        }
        $out = ''; $length = strlen($text);
        for ($i = 0; $i < $length;) {
            $first = ord($text[$i]);
            if ($first < 0x80) { $out .= chr($first) . "\0"; ++$i; continue; }
            $count = $first >= 0xC2 && $first <= 0xDF ? 2 : ($first >= 0xE0 && $first <= 0xEF ? 3 : ($first >= 0xF0 && $first <= 0xF4 ? 4 : 0));
            $valid = $count > 0 && $i + $count <= $length;
            for ($j = 1; $valid && $j < $count; ++$j) {
                $next = ord($text[$i + $j]);
                if (($next & 0xC0) !== 0x80) { $valid = false; }
            }
            if ($valid) {
                $second = ord($text[$i + 1]);
                if (($first === 0xE0 && $second < 0xA0) || ($first === 0xED && $second >= 0xA0)
                    || ($first === 0xF0 && $second < 0x90) || ($first === 0xF4 && $second >= 0x90)) { $valid = false; }
            }
            // Go's []rune(string) emits U+FFFD once per invalid UTF-8 byte.
            if (!$valid) { $out .= "\xFD\xFF"; ++$i; continue; }
            $point = $first & (0x7F >> $count);
            for ($j = 1; $j < $count; ++$j) { $point = ($point << 6) | (ord($text[$i + $j]) & 0x3F); }
            if ($point < 0x10000) { $out .= pack('v', $point); }
            else { $point -= 0x10000; $out .= pack('vv', 0xD800 | ($point >> 10), 0xDC00 | ($point & 0x3FF)); }
            $i += $count;
        }
        return $out;
    }

    public static function toUTF8(string $units): string {
        self::length($units);
        if (function_exists('mb_convert_encoding')) {
            // Native conversion keeps multi-megabyte HTTP pastes practical.
            // Restore process-global mbstring state before returning; this is a
            // synchronous operation with no callback or coroutine yield.
            $previous = mb_substitute_character();
            try { mb_substitute_character(0xFFFD); return mb_convert_encoding($units, 'UTF-8', 'UTF-16LE'); }
            finally { mb_substitute_character($previous); }
        }
        $out = ''; $length = strlen($units);
        for ($i = 0; $i < $length; $i += 2) {
            $point = ord($units[$i]) | (ord($units[$i + 1]) << 8);
            if ($point >= 0xD800 && $point <= 0xDBFF) {
                $low = $i + 3 < $length ? ord($units[$i + 2]) | (ord($units[$i + 3]) << 8) : 0;
                if ($low >= 0xDC00 && $low <= 0xDFFF) { $point = 0x10000 + (($point - 0xD800) << 10) + ($low - 0xDC00); $i += 2; }
                else { $point = 0xFFFD; }
            } elseif ($point >= 0xDC00 && $point <= 0xDFFF) { $point = 0xFFFD; }
            if ($point < 0x80) { $out .= chr($point); }
            elseif ($point < 0x800) { $out .= chr(0xC0 | ($point >> 6)) . chr(0x80 | ($point & 0x3F)); }
            elseif ($point < 0x10000) { $out .= chr(0xE0 | ($point >> 12)) . chr(0x80 | (($point >> 6) & 0x3F)) . chr(0x80 | ($point & 0x3F)); }
            else { $out .= chr(0xF0 | ($point >> 18)) . chr(0x80 | (($point >> 12) & 0x3F)) . chr(0x80 | (($point >> 6) & 0x3F)) . chr(0x80 | ($point & 0x3F)); }
        }
        return $out;
    }
}

/** Go's encoding/json replaces malformed UTF-8 and unpaired escaped UTF-16
 * surrogates with U+FFFD; PHP's native decoder otherwise rejects those strings.
 * Socket envelope readers can share this decoder to preserve that wire behavior.
 * Malformed JSON syntax and invalid escape sequences still throw JsonException. */
final class PBIN_JSON {
    public static function decode(string $json, bool $associative = false): mixed {
        if (preg_match('//u', $json) !== 1) { $json = PBIN_UTF16::toUTF8(PBIN_UTF16::fromUTF8($json)); }
        if (preg_match('~\\\\u[dD][89a-fA-F]~', $json)) {
            $json = preg_replace_callback('~"(?:[^"\\\\]|\\\\.)*"~s', static function (array $match): string {
                $string = $match[0]; $out = '"'; $end = strlen($string) - 1;
                for ($i = 1; $i < $end;) {
                    if ($string[$i] !== '\\') { $out .= $string[$i++]; continue; }
                    if ($i + 5 < $end && $string[$i + 1] === 'u' && preg_match('/^[0-9a-fA-F]{4}$/D', substr($string, $i + 2, 4))) {
                        $unit = hexdec(substr($string, $i + 2, 4));
                        if ($unit >= 0xD800 && $unit <= 0xDBFF) {
                            $low = $i + 11 < $end && substr($string, $i + 6, 2) === '\\u' && preg_match('/^[0-9a-fA-F]{4}$/D', substr($string, $i + 8, 4)) ? hexdec(substr($string, $i + 8, 4)) : 0;
                            if ($low >= 0xDC00 && $low <= 0xDFFF) { $out .= substr($string, $i, 12); $i += 12; continue; }
                            $out .= '\\ufffd';
                        } elseif ($unit >= 0xDC00 && $unit <= 0xDFFF) { $out .= '\\ufffd'; }
                        else { $out .= substr($string, $i, 6); }
                        $i += 6;
                    } else {
                        // Consume escaped backslashes as a pair, so a literal
                        // "\\\\ud800" is never mistaken for a Unicode escape.
                        $out .= substr($string, $i, 2); $i += 2;
                    }
                }
                return $out . '"';
            }, $json);
        }
        return json_decode($json, $associative, 512, JSON_THROW_ON_ERROR);
    }
}

/** A direct port of collab_ot.go. Positive integers retain, negative integers
 * delete, and strings insert. Every length is a JavaScript/Monaco UTF-16 offset. */
final class PBIN_TextOp implements JsonSerializable {
    private const RETAIN = 0;
    private const INSERT = 1;
    private const DELETE = 2;
    /** @var array<int,array{kind:int,n?:int,s?:string}> */
    private array $components = [];
    private int $baseLen = 0;
    private int $targetLen = 0;

    public function baseLength(): int { return $this->baseLen; }
    public function targetLength(): int { return $this->targetLen; }
    private static function add(int $a, int $b): int {
        if ($b > PHP_INT_MAX - $a) { throw new OverflowException('operation length exceeds integer range'); }
        return $a + $b;
    }

    public function Retain(int $n): self {
        if ($n <= 0) { return $this; }
        $base = self::add($this->baseLen, $n); $target = self::add($this->targetLen, $n);
        $this->baseLen = $base; $this->targetLen = $target;
        $last = count($this->components) - 1;
        if ($last >= 0 && $this->components[$last]['kind'] === self::RETAIN) { $this->components[$last]['n'] += $n; }
        else { $this->components[] = ['kind' => self::RETAIN, 'n' => $n]; }
        return $this;
    }

    /** Insert a UTF-16LE binary string, including possible surrogate halves. */
    public function Insert(string $units): self {
        $n = PBIN_UTF16::length($units);
        if ($n === 0) { return $this; }
        $this->targetLen = self::add($this->targetLen, $n);
        $last = count($this->components) - 1;
        if ($last >= 0 && $this->components[$last]['kind'] === self::INSERT) { $this->components[$last]['s'] .= $units; }
        elseif ($last >= 0 && $this->components[$last]['kind'] === self::DELETE) {
            // Canonical form places inserts before deletes at the same cursor.
            if ($last > 0 && $this->components[$last - 1]['kind'] === self::INSERT) { $this->components[$last - 1]['s'] .= $units; }
            else { $delete = $this->components[$last]; $this->components[$last] = ['kind' => self::INSERT, 's' => $units]; $this->components[] = $delete; }
        } else { $this->components[] = ['kind' => self::INSERT, 's' => $units]; }
        return $this;
    }

    public function InsertString(string $text): self { return $this->Insert(PBIN_UTF16::fromUTF8($text)); }

    public function Delete(int $n): self {
        if ($n <= 0) { return $this; }
        $this->baseLen = self::add($this->baseLen, $n);
        $last = count($this->components) - 1;
        if ($last >= 0 && $this->components[$last]['kind'] === self::DELETE) { $this->components[$last]['n'] += $n; }
        else { $this->components[] = ['kind' => self::DELETE, 'n' => $n]; }
        return $this;
    }

    public function IsNoop(): bool {
        return !$this->components || (count($this->components) === 1 && $this->components[0]['kind'] === self::RETAIN);
    }

    public function Apply(string $document): string {
        $length = PBIN_UTF16::length($document);
        if ($length !== $this->baseLen) {
            throw new InvalidArgumentException("operation base length {$this->baseLen} does not match document length $length");
        }
        $out = ''; $index = 0;
        foreach ($this->components as $component) {
            switch ($component['kind']) {
                case self::RETAIN: $out .= substr($document, $index * 2, $component['n'] * 2); $index += $component['n']; break;
                case self::INSERT: $out .= $component['s']; break;
                case self::DELETE: $index += $component['n']; break;
            }
        }
        return $out;
    }

    /** Convenience only: a realtime room should retain binary documents between
     * operations so it does not replace a temporarily unpaired surrogate. */
    public function ApplyString(string $document): string { return PBIN_UTF16::toUTF8($this->Apply(PBIN_UTF16::fromUTF8($document))); }

    /** Return [a', b'] with a's insert first at a shared insertion point. Neither
     * input operation is mutated. Both paths through the result converge. */
    public static function TransformOps(self $a, self $b): array {
        if ($a->baseLen !== $b->baseLen) {
            throw new InvalidArgumentException("both operations must have the same base length ({$a->baseLen} != {$b->baseLen})");
        }
        $ap = new self(); $bp = new self(); $i1 = 0; $i2 = 0;
        $c1 = $a->components[$i1++] ?? null; $c2 = $b->components[$i2++] ?? null;
        while ($c1 !== null || $c2 !== null) {
            if ($c1 !== null && $c1['kind'] === self::INSERT) {
                $ap->Insert($c1['s']); $bp->Retain(PBIN_UTF16::length($c1['s']));
                $c1 = $a->components[$i1++] ?? null; continue;
            }
            if ($c2 !== null && $c2['kind'] === self::INSERT) {
                $ap->Retain(PBIN_UTF16::length($c2['s'])); $bp->Insert($c2['s']);
                $c2 = $b->components[$i2++] ?? null; continue;
            }
            if ($c1 === null || $c2 === null) { throw new InvalidArgumentException('cannot transform operations: one is too short'); }
            $n = min($c1['n'], $c2['n']);
            if ($c1['kind'] === self::RETAIN && $c2['kind'] === self::RETAIN) { $ap->Retain($n); $bp->Retain($n); }
            elseif ($c1['kind'] === self::DELETE && $c2['kind'] === self::RETAIN) { $ap->Delete($n); }
            elseif ($c1['kind'] === self::RETAIN && $c2['kind'] === self::DELETE) { $bp->Delete($n); }
            // delete/delete removes the same units, so emits nothing.
            $c1['n'] -= $n; $c2['n'] -= $n;
            if ($c1['n'] === 0) { $c1 = $a->components[$i1++] ?? null; }
            if ($c2['n'] === 0) { $c2 = $b->components[$i2++] ?? null; }
        }
        return [$ap, $bp];
    }

    public function TransformIndex(int $index): int {
        $newIndex = $index; $cursor = 0;
        foreach ($this->components as $component) {
            if ($cursor > $index) { break; }
            switch ($component['kind']) {
                case self::RETAIN: $cursor += $component['n']; break;
                case self::INSERT: $newIndex += PBIN_UTF16::length($component['s']); break;
                case self::DELETE:
                    $newIndex -= min($component['n'], $index - $cursor);
                    $cursor += $component['n']; break;
            }
        }
        return $newIndex;
    }

    public function wire(): array {
        $parts = [];
        foreach ($this->components as $component) {
            switch ($component['kind']) {
                case self::RETAIN: $parts[] = $component['n']; break;
                case self::INSERT: $parts[] = PBIN_UTF16::toUTF8($component['s']); break;
                case self::DELETE: $parts[] = -$component['n']; break;
            }
        }
        return $parts;
    }
    public function jsonSerialize(): array { return $this->wire(); }
    public function MarshalJSON(): string { return json_encode($this->wire(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP); }

    public static function fromWire(array $parts): self {
        if (!array_is_list($parts)) { throw new InvalidArgumentException('operation must be an array of components'); }
        $op = new self();
        foreach ($parts as $part) {
            if (is_string($part)) {
                if ($part === '') { throw new InvalidArgumentException('invalid empty insert'); }
                $op->InsertString($part);
            } elseif (is_int($part) || is_float($part)) {
                if (is_float($part) && (!is_finite($part) || floor($part) !== $part || $part >= PHP_INT_MAX || $part <= PHP_INT_MIN)) {
                    throw new InvalidArgumentException('invalid operation number');
                }
                $n = (int) $part;
                if ($n === 0 || $n === PHP_INT_MIN) { throw new InvalidArgumentException('invalid operation number'); }
                if ($n > 0) { $op->Retain($n); } else { $op->Delete(-$n); }
            } else { throw new InvalidArgumentException('invalid operation component'); }
        }
        return $op;
    }

    public static function fromJSON(string $json): self {
        $parts = PBIN_JSON::decode($json);
        // Go's json.Unmarshal accepts null as an empty []interface{}.
        if ($parts === null) { return new self(); }
        if (!is_array($parts)) { throw new InvalidArgumentException('operation must be an array of components'); }
        return self::fromWire($parts);
    }
}
