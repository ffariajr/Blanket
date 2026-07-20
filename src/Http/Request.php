<?php

declare(strict_types=1);

namespace Blanket\Http;

final class Request
{
    public readonly string $method;
    public readonly string $path;
    /** @var array<string,string> */
    public readonly array $params;
    private readonly string $rawBody;
    private readonly array $body;
    private readonly array $headers;

    /** @param array<string,string> $params */
    public function __construct(string $method, string $path, array $params = [])
    {
        $this->method = $method;
        $this->path = $path;
        $this->params = $params;
        $this->rawBody = self::readRawBody();
        $this->body = self::parseJsonBody($this->rawBody);
        $this->headers = self::collectHeaders();
    }

    public static function fromGlobals(): self
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
        $path = self::stripBasePath($uriPath);
        return new self($method, $path);
    }

    /**
     * The app is served at https://church.dogmanjr.net/blanket/ in
     * production but at the webroot with `php -S` in dev -- routes are
     * registered without a prefix either way, so strip whatever base path
     * the front controller is actually mounted under. Derived from
     * SCRIPT_NAME (the physical script Apache/php -S executed), not
     * REQUEST_URI (the possibly-rewritten virtual URL), so this needs no
     * hardcoded "/blanket" anywhere and keeps working if the mount point
     * ever changes.
     */
    private static function stripBasePath(string $uriPath): string
    {
        $scriptName = $_SERVER['SCRIPT_NAME'] ?? '/index.php';
        $basePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');

        if ($basePath !== '' && str_starts_with($uriPath, $basePath)) {
            $uriPath = substr($uriPath, strlen($basePath));
        }

        return $uriPath === '' ? '/' : $uriPath;
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $default;
    }

    public function query(string $key, mixed $default = null): mixed
    {
        return $_GET[$key] ?? $default;
    }

    /**
     * Like input(), but decodes the request body without forcing JSON
     * objects to associative arrays. json_decode(..., true) (used for the
     * plain $body backing input()) can't distinguish an empty JSON object
     * {} from an empty JSON array [] -- both collapse to a PHP [] -- so a
     * field whose value gets re-serialized later (e.g. a spreadsheet
     * history `data` payload, see HistoryController::save()) would
     * silently corrupt any empty nested object in it before it's ever
     * written. Use this for such fields; use input() for plain scalars,
     * which don't care.
     */
    public function inputPreservingObjects(string $key): mixed
    {
        if ($this->rawBody === '') {
            return null;
        }
        $decoded = json_decode($this->rawBody);
        if (!is_object($decoded)) {
            return null;
        }
        return $decoded->$key ?? null;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('Authorization');
        if ($auth !== null && str_starts_with($auth, 'Bearer ')) {
            return substr($auth, 7);
        }
        return null;
    }

    /**
     * Real client IP, resolved from X-Forwarded-For since Apache sits in
     * front as a reverse proxy (see MACHINE.md / db/schemas.md). Takes the
     * left-most (original client) entry.
     */
    public function clientIp(): string
    {
        $xff = $this->header('X-Forwarded-For');
        if ($xff !== null && $xff !== '') {
            $first = trim(explode(',', $xff)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    private static function readRawBody(): string
    {
        $raw = file_get_contents('php://input');
        return $raw === false ? '' : $raw;
    }

    private static function parseJsonBody(string $raw): array
    {
        if ($raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }

    private static function collectHeaders(): array
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = str_replace('_', '-', substr($key, 5));
                $headers[strtolower($name)] = $value;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = $_SERVER['CONTENT_TYPE'];
        }
        return $headers;
    }
}
