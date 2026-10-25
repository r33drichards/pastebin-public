<?php
/** Offline controller/filesystem/auth-adapter checks; NOT live WP/ZIP/MySQL proof. */
require dirname(__DIR__) . '/preview/mysql-registry.php';
require dirname(__DIR__) . '/preview/control/native-package.php';
require dirname(__DIR__) . '/preview/control/rest.php';
require dirname(__DIR__) . '/preview/health.php';
use Pbin\Preview\Control\Configuration;
use Pbin\Preview\Control\Controller;
use Pbin\Preview\Control\Endpoint;
use Pbin\Preview\Control\Storage;
use Pbin\Preview\Control\ControlException;
use Pbin\Preview\RegistryConflict;
use Pbin\Preview\RegistryCommitUncertain;
use Pbin\Preview\Health;

function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
function denied(callable $action, string $class = ControlException::class): void {
    try { $action(); } catch (Throwable $error) { check($error instanceof $class, 'Wrong failure: ' . get_class($error) . ': ' . $error->getMessage()); return; }
    throw new RuntimeException('Expected rejection');
}
function input(string $body) { $stream = fopen('php://temp', 'w+b'); fwrite($stream, $body); rewind($stream); return $stream; }
function clean(string $path): void {
    if (is_link($path) || is_file($path)) { unlink($path); return; }
    chmod($path, 0700);
    foreach (scandir($path) ?: [] as $name) { if ($name !== '.' && $name !== '..') { clean($path . '/' . $name); } }
    rmdir($path);
}
class MemoryRegistry {
    public array $records = [];
    public $beforeCas = null;
    public bool $uncertain = false;
    public bool $inventoryBlocked = false;
    public function assertDataInventory(): void { if ($this->inventoryBlocked) { throw new \Pbin\Preview\RegistryException('Synthetic orphan table'); } }
    public function tenant(string $tenant): ?array { return $this->records[$tenant] ?? null; }
    public function compareAndSwap(string $tenant, ?string $token, array $desired): array {
        if ($this->beforeCas !== null) { $action = $this->beforeCas; $this->beforeCas = null; $action($this); }
        if ($this->uncertain) { throw new RegistryCommitUncertain('injected uncertain commit'); }
        $old = $this->tenant($tenant);
        if (($old['state_token'] ?? null) !== $token) { throw new RegistryConflict('injected conflict'); }
        $candidate = ['state_token' => $old['state_token'] ?? ''] + $desired;
        if ($candidate !== $old) { $candidate['state_token'] = bin2hex(random_bytes(32)); }
        return $this->records[$tenant] = $candidate;
    }
    public function retire(string $tenant, ?string $token): array {
        $old = $this->tenant($tenant);
        return $this->compareAndSwap($tenant, $token, ['enabled' => false, 'active' => $old['active'] ?? null, 'releases' => $old['releases'] ?? []]);
    }
}
class PackageDouble {
    public const MAX_ARCHIVE_BYTES = 1024;
    public const MAX_EXPANDED_BYTES = 1024;
    public const MAX_MANIFEST = 1024;
    public const MAX_ENTRIES = 8;
    public static int $extracts = 0;
    public static bool $reject = false;
    public static function extract(string $archive, string $hash, string $sha, string $directory): array {
        ++self::$extracts;
        if (self::$reject) { throw new ControlException('Injected invalid package'); }
        check(!file_exists($directory), 'Extractor received existing destination');
        mkdir($directory, 0700); mkdir($directory . '/pbin', 0700);
        mkdir($directory . '/pbin/includes', 0700);
        foreach (['runtime.php', 'includes/mount.php', 'includes/instance.php', 'includes/store.php', 'includes/preview-quota.php', 'includes/http.php'] as $file) {
            copy(dirname(__DIR__) . '/pbin/' . $file, $directory . '/pbin/' . $file);
        }
        file_put_contents($directory . '/manifest.json', $sha . ':' . $hash);
        return ['manifest_sha256' => hash_file('sha256', $directory . '/manifest.json')];
    }
    public static function verifyExisting(string $directory, string $sha, string $hash, string $manifest): array {
        check(file_get_contents($directory . '/manifest.json') === $sha . ':' . $hash, 'Wrong retained bytes');
        check(hash_file('sha256', $directory . '/manifest.json') === $manifest, 'Wrong retained manifest');
        return ['manifest_sha256' => $manifest];
    }
}
function fixture(): array {
    $work = sys_get_temp_dir() . '/pbin-controller-' . bin2hex(random_bytes(8)); mkdir($work, 0700);
    mkdir($work . '/site', 0700); mkdir($work . '/private', 0700);
    $config = new Configuration(true, 'staging', 'https://fixture.invalid', 'https://fixture.invalid', $work . '/private', [$work . '/site'], '77');
    $config->storage->initialize();
    $registry = new MemoryRegistry(); $controller = new Controller($registry, $config->storage, PackageDouble::class);
    return [$work, $config, $registry, $controller];
}
function install(Controller $controller, string $tenant = 'pr-1', string $letter = 'a', ?string $token = null): array {
    $body = 'archive-' . $letter; $stream = input($body);
    try { return $controller->install($tenant, str_repeat($letter, 40), hash('sha256', $body), $token, $stream, strlen($body))['record']; }
    finally { fclose($stream); }
}
$count = 0;
function test(string $name, callable $action): void {
    global $count; [$work, $config, $registry, $controller] = fixture();
    try { $action($work, $config, $registry, $controller); ++$count; echo "PASS: $name\n"; }
    finally { PackageDouble::$reject = false; clean($work); }
}

