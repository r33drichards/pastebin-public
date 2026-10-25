<?php
namespace Pbin\Routing;

/** URL mapping only. Alias requests use the same store and canonical links. */
final class Mount {
    public function __construct(
        public readonly string $basePath,
        public readonly bool $editorAtBase = false,
        public readonly array $aliases = []
    ) {
        foreach (array_merge([$basePath], $aliases) as $path) {
            if (!is_string($path) || ($path !== '' && !preg_match('~^/[a-zA-Z0-9/_-]+$~D', $path))
                || $path !== rtrim($path, '/') || str_contains($path, '//')) {
                throw new \InvalidArgumentException('Invalid pbin mount path');
            }
        }
    }
    public function path(string $route = '/'): string {
        if ($this->editorAtBase && ($route === '/' || $route === '/paste')) { return $this->basePath; }
        return $this->basePath . $route;
    }
    public function route(string $path, string $method, bool $hasId): ?string {
        foreach (array_merge([$this->basePath], $this->aliases) as $base) {
            if ($path !== $base && !str_starts_with($path, $base . '/')) { continue; }
            $route = substr($path, strlen($base));
            if ($route === '' || $route === '/') {
                return $this->editorAtBase && (in_array($method, ['POST', 'PUT'], true) || $hasId) ? '/paste' : '/';
            }
            return $route;
        }
        return null;
    }
}
