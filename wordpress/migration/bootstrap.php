<?php
/** Best-effort CLI output guard, not a sandbox for trusted wp-config/drop-ins. */
namespace Pbin\Migration;
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

final class BootstrapGuard {
    public const FAILURE = 'WordPress bootstrap failed; no import attempted';
    private string $phase = 'starting';
    private bool $output = false;
    private int $level;
    private bool $handler = false;
    private ?\Closure $errorHandler = null;

    private function __construct() {
        self::quietErrors();
        $this->level = ob_get_level() + 1;
        // Keep this buffer non-removable until process exit. Only the importer's
        // explicit fwrite(STDOUT, ...) can emit its receipt. Echo/print and
        // ordinary buffered shutdown output are discarded, never retained.
        if (!ob_start(function (string $chunk): string {
            if ($chunk !== '') { $this->output = true; }
            return '';
        }, 1, PHP_OUTPUT_HANDLER_CLEANABLE | PHP_OUTPUT_HANDLER_FLUSHABLE)) {
            throw new MigrationException(self::FAILURE);
        }
        register_shutdown_function(function (): void {
            if ($this->phase === 'loading' || $this->phase === 'starting') {
                // exit()/die()/wp_die() bypass catch/finally, including exit(0).
                // Do not print error_get_last(), exception text or backtraces.
                $this->phase = 'failed';
                self::quietErrors();
                fwrite(STDERR, ExportFile::json(['status' => 'refused', 'reason' => self::FAILURE]));
                exit(1);
            }
        });
        $this->errorHandler = function (int $severity): bool {
            if ($this->phase !== 'loading') { return false; }
            if ((error_reporting() & $severity) === 0) { return false; }
            throw new MigrationException(self::FAILURE);
        };
        set_error_handler($this->errorHandler);
        $this->handler = true;
        $this->phase = 'loading';
    }
    public static function start(): self { return new self(); }
    private static function quietErrors(): void {
        // Process-local settings only. Trusted PHP can change them again; this
        // is not a promise to intercept direct stream writes or private logs.
        ini_set('display_errors', '0');
        ini_set('display_startup_errors', '0');
        ini_set('log_errors', '0');
    }
    public function complete(): void {
        if (ob_get_level() !== $this->level) { throw new MigrationException(self::FAILURE); }
        ob_flush();
        if ($this->output) { throw new MigrationException(self::FAILURE); }
        $this->phase = 'complete';
        $this->restoreHandler();
        self::quietErrors();
    }
    public function failed(): void {
        $this->phase = 'failed';
        $this->restoreHandler();
        self::quietErrors();
    }
    private function restoreHandler(): void {
        if ($this->handler) {
            // Do not remove a handler installed later by trusted bootstrap PHP.
            $current = set_error_handler(static fn(int $severity): bool => false);
            restore_error_handler();
            if ($current === $this->errorHandler) { restore_error_handler(); }
            $this->handler = false;
        }
    }
}
