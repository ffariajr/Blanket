<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Blanket\Controllers\AuthController;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Http\Router;

set_exception_handler(function (\Throwable $e): void {
    error_log($e->__toString());
    Response::error('Internal server error', 500);
});

$router = new Router();

$router->add('GET', '/api/health', function (Request $request): void {
    Response::json(['status' => 'ok']);
});

$router->add('POST', '/api/login', function (Request $request): void {
    (new AuthController())->login($request);
});

$router->dispatch(Request::fromGlobals());
