<?php
defined('ABSPATH') || exit;

function pbin_base_path(): string {
    $base = defined('PBIN_WP_BASE_PATH') ? PBIN_WP_BASE_PATH : parse_url(home_url('/pbin-wp-test'), PHP_URL_PATH);
    $base = rtrim((string) $base, '/');
    if ($base !== '' && !preg_match('~^/[a-zA-Z0-9/_-]+$~D', $base)) {
        throw new RuntimeException('PBIN_WP_BASE_PATH must be a URL path containing only letters, digits, /, _ and -');
    }
    return $base;
}
function pbin_path(string $path = '/'): string { return pbin_base_path() . $path; }
function pbin_html($value): string { return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8'); }
function pbin_json($value): string { return json_encode($value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES); }

final class PBIN_HTTP {
    private PBIN_Store $store;
    public function __construct(PBIN_Store $store) { $this->store = $store; }

    public function dispatch(string $route): void {
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Embedder-Policy: require-corp');
        header('X-Content-Type-Options: nosniff');
        header('Content-Type: text/html; charset=utf-8');
        try {
            if (str_starts_with($route, '/static/')) { $this->asset(substr($route, 8)); return; }
            $rate = (float) (getenv('PBIN_RATE_LIMIT') ?: 2);
            if ($route === '/complete') { $rate = (float) (getenv('PBIN_COMPLETION_RATE_LIMIT') ?: 5); }
            if (!$this->store->AllowRequest($route, $rate > 0 ? $rate : 2)) {
                header('Retry-After: 1'); $this->text('You have reached maximum request limit.', 429); return;
            }
            switch ($route) {
                case '/': $this->index(); break;
                case '/health': $this->text('OK'); break;
                case '/paste': $this->paste(); break;
                case '/diff': $this->diff(); break;
                case '/snapshot': $this->snapshot(); break;
                case '/snapshots': $this->snapshots(); break;
                case '/html': $this->markdown(); break;
                case '/complete': require_once __DIR__ . '/completion.php'; (new PBIN_Completion())->handle(); break;
                case '/collab':
                    // PHP-FPM/ordinary WP cannot own upgraded socket connections.
                    // A genuine WebSocket process must handle this path at the
                    // reverse proxy. Do not disguise polling as protocol parity.
                    $this->text('WebSocket service is not configured', 501); break;
                default: $this->text("404 not found.\n", 404);
            }
        } catch (Throwable $error) {
            error_log('pbin: ' . $error->getMessage());
            $this->text('', 500);
        }
    }

    private function method(): string { return $_SERVER['REQUEST_METHOD'] ?? 'GET'; }
    private function query(string $key): string {
        $value = $_GET[$key] ?? '';
        return is_scalar($value) ? (string) wp_unslash($value) : '';
    }
    private function body(): array {
        if ($this->method() === 'POST') { return wp_unslash($_POST); }
        $body = file_get_contents('php://input', false, null, 0, 10 * 1024 * 1024 + 1);
        if (strlen($body) > 10 * 1024 * 1024) { throw new LengthException('form body exceeds 10 MB'); }
        parse_str($body, $form);
        return $form;
    }
    private function value(array $form, string $key): string {
        // Like Go FormValue, body values take precedence over URL values.
        $v = $form[$key] ?? $this->query($key);
        return is_scalar($v) ? (string) $v : '';
    }
    private function text(string $text, int $status = 200): void {
        http_response_code($status); header('Content-Type: text/plain; charset=utf-8'); echo $text;
    }
    private function redirect(string $path, int $status = 301): void {
        http_response_code($status); header('Location: ' . $path);
        echo '<a href="' . pbin_html($path) . '">Redirect</a>.\n';
    }
    private function json(array $data): void {
        header('Content-Type: application/json'); echo pbin_json($data) . "\n";
    }
    private function template(string $name, array $data = []): void {
        // The template name is selected by this controller, never by a request.
        require PBIN_PLUGIN_DIR . '/templates/' . $name . '.php';
    }
    private function canonical(string $route, string $id, array $remove): string {
        $query = wp_unslash($_GET);
        foreach ($remove as $key) { unset($query[$key]); }
        $query['id'] = $id; ksort($query);
        return pbin_path($route) . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC1738);
    }

    private function index(): void {
        if ($this->method() !== 'GET') { return; }
        $lang = $this->query('lang');
        if (strlen($lang) > 64) { $lang = ''; }
        $id = $this->store->AddPaste('', $lang, '');
        header('Cache-Control: no-store');
        $this->redirect(pbin_path('/paste') . '?id=' . $id, 303);
    }

    private function paste(): void {
        switch ($this->method()) {
            case 'POST':
                $form = $this->body(); $text = $this->value($form, 'text');
                require_once __DIR__ . '/completion.php';
                $title = PBIN_Completion::title($text);
                $id = $this->store->AddPaste($text, $this->value($form, 'lang'), $title);
                $this->redirect($this->canonical('/paste', $id, ['text', 'lang'])); return;
            case 'PUT':
                $form = $this->body(); $id = $this->value($form, 'id');
                if ($id === '') { $this->text('Missing paste ID', 400); return; }
                $text = $this->value($form, 'text'); $lang = $this->value($form, 'lang'); $title = $this->value($form, 'title');
                $this->store->UpdatePaste($id, $text, $lang, $title);
                // Single-user HTTP replacement; other tabs are not synchronized.
                do_action('pbin_paste_replaced', $id, $text, $lang, $title);
                $this->text('OK'); return;
            case 'GET':
                $id = $this->query('id');
                if ($id === '') { $this->redirect(pbin_path()); return; }
                $plain = str_ends_with($id, '.txt');
                $paste = $this->store->GetPaste($plain ? substr($id, 0, -4) : $id);
                if ($plain) { $this->text($paste['Text']); } else { $this->template('paste', $paste); }
                return;
            default: $this->redirect(pbin_path());
        }
    }

    private function diff(): void {
        if ($this->method() === 'POST') {
            $form = $this->body();
            $id = $this->store->AddDiff($this->value($form, 'original'), $this->value($form, 'modified'));
            $this->redirect($this->canonical('/diff', $id, ['original', 'modified'])); return;
        }
        if ($this->method() !== 'GET') { $this->redirect(pbin_path()); return; }
        $id = $this->query('id');
        if ($id === '') { $this->template('diff'); return; }
        try { $diff = $this->store->GetDiff($id); }
        catch (OutOfBoundsException $e) { $this->text('', 404); return; }
        $this->template('diff-share', $diff);
    }

    private function snapshot(): void {
        if ($this->method() === 'POST') {
            $form = $this->body(); $id = $this->value($form, 'id');
            if ($id === '') { $this->text('Missing paste ID', 400); return; }
            try { $paste = $this->store->GetPaste($id); }
            catch (OutOfBoundsException $e) { $this->text('Paste not found', 404); return; }
            foreach (['text' => 'Text', 'lang' => 'Language', 'title' => 'Title'] as $input => $field) {
                if (array_key_exists($input, $form)) { $paste[$field] = is_scalar($form[$input]) ? (string) $form[$input] : ''; }
            }
            $nameValue = $form['name'] ?? '';
            $name = preg_replace('/^\s+|\s+$/u', '', is_scalar($nameValue) ? (string) $nameValue : '');
            preg_match('/^.{0,120}/us', $name ?? '', $runes);
            $name = $runes[0] ?? '';
            $snapshot = $this->store->AddSnapshot($id, $name, $paste['Text'], $paste['Language'], $paste['Title']);
            $url = pbin_path('/snapshot') . '?id=' . $snapshot['ID'];
            if (str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json')) {
                $this->json(['id' => $snapshot['ID'], 'pasteId' => $id, 'name' => $snapshot['Name'], 'created' => $snapshot['CreatedAt'], 'url' => $url]);
            } else { $this->redirect($url, 303); }
            return;
        }
        if ($this->method() !== 'GET') { $this->redirect(pbin_path()); return; }
        $id = $this->query('id');
        if ($id === '') { $this->redirect(pbin_path()); return; }
        $plain = str_ends_with($id, '.txt');
        try { $snapshot = $this->store->GetSnapshot($plain ? substr($id, 0, -4) : $id); }
        catch (OutOfBoundsException $e) { $this->text('', 404); return; }
        if ($plain) { $this->text($snapshot['Text']); } else { $this->template('snapshot', $snapshot); }
    }

    private function snapshots(): void {
        $id = $this->query('id');
        if ($this->method() !== 'GET' || $id === '') { $this->redirect(pbin_path()); return; }
        try { $paste = $this->store->GetPaste($id); }
        catch (OutOfBoundsException $e) { $this->text('', 404); return; }
        $this->template('snapshots', ['PasteID' => $id, 'Title' => $paste['Title'], 'Snapshots' => $this->store->ListSnapshots($id)]);
    }

    private function markdown(): void {
        if ($this->method() !== 'GET' || $this->query('id') === '') { $this->redirect(pbin_path()); return; }
        require_once __DIR__ . '/markdown.php';
        $paste = $this->store->GetPaste($this->query('id'));
        echo PBIN_Markdown::render($paste['Text']);
    }

    private function asset(string $path): void {
        // Do not serve directory listings, arbitrary plugin PHP, or traversal.
        $root = realpath(PBIN_PLUGIN_DIR . '/static');
        $file = realpath($root . '/' . rawurldecode($path));
        if (!$file || !str_starts_with($file, $root . DIRECTORY_SEPARATOR) || !is_file($file)) { $this->text('', 404); return; }
        $ext = pathinfo($file, PATHINFO_EXTENSION);
        $mime = ['js' => 'application/javascript', 'mjs' => 'application/javascript', 'css' => 'text/css', 'svg' => 'image/svg+xml', 'wasm' => 'application/wasm', 'json' => 'application/json'];
        if (!isset($mime[$ext])) { $this->text('', 404); return; }
        header('Content-Type: ' . $mime[$ext]);
        header('Cross-Origin-Resource-Policy: same-origin');
        header('Cache-Control: public, max-age=3600');
        if (in_array($ext, ['js', 'mjs', 'css'], true)) {
            // Only trusted packaged assets are rewritten, never user documents.
            $text = file_get_contents($file);
            $text = preg_replace_callback('~([\x22\x27\x60])/(static/|collab(?=[?\x22\x27\x60])|complete(?=[?\x22\x27\x60])|diff(?=[?\x22\x27\x60])|html(?=[?\x22\x27\x60]))~', static fn($m) => $m[1] . pbin_path('/' . $m[2]), $text);
            if (basename($file) === 'command-palette.js') {
                $text = str_replace("handler: goTo('/')", "handler: goTo('" . pbin_path('/') . "')", $text);
            }
            echo $text;
        } else { readfile($file); }
    }
}
