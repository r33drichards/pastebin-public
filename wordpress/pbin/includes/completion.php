<?php
defined('ABSPATH') || exit;

final class PBIN_Completion {
    private const PREFIX = '<|fim_prefix|>';
    private const SUFFIX = '<|fim_suffix|>';
    private const MIDDLE = '<|fim_middle|>';
    private const TOKENS = ['<|endoftext|>', self::PREFIX, self::SUFFIX, self::MIDDLE, '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_start|>', '<|im_end|>'];

    private static function env(string $key, string $fallback = ''): string {
        $value = getenv($key); return $value !== false && $value !== '' ? $value : $fallback;
    }
    private static function timeout(): int {
        $value = self::env('COMPLETION_TIMEOUT_SECONDS', '25');
        // Match Go's positive integer configuration, not PHP's permissive
        // numeric casts. Compare decimal strings before casting so a value
        // outside wasm32's integer range cannot silently become INT_MAX.
        if (!preg_match('/^\+?[0-9]+$/D', $value)) { return 25; }
        $digits = ltrim($value, '+0');
        $maximum = (string) PHP_INT_MAX;
        if ($digits === '' || strlen($digits) > strlen($maximum)
            || (strlen($digits) === strlen($maximum) && strcmp($digits, $maximum) > 0)) { return 25; }
        return (int) $digits;
    }
    public static function providers(): array {
        $providers = [];
        if ($token = self::env('HF_TOKEN')) {
            $providers[] = ['url' => self::env('COMPLETION_HF_URL', 'https://router.huggingface.co/featherless-ai/v1/completions'), 'token' => $token, 'model' => self::env('COMPLETION_MODEL', 'Qwen/Qwen2.5-Coder-0.5B')];
        }
        if ($url = self::env('COMPLETION_FALLBACK_URL')) {
            $providers[] = ['url' => rtrim($url, '/') . '/v1/completions', 'token' => self::env('COMPLETION_FALLBACK_TOKEN'), 'model' => self::env('COMPLETION_FALLBACK_MODEL', 'Qwen/Qwen2.5-Coder-0.5B')];
        }
        return $providers;
    }
    public static function prompt(string $prefix, string $suffix): string {
        if (strlen($prefix) > 4096) {
            $cut = strlen($prefix) - 4096;
            while ($cut < strlen($prefix) && (ord($prefix[$cut]) & 0xC0) === 0x80) { ++$cut; }
            $prefix = substr($prefix, $cut);
        }
        if (strlen($suffix) > 1536) {
            $cut = 1536;
            while ($cut > 0 && (ord($suffix[$cut]) & 0xC0) === 0x80) { --$cut; }
            $suffix = substr($suffix, 0, $cut);
        }
        return self::PREFIX . $prefix . self::SUFFIX . $suffix . self::MIDDLE;
    }
    public static function stripTokens(string $text): string {
        foreach (self::TOKENS as $token) { $offset = strpos($text, $token); if ($offset !== false) { $text = substr($text, 0, $offset); } }
        return $text;
    }
    private static function post(string $url, string $token, array $body): ?array {
        $headers = ['Content-Type' => 'application/json'];
        if ($token !== '') { $headers['Authorization'] = 'Bearer ' . $token; }
        $response = wp_remote_post($url, ['headers' => $headers, 'body' => wp_json_encode($body), 'timeout' => self::timeout(), 'limit_response_size' => 1 << 20, 'redirection' => 0]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) { return null; }
        $decoded = json_decode(wp_remote_retrieve_body($response), true);
        return is_array($decoded) ? $decoded : null;
    }
    private function error(string $message, int $status): void {
        http_response_code($status); header('Content-Type: text/plain; charset=utf-8'); echo $message . "\n";
    }
    public function handle(): void {
        $providers = self::providers();
        switch ($_SERVER['REQUEST_METHOD'] ?? 'GET') {
            case 'GET':
                header('Content-Type: application/json'); echo pbin_json(['enabled' => count($providers) > 0]) . "\n"; return;
            case 'POST':
                if (!$providers) { $this->error('completion is not configured', 503); return; }
                $raw = file_get_contents('php://input', false, null, 0, (1 << 20) + 1);
                $body = json_decode($raw);
                if (strlen($raw) > (1 << 20) || json_last_error() !== JSON_ERROR_NONE || (!is_object($body) && $body !== null)) {
                    $this->error('invalid JSON body', 400); return;
                }
                $prefix = $body->prefix ?? ''; $suffix = $body->suffix ?? '';
                if (!is_string($prefix) || !is_string($suffix)) { $this->error('invalid JSON body', 400); return; }
                if ($prefix === '' && $suffix === '') { $this->error('prefix or suffix required', 400); return; }
                foreach ($providers as $provider) {
                    $response = self::post($provider['url'], $provider['token'], ['model' => $provider['model'], 'prompt' => self::prompt($prefix, $suffix), 'max_tokens' => 64, 'temperature' => 0, 'stop' => array_slice(self::TOKENS, 0, 4)]);
                    if ($response !== null && isset($response['choices'][0]) && is_array($response['choices'][0])) {
                        $text = $response['choices'][0]['text'] ?? '';
                        if (is_string($text)) {
                            header('Content-Type: application/json'); echo pbin_json(['completion' => self::stripTokens($text)]) . "\n"; return;
                        }
                    }
                    if (connection_aborted()) { return; }
                }
                $this->error('all completion providers failed', 502); return;
            default: http_response_code(405);
        }
    }
    public static function title(string $text): string {
        $token = self::env('OPENAPIKEY');
        if ($token === '') { return ''; }
        $response = self::post('https://api.openai.com/v1/chat/completions', $token, [
            'model' => 'gpt-3.5-turbo',
            'messages' => [
                ['role' => 'system', 'content' => "You are a helpful assistant that generates concise, descriptive titles for code snippets or text.\nGenerate a short, descriptive title (max 10 words) that captures the main purpose or content of the text.\nOnly output the title, nothing else."],
                ['role' => 'user', 'content' => $text],
            ],
        ]);
        $title = $response['choices'][0]['message']['content'] ?? '';
        return is_string($title) ? $title : '';
    }
}