test('staging, HTTPS origin, canonical private root and public-root separation', function ($work) {
    foreach ([[false, 'staging', 'https://fixture.invalid'], [true, 'production', 'https://fixture.invalid'], [true, 'staging', 'http://fixture.invalid']] as [$enabled, $environment, $origin]) {
        denied(fn() => new Configuration($enabled, $environment, $origin, $origin, $work . '/private', [$work . '/site']));
    }
    denied(fn() => new Configuration(true, 'staging', 'https://fixture.invalid', 'https://other.invalid', $work . '/private', [$work . '/site']));
    denied(fn() => new Storage($work . '/site', [$work . '/site']));
    denied(fn() => new Storage($work, [$work . '/site']));
    chmod($work . '/private', 0755); denied(fn() => new Storage($work . '/private', [$work . '/site'])); chmod($work . '/private', 0700);
    symlink($work . '/private', $work . '/alias'); denied(fn() => new Storage($work . '/alias', [$work . '/site']));
});
test('read does not migrate and empty tombstone serializes as object', function ($work, $config, $registry, $controller) {
    check($controller->get('pr-1')['record'] === null, 'Unexpected tenant');
    $retired = $controller->retire('pr-1', null);
    check(str_contains(json_encode($retired), '"releases":{}'), 'Empty releases encoded as list');
    denied(fn() => install($controller), RegistryConflict::class);
});
test('verified install, exact retry, rollback and retirement preserve code/data', function ($work, $config, $registry, $controller) {
    $a = install($controller); $a2 = install($controller, 'pr-1', 'a', $a['state_token']);
    check($a2['state_token'] === $a['state_token'], 'Retry changed token');
    $directory = $config->storage->root . '/releases/pr-1/' . str_repeat('a', 40);
    check((fileperms($directory . '/pbin/runtime.php') & 0777) === 0444, 'Release file not sealed');
    file_put_contents($config->storage->root . '/data/pr-1/keep', 'user-data');
    $b = install($controller, 'pr-1', 'b', $a['state_token']);
    $back = $controller->rollback('pr-1', $b['state_token'], str_repeat('a', 40))['record'];
    check($back['active'] === $a['active'] && $back['state_token'] !== $a['state_token'], 'Rollback ABA');
    $controller->retire('pr-1', $back['state_token']);
    check(is_file($directory . '/pbin/runtime.php') && file_get_contents($config->storage->root . '/data/pr-1/keep') === 'user-data', 'Retirement deleted data');
    check(empty($GLOBALS['branch_executed']), 'Controller executed branch PHP');
});
test('orphan data blocks provisioning, while retirement remains available', function ($work, $config, $registry, $controller) {
    $registry->inventoryBlocked = true;
    denied(fn() => install($controller), \Pbin\Preview\RegistryException::class);
    check($registry->tenant('pr-1') === null, 'Inventory rejection published a release');
    $controller->retire('pr-1', null);
});
test('rollback rejects a retained package missing the reviewed quota path', function ($work, $config, $registry, $controller) {
    $a = install($controller);
    $b = install($controller, 'pr-1', 'b', $a['state_token']);
    $file = $config->storage->root . '/releases/pr-1/' . $a['active'] . '/pbin/includes/store.php';
    chmod($file, 0600); file_put_contents($file, '<?php // self-declared quota_version=2 is not proof');
    $before = $registry->tenant('pr-1');
    denied(fn() => $controller->rollback('pr-1', $b['state_token'], $a['active']));
    check($registry->tenant('pr-1') === $before, 'Unsupported rollback changed active state');
});
test('both actual quota write-path files match the reviewed trusted recipe', function ($work, $config, $registry, $controller) {
    $a = install($controller);
    $plugin = $config->storage->root . '/releases/pr-1/' . $a['active'] . '/pbin';
    \Pbin\Preview\Control\QuotaRecipe::verify($plugin);
    foreach (['includes/store.php', 'includes/preview-quota.php'] as $path) {
        $file = $plugin . '/' . $path; $original = file_get_contents($file);
        chmod($file, 0600); file_put_contents($file, $original . "\n// self-declared compatible flag is not independent approval\n");
        denied(fn() => \Pbin\Preview\Control\QuotaRecipe::verify($plugin));
        file_put_contents($file, $original); chmod($file, 0444);
    }
    \Pbin\Preview\Control\QuotaRecipe::verify($plugin);
});
test('existing release cannot be overwritten and incomplete orphan is not replaced', function ($work, $config, $registry, $controller) {
    $a = install($controller); $path = $config->storage->root . '/releases/pr-1/' . $a['active'] . '/manifest.json'; $before = file_get_contents($path);
    $stream = input('different'); denied(fn() => $controller->install('pr-1', $a['active'], hash('sha256', 'different'), $a['state_token'], $stream, 9)); fclose($stream);
    check(file_get_contents($path) === $before, 'Release overwritten');
    $orphan = $config->storage->root . '/releases/pr-1/' . str_repeat('b', 40); mkdir($orphan, 0700); file_put_contents($orphan . '/keep', 'partial');
    denied(fn() => install($controller, 'pr-1', 'b', $a['state_token']));
    check(file_get_contents($orphan . '/keep') === 'partial', 'Incomplete orphan removed');
});
test('stale late CAS leaves bounded unroutable orphan and no active mutation', function ($work, $config, $registry, $controller) {
    $registry->beforeCas = static fn($db) => $db->retire('pr-1', null);
    denied(fn() => install($controller), RegistryConflict::class);
    check(!$registry->tenant('pr-1')['enabled'] && $registry->tenant('pr-1')['active'] === null, 'Stale job became active');
    check(is_dir($config->storage->root . '/releases/pr-1/' . str_repeat('a', 40)), 'Expected retained orphan');
    check(!file_exists($config->storage->root . '/.controller-lock'), 'Known conflict stranded lock');
});
test('uncertain DB commit retains filesystem lock but retirement remains possible', function ($work, $config, $registry, $controller) {
    $registry->uncertain = true; denied(fn() => install($controller), RegistryCommitUncertain::class);
    check(is_dir($config->storage->root . '/.controller-lock'), 'Uncertain commit unlocked');
    $registry->uncertain = false; $controller->retire('pr-1', null);
    denied(fn() => install($controller, 'pr-2'));
});
test('atomic mkdir lock never expires, steals or deletes someone else state', function ($work, $config, $registry, $controller) {
    $lock = $config->storage->root . '/.controller-lock'; mkdir($lock, 0700); file_put_contents($lock . '/owner-existing', 'keep'); touch($lock, 1);
    denied(fn() => install($controller)); check(file_get_contents($lock . '/owner-existing') === 'keep', 'Old lock stolen');
});
test('invalid ZIP, stream digest/length/size failures do not publish', function ($work, $config, $registry, $controller) {
    PackageDouble::$reject = true; denied(fn() => install($controller)); PackageDouble::$reject = false;
    foreach ([['short', hash('sha256', 'other'), 5], ['short', hash('sha256', 'short'), 6], [str_repeat('a', 1025), hash('sha256', str_repeat('a', 1025)), null]] as [$body, $hash, $length]) {
        $stream = input($body); denied(fn() => $controller->install('pr-1', str_repeat('a', 40), $hash, null, $stream, $length)); fclose($stream);
    }
    check($registry->tenant('pr-1') === null, 'Invalid upload published');
    check(count(scandir($config->storage->root . '/.uploads')) === 2, 'Owned upload not cleaned');
});
test('root admission counts orphan bytes/entries and rejects symlinks/hardlinks', function ($work, $config, $registry, $controller) {
    $file = $config->storage->root . '/orphan'; $stream = fopen($file, 'xb'); ftruncate($stream, Storage::MAX_BYTES); fclose($stream);
    denied(fn() => install($controller)); unlink($file);
    denied(fn() => $config->storage->reserve(0, Storage::MAX_ENTRIES));
    symlink($work . '/site', $config->storage->root . '/unsafe'); denied(fn() => $config->storage->usage()); unlink($config->storage->root . '/unsafe');
    file_put_contents($file, 'x'); link($file, $config->storage->root . '/hardlink'); denied(fn() => $config->storage->usage());
});
test('three unregistered release directories block unbounded orphan accumulation', function ($work, $config, $registry, $controller) {
    mkdir($config->storage->root . '/releases/pr-1', 0700);
    foreach (['b', 'c', 'd'] as $letter) { mkdir($config->storage->root . '/releases/pr-1/' . str_repeat($letter, 40), 0700); }
    denied(fn() => install($controller)); check($registry->tenant('pr-1') === null, 'Fourth retained/orphan revision published');
});
test('route and method parser is exact and rejects noncanonical PR identifiers', function () {
    check(Endpoint::route('/pbin-previews/v1/tenants/pr-9999999999', 'GET')['action'] === 'get', 'Ten-digit tenant rejected');
    foreach ([['/pbin-previews/v1/tenants/pr-01', 'GET'], ['/pbin-previews/v1/tenants/pr-1/', 'GET'], ['/pbin-previews/v1/tenants/pr-1', 'POST'], ['/pbin-previews/v1/tenants/pr-1/retire', 'GET'], ['/pbin-previews/v1/tenants/pr-1/unknown', 'POST'], ['/pbin-previews/v1/tenants/pr-1/releases/' . str_repeat('A', 40), 'POST']] as [$path, $method]) { denied(fn() => Endpoint::route($path, $method)); }
});
test('JSON mutation bodies reject duplicates, wrong types, extra fields and oversize', function ($work, $config, $registry, $controller) {
    $route = Endpoint::route('/pbin-previews/v1/tenants/pr-1/retire', 'POST');
    foreach (['{"expected_token":null,"expected_token":null}', '{"expected_token":null,"extra":1}', '{"expected_token":true}', '[]', str_repeat(' ', 4097)] as $body) {
        $stream = input($body); denied(fn() => Endpoint::dispatch($controller, $route, ['content-type' => 'application/json'], $stream)); fclose($stream);
    }
    $stream = input('{ "expected_token": null }');
    $result = Endpoint::dispatch($controller, $route, ['content-type' => 'application/json'], $stream); fclose($stream);
    check($result['record']['enabled'] === false, 'Valid retirement rejected');
});
test('ZIP header validation refuses missing/duplicate token, digest and content encoding', function ($work, $config, $registry, $controller) {
    $route = Endpoint::route('/pbin-previews/v1/tenants/pr-1/releases/' . str_repeat('a', 40), 'POST');
    $headers = ['content-type' => 'application/zip', 'x-pbin-artifact-sha256' => hash('sha256', 'archive-a'), 'x-pbin-expected-token' => 'none'];
    foreach ([['x-pbin-expected-token' => 'none, none'], ['x-pbin-artifact-sha256' => ''], ['content-encoding' => 'gzip'], ['content-length' => '999999999'], ['content-type' => 'multipart/form-data']] as $bad) {
        $stream = input('archive-a'); denied(fn() => Endpoint::dispatch($controller, $route, array_replace($headers, $bad), $stream)); check(ftell($stream) === 0, 'Invalid headers consumed body'); fclose($stream);
    }
});

