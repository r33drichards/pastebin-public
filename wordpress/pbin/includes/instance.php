<?php
namespace Pbin\Plugin;

use InvalidArgumentException;
use LogicException;
use Pbin\Routing\Mount;
require_once __DIR__ . '/mount.php';

/** Functional tenancy for reviewed code. This is not a PHP security sandbox. */
final class Instance {
    private static ?self $selected = null;
    public function __construct(
        public readonly string $key,
        public readonly string $basePath,
        public readonly string $pluginDir,
        public readonly string $revision = '',
        public readonly bool $preview = false,
        public readonly ?string $requestBasePath = null,
        public readonly ?string $dataDir = null,
        public readonly bool $editorAtBase = false,
        public readonly array $aliases = []
    ) {
        if (!preg_match('/^(?:default|pr_[1-9][0-9]{0,9})$/D', $key)) { throw new InvalidArgumentException('Invalid instance key'); }
        foreach ([$basePath, $requestBasePath ?? $basePath] as $path) {
            if ($path !== '' && !preg_match('~^/[a-zA-Z0-9/_-]+$~D', $path)) { throw new InvalidArgumentException('Invalid instance path'); }
            if ($path !== rtrim($path, '/')) { throw new InvalidArgumentException('Instance paths must not end in a slash'); }
        }
        if (!is_dir($pluginDir) || realpath($pluginDir) !== $pluginDir) { throw new InvalidArgumentException('Package path must be canonical'); }
        if ($preview && (!preg_match('/^[a-f0-9]{40}$/D', $revision) || $key === 'default')) { throw new InvalidArgumentException('Preview needs an instance and immutable revision'); }
        new Mount($basePath, $editorAtBase, $aliases);
    }
    public static function select(self $instance): void {
        if (self::$selected !== null) { throw new LogicException('Only one pbin package may be selected per request'); }
        self::$selected = $instance;
    }
    public static function current(): self {
        if (self::$selected === null) { throw new LogicException('pbin instance must be selected before loading code'); }
        return self::$selected;
    }
    public function storagePrefix(): string { return $this->key === 'default' ? 'pbin_' : 'pbin_' . $this->key . '_'; }
    public function optionKey(string $key): string { return $this->storagePrefix() . $key; }
    public function cacheGroup(): string { return rtrim($this->storagePrefix(), '_'); }
    public function path(string $path = '/'): string {
        if ($this->preview && str_starts_with($path, '/static/')) {
            return $this->basePath . '/_releases/' . $this->revision . $path;
        }
        return (new Mount($this->basePath, $this->editorAtBase, $this->aliases))->path($path);
    }
    public function routeForPath(string $path, string $method, bool $hasId): ?string {
        return (new Mount($this->requestBasePath ?? $this->basePath, $this->editorAtBase, $this->aliases))->route($path, $method, $hasId);
    }
}
