<?php
/** Test helper only. Load native-package.php, then call from an authorized harness.
 * This file registers no endpoint and executes no package code.
 */
function pbin_native_hosted_smoke(string $privateParent): array {
    $directory = $privateParent . '/.pbin-native-smoke-' . bin2hex(random_bytes(12));
    if (!mkdir($directory, 0700)) { throw new RuntimeException('Cannot create exclusive smoke scratch'); }
    $archive = $directory . '/fixture.zip';
    $revision = '0123456789abcdef0123456789abcdef01234567';
    $digest = '528b43b601adf2224cf06cee46837441a4610e01f6fb05745ac32136cb7cbaf3';
    $manifest = '0369454533372eb311405500d1f39ac21a867e50182a6d4436d7fde361139eb7';
    $bytes = base64_decode('UEsDBBQAAAAAAAAAIQCPkHHFAwIAAAMCAAANAAAAbWFuaWZlc3QuanNvbnsiZmlsZXMiOnsicGJpbi9wYmluLnBocCI6eyJzaGEyNTYiOiI2N2UxYjRhNmUyMzAxMmZhMjAyZWFjNzc2NTFhZTNmNjNiZThjZmIwZWEzZDk0Y2FiZWRjMzExNjBmYmY0MDk4Iiwic2l6ZSI6MjR9LCJwYmluL3J1bnRpbWUucGhwIjp7InNoYTI1NiI6ImIxOGUyMzg0YTQ1ZmVmNWYxNjVmMGY2NjIyYTg2NTk3ZTU0MzQwMjZlZjkxMjUwODBiYTk4MDM1YTdlYzMxMzkiLCJzaXplIjozMX0sInBiaW4vc3RhdGljL2JpbmFyeS5iaW4iOnsic2hhMjU2IjoiNzg1YjA3NTFmYzJjNTNkYzE0YTRjZTNkODAwZTY5ZWY5Y2UxMDA5ZWIzMjdjY2Y0NThhZmUwOWMyNDJjMjZjOSIsInNpemUiOjEwMjR9LCJwYmluL3N0YXRpYy9lbXB0eS50eHQiOnsic2hhMjU2IjoiZTNiMGM0NDI5OGZjMWMxNDlhZmJmNGM4OTk2ZmI5MjQyN2FlNDFlNDY0OWI5MzRjYTQ5NTk5MWI3ODUyYjg1NSIsInNpemUiOjB9fSwicmV2aXNpb24iOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3IiwidmVyc2lvbiI6MX0KUEsDBBQAAAAAAAAAIQDtwyRcGAAAABgAAAANAAAAcGJpbi9wYmluLnBocDw/cGhwIC8vIG5ldmVyIGV4ZWN1dGVkClBLAwQUAAAAAAAAACEAYWw+Ah8AAAAfAAAAEAAAAHBiaW4vcnVudGltZS5waHA8P3BocCAvLyBuZXZlciBleGVjdXRlZCBlaXRoZXIKUEsDBBQAAAAAAAAAIQAmTAu3AAQAAAAEAAAWAAAAcGJpbi9zdGF0aWMvYmluYXJ5LmJpbgABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v9QSwMEFAAAAAAAAAAhAAAAAAAAAAAAAAAAABUAAABwYmluL3N0YXRpYy9lbXB0eS50eHRQSwECFAMUAAAAAAAAACEAj5BxxQMCAAADAgAADQAAAAAAAAAAAAAApIEAAAAAbWFuaWZlc3QuanNvblBLAQIUAxQAAAAAAAAAIQDtwyRcGAAAABgAAAANAAAAAAAAAAAAAACkgS4CAABwYmluL3BiaW4ucGhwUEsBAhQDFAAAAAAAAAAhAGFsPgIfAAAAHwAAABAAAAAAAAAAAAAAAKSBcQIAAHBiaW4vcnVudGltZS5waHBQSwECFAMUAAAAAAAAACEAJkwLtwAEAAAABAAAFgAAAAAAAAAAAAAApIG+AgAAcGJpbi9zdGF0aWMvYmluYXJ5LmJpblBLAQIUAxQAAAAAAAAAIQAAAAAAAAAAAAAAAAAVAAAAAAAAAAAAAACkgfIGAABwYmluL3N0YXRpYy9lbXB0eS50eHRQSwUGAAAAAAUABQA7AQAAJQcAAAAA', true);
    if (!is_string($bytes) || !hash_equals($digest, hash('sha256', $bytes))) { throw new RuntimeException('Embedded fixture corrupt'); }
    $stream = fopen($archive, 'xb');
    if (!$stream) { throw new RuntimeException('Cannot create smoke fixture'); }
    try { if (fwrite($stream, $bytes) !== strlen($bytes) || !fflush($stream) || !fsync($stream)) { throw new RuntimeException('Cannot write smoke fixture'); } }
    finally { fclose($stream); }
    // Preserve failed scratch for diagnostics; caller owns any later cleanup.
    $result = \Pbin\Preview\Control\NativePackage::extract($archive, $digest, $revision, $directory . '/release');
    $verified = \Pbin\Preview\Control\NativePackage::verifyExisting($directory . '/release', $revision, $digest, $manifest);
    if ($result !== $verified) { throw new RuntimeException('Native extraction/retained verification disagreement'); }
    return ['ok' => true, 'php_version' => PHP_VERSION, 'integer_size' => PHP_INT_SIZE,
        'artifact_sha256' => $digest, 'manifest_sha256' => $manifest,
        'file_count' => $result['file_count'], 'entry_count' => $result['entry_count'],
        'uncompressed_bytes' => $result['uncompressed_bytes'],
        'scratch_basename' => basename($directory)];
}