// WordPress authorization doubles exercise adapter ordering/capability decisions,
// not real cookie signatures, REST nonce generation or application-password crypto.
class WP_User { public function exists(): bool { return $GLOBALS['auth']['logged']; } }
class WP_Error {}
function is_wp_error($value): bool { return $value instanceof WP_Error; }
function is_ssl(): bool { return $GLOBALS['auth']['ssl']; }
function wp_get_current_user() { return $GLOBALS['current_user'] ??= new WP_User(); }
function is_user_logged_in(): bool { return $GLOBALS['auth']['logged']; }
function get_current_user_id(): int { return $GLOBALS['auth']['id']; }
function current_user_can(string $cap): bool { return in_array($cap, $GLOBALS['auth']['caps'], true); }
function rest_get_authenticated_app_password() { return $GLOBALS['auth']['app']; }
function rest_cookie_check_errors($result) {
    ++$GLOBALS['auth']['nonce_checks'];
    if ($GLOBALS['auth']['nonce'] === 'missing') { $GLOBALS['auth']['logged'] = false; return true; }
    return $GLOBALS['auth']['nonce'] === 'valid' ? true : new WP_Error();
}
function rest_get_server() {
    return new class {
        public function check_authentication() {
            ++$GLOBALS['auth']['core_checks'];
            if ($GLOBALS['auth']['error']) { return new WP_Error(); }
            return $GLOBALS['auth']['app'] !== null ? true : rest_cookie_check_errors(null);
        }
    };
}
function resetAuth(): void {
    $GLOBALS['current_user'] = new WP_User(); $GLOBALS['wp_rest_auth_cookie'] = true;
    $GLOBALS['auth'] = ['ssl' => true, 'logged' => true, 'id' => 77, 'caps' => ['manage_options'], 'app' => null, 'nonce' => 'valid', 'error' => false, 'core_checks' => 0, 'nonce_checks' => 0];
}
test('cookie admin requires actual core auth path and nonce; anonymous/bad nonce refused', function ($work, $config) {
    foreach (['missing', 'bad'] as $nonce) { resetAuth(); $GLOBALS['auth']['nonce'] = $nonce; denied(fn() => Endpoint::authorize($config)); check($GLOBALS['auth']['core_checks'] === 1, 'Skipped core REST auth'); }
    resetAuth(); $GLOBALS['auth']['logged'] = false; denied(fn() => Endpoint::authorize($config));
    resetAuth(); $GLOBALS['auth']['caps'] = ['pbin_manage_previews']; denied(fn() => Endpoint::authorize($config));
    resetAuth(); Endpoint::authorize($config); check($GLOBALS['auth']['nonce_checks'] >= 1, 'Skipped cookie nonce enforcement');
});
test('application password requires approved principal and dedicated capability', function ($work, $config) {
    resetAuth(); $GLOBALS['auth']['app'] = 'approved-uuid'; $GLOBALS['auth']['caps'] = ['pbin_manage_previews']; $GLOBALS['wp_rest_auth_cookie'] = false;
    Endpoint::authorize($config); check($GLOBALS['auth']['core_checks'] === 1, 'Skipped app-password REST auth');
    $GLOBALS['auth']['id'] = 78; denied(fn() => Endpoint::authorize($config));
    $GLOBALS['auth']['id'] = 77; $GLOBALS['auth']['caps'] = ['manage_options']; denied(fn() => Endpoint::authorize($config));
    $GLOBALS['auth']['caps'] = ['pbin_manage_previews']; $GLOBALS['auth']['error'] = true; denied(fn() => Endpoint::authorize($config));
    $GLOBALS['auth']['error'] = false; $GLOBALS['auth']['ssl'] = false; denied(fn() => Endpoint::authorize($config));
});
test('health metadata is trusted, nonce-bound and confined to exact active health route', function () {
    $context = ['base_path' => '/previews/pr-1', 'request_base_path' => '/previews/pr-1', 'revision' => str_repeat('a', 40)];
    $nonce = str_repeat('b', 64); $headers = Health::headers('/previews/pr-1/health', $context, 'pbin-health-nonce=' . $nonce);
    check($headers === ['X-Pbin-Revision' => str_repeat('a', 40), 'Cache-Control' => 'no-store', 'X-Pbin-Health-Nonce' => $nonce], 'Incorrect health metadata');
    check(Health::headers('/previews/pr-1/paste', $context, 'pbin-health-nonce=' . $nonce) === [], 'Nonce reflected on unrelated route');
    foreach (['pbin-health-nonce=' . str_repeat('a', 65), 'pbin-health-nonce=' . str_repeat('A', 64), 'pbin-health-nonce=' . $nonce . '&pbin-health-nonce=' . $nonce, 'pbin-health-nonce[]=x', 'pbin-health-nonce=%61'] as $query) { denied(fn() => Health::headers('/previews/pr-1/health', $context, $query), RuntimeException::class); }
});
echo "PASS: $count offline controller protocol groups; native ZIP, actual WP auth and MySQL hosting not claimed\n";
