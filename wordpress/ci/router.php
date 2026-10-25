<?php
// Let the PHP development server execute real WordPress admin/login PHP files
// and serve core assets. All other routes enter WordPress's front controller.
$root = realpath($_SERVER['DOCUMENT_ROOT']);
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$candidate = is_string($path) ? realpath($root . rawurldecode($path)) : false;
if ($candidate && str_starts_with($candidate, $root . DIRECTORY_SEPARATOR)
    && (is_file($candidate) || is_dir($candidate))) {
    return false;
}
require $root . '/index.php';
