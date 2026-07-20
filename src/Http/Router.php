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

        Response::error($matchedPath ? 'Method not allowed' : 'Not found', $matchedPath ? 405 : 404);
    }
}
