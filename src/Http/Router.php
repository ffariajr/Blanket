<?php

declare(strict_types=1);

namespace Blanket\Http;

final class Router
{
    /** @var list<array{method:string,pattern:string,regex:string,names:list<string>,handler:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $names = [];
        $regex = preg_replace_callback(
            '#\{([a-zA-Z_][a-zA-Z0-9_]*)\}#',
            function (array $m) use (&$names): string {
                $names[] = $m[1];
                return '([^/]+)';
            },
            $pattern
        );
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'regex' => '#^' . $regex . '$#',
            'names' => $names,
            'handler' => $handler,
        ];
    }

    public function dispatch(Request $baseRequest): never
    {
        $matchedPath = false;
        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $baseRequest->path, $m)) {
                continue;
            }
            $matchedPath = true;
            if ($route['method'] !== $baseRequest->method) {
                continue;
            }
            array_shift($m);
            $params = array_combine($route['names'], $m);
            $request = new Request($baseRequest->method, $baseRequest->path, $params);
            ($route['handler'])($request);
            exit;
        }

        // SPA history-mode fallback: a real (non-hash) path like
        // /blanket/<guid>?tab=0 isn't a registered route, isn't a real
        // static file (those are served directly by Apache/php -S before
        // this ever runs -- see .htaccess / dev-router.php), and isn't
        // meant to be one -- it's client-side routing state. Serve the
        // SPA shell so app.js can read window.location.pathname/search
        // and render the right view. Scoped to GET and to paths that
        // don't look like an API call gone wrong, so a typo'd/removed
        // /api/* route still 404s as JSON instead of confusingly
        // returning HTML.
        if (!$matchedPath && $baseRequest->method === 'GET' && !str_starts_with($baseRequest->path, '/api/')) {
            $shell = dirname(__DIR__, 2) . '/index.html';
            if (is_file($shell)) {
                Response::raw((string) file_get_contents($shell), 'text/html; charset=utf-8');
            }
        }

        Response::error($matchedPath ? 'Method not allowed' : 'Not found', $matchedPath ? 405 : 404);
    }
}
