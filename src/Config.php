<?php

declare(strict_types=1);

namespace Blanket;

final class Config
{
    private static ?array $values = null;

    public static function get(string $key): string
    {
        self::load();
        if (!array_key_exists($key, self::$values)) {
            throw new \RuntimeException("Missing config value: {$key}");
        }
        return self::$values[$key];
    }

    private static function load(): void
    {
        if (self::$values !== null) {
            return;
        }

        self::$values = [
            // Non-secret, fixed application config.
            'DB_NAME' => 'blanket',
            'DB_PORT' => '3306',
            'DB_SSL' => 'true',
        ];

        foreach (['.mysql.env', '.app.env'] as $file) {
            self::mergeEnvFile(dirname(__DIR__) . '/' . $file);
        }
    }

    private static function mergeEnvFile(string $path): void
    {
        if (!is_readable($path)) {
            throw new \RuntimeException("Missing required config file: {$path}");
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            $eq = strpos($line, '=');
            if ($eq === false) {
                continue;
            }
            $key = trim(substr($line, 0, $eq));
            $value = substr($line, $eq + 1);
            self::$values[$key] = $value;
        }
    }
}
