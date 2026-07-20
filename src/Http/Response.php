<?php

declare(strict_types=1);

namespace Blanket\Http;

final class Response
{
    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($data, JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function error(string $message, int $status): never
    {
        self::json(['error' => $message], $status);
    }

    public static function raw(string $body, string $contentType, int $status = 200, array $headers = []): never
    {
        http_response_code($status);
        header('Content-Type: ' . $contentType);
        foreach ($headers as $name => $value) {
            header("{$name}: {$value}");
        }
        echo $body;
        exit;
    }
}
