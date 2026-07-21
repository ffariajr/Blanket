<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Blanket\Controllers\AccessController;
use Blanket\Controllers\AuthController;
use Blanket\Controllers\CsvController;
use Blanket\Controllers\HistoryController;
use Blanket\Controllers\SpreadsheetController;
use Blanket\Controllers\TabController;
use Blanket\Controllers\UserController;
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

$router->add('POST', '/api/login', fn (Request $r) => (new AuthController())->login($r));

$router->add('GET', '/api/spreadsheets', fn (Request $r) => (new SpreadsheetController())->index($r));
$router->add('POST', '/api/spreadsheets', fn (Request $r) => (new SpreadsheetController())->create($r));
// Must be registered before /api/spreadsheets/{id} -- the router matches
// in registration order and {id}'s pattern ([^/]+) would otherwise treat
// the literal "guid" as an id.
$router->add('GET', '/api/spreadsheets/guid/{guid}', fn (Request $r) => (new SpreadsheetController())->byGuid($r));
$router->add('GET', '/api/spreadsheets/{id}', fn (Request $r) => (new SpreadsheetController())->show($r));
$router->add('PATCH', '/api/spreadsheets/{id}', fn (Request $r) => (new SpreadsheetController())->rename($r));
$router->add('DELETE', '/api/spreadsheets/{id}', fn (Request $r) => (new SpreadsheetController())->softDelete($r));
$router->add('DELETE', '/api/spreadsheets/{id}/purge', fn (Request $r) => (new SpreadsheetController())->hardDelete($r));

$router->add('GET', '/api/spreadsheets/{spreadsheet_id}/tabs', fn (Request $r) => (new TabController())->index($r));
$router->add('POST', '/api/spreadsheets/{spreadsheet_id}/tabs', fn (Request $r) => (new TabController())->create($r));
$router->add('PATCH', '/api/tabs/{id}', fn (Request $r) => (new TabController())->rename($r));
$router->add('PATCH', '/api/tabs/{id}/position', fn (Request $r) => (new TabController())->reorder($r));
$router->add('DELETE', '/api/tabs/{id}', fn (Request $r) => (new TabController())->softDelete($r));

$router->add('GET', '/api/tabs/{id}/current', fn (Request $r) => (new HistoryController())->current($r));
$router->add('GET', '/api/tabs/{id}/history', fn (Request $r) => (new HistoryController())->list($r));
$router->add('POST', '/api/tabs/{id}/restore', fn (Request $r) => (new HistoryController())->restore($r));
$router->add('POST', '/api/tabs/{id}/save', fn (Request $r) => (new HistoryController())->save($r));

$router->add('GET', '/api/spreadsheets/{spreadsheet_id}/access', fn (Request $r) => (new AccessController())->index($r));
$router->add('PUT', '/api/spreadsheets/{spreadsheet_id}/access/{user_id}', fn (Request $r) => (new AccessController())->grant($r));
$router->add('DELETE', '/api/spreadsheets/{spreadsheet_id}/access/{user_id}', fn (Request $r) => (new AccessController())->revoke($r));

$router->add('POST', '/api/tabs/{id}/import-csv', fn (Request $r) => (new CsvController())->import($r));
$router->add('GET', '/api/tabs/{id}/export-csv', fn (Request $r) => (new CsvController())->export($r));

$router->add('GET', '/api/users/lookup', fn (Request $r) => (new UserController())->lookup($r));

$router->dispatch(Request::fromGlobals());
