<?php
// Destructive operations are restricted to a fresh, randomly named local test DB.
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$host = getenv('PBIN_TEST_DB_HOST') ?: '127.0.0.1';
$name = getenv('PBIN_TEST_DB_NAME') ?: '';
if (!in_array($host, ['127.0.0.1', 'localhost'], true)
    || !preg_match('/^pbin_ci_[a-f0-9]{24}$/D', $name)) {
    throw new RuntimeException('Refusing a non-local or non-disposable database');
}
$db = new mysqli($host, getenv('PBIN_TEST_DB_USER') ?: 'root',
    getenv('PBIN_TEST_DB_PASSWORD') ?: '', '', (int) (getenv('PBIN_TEST_DB_PORT') ?: 3306));
switch ($argv[1] ?? '') {
    case 'create':
        // Never reuse, reset, or drop a database that was not created by this run.
        $db->query("CREATE DATABASE `$name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        break;
    case 'drop':
        $db->query("DROP DATABASE `$name`");
        break;
    default:
        throw new InvalidArgumentException('Expected create or drop');
}
