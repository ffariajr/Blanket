<?php

declare(strict_types=1);

// Local dev only: `php -S 127.0.0.1:PORT dev-router.php`. Mirrors what
// Apache + .htaccess do in production: an existing static file
// (index.html, assets/*) is served as-is, "/" resolves to index.html,
// internal paths (src/, bin/, vendor/, db/, ws-server/, dotfiles, and
// .env/.sql/.md/.sh/.lock/.json/.log files) are blocked the same way
// .htaccess blocks them, and everything else routes through index.php.
// Keep the two lists below in sync with .htaccess if either changes.

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';

$blockedDirs = ['src', 'bin', 'vendor', 'db', 'ws-server'];
$blockedExtensions = ['env', 'sql', 'md', 'sh', 'lock', 'json', 'log'];
$segments = array_values(array_filter(explode('/', $path)));

if ($path === '/dev-router.php'
    || (isset($segments[0]) && in_array($segments[0], $blockedDirs, true))
    || preg_match('/\.(' . implode('|', $blockedExtensions) . ')$/i', $path)
    || (isset($segments[0]) && str_starts_with($segments[0], '.'))
) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}

if ($path === '/' || $path === '') {
    $indexFile = __DIR__ . '/index.html';
    if (is_file($indexFile)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($indexFile);
        return true;
    }
}

$file = __DIR__ . $path;
if (is_file($file)) {
    return false; // let the built-in server serve it directly
}

require __DIR__ . '/index.php';
