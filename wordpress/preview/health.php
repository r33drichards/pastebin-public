<?php
namespace Pbin\Preview;
/** Trusted metadata for the real plugin health handler, never a synthetic OK. */
final class Health {
    public static function headers(string $path, array $context, string $query): array {
        if ($path !== $context['base_path'] . '/health' || $context['request_base_path'] !== $context['base_path']) { return []; }
        $headers = ['X-Pbin-Revision' => $context['revision'], 'Cache-Control' => 'no-store'];
        if ($query !== '') {
            if (!preg_match('/\Apbin-health-nonce=([a-f0-9]{64})\z/', $query, $matches)) { throw new \RuntimeException('Invalid bounded health nonce'); }
            $headers['X-Pbin-Health-Nonce'] = $matches[1];
        }
        return $headers;
    }
    public static function install(array $headers): void {
        if ($headers !== []) {
            header_register_callback(static function () use ($headers): void {
                foreach ($headers as $name => $value) { header($name . ': ' . $value, true); }
            });
        }
    }
}
