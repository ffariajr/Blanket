<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\CurrentUser;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\HistoryRepository;
use Blanket\Repositories\SpreadsheetRepository;
use Blanket\Repositories\TabRepository;

final class SpreadsheetController
{
    public function __construct(
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly Permissions $permissions = new Permissions(),
        private readonly TabRepository $tabs = new TabRepository(),
        private readonly HistoryRepository $history = new HistoryRepository(),
    ) {
    }

    public function index(Request $request): void
    {
        $user = Authenticator::resolve($request);
        if ($user->isAnonymous()) {
            // Spreadsheets aren't publicly listed; access is by URL (README).
            // "My spreadsheets" has no meaning for an anonymous visitor.
            Response::error('Authentication required', 401);
        }
        Response::json(['spreadsheets' => $this->spreadsheets->listForUser($user->id)]);
    }

    public function create(Request $request): void
    {
        $user = Authenticator::resolve($request);
        if ($user->isAnonymous()) {
            Response::error('Authentication required', 401);
        }

        $title = trim((string) $request->input('title', ''));
        if ($title === '') {
            Response::error('Title is required', 422);
        }

        $id = $this->spreadsheets->create($user->id, $title);
        $this->createDefaultTab($id, $user, $request);

        Response::json(['id' => $id], 201);
    }

    /**
     * A new workbook always starts with one tab named "tab-0" (Fernando:
     * "new workbooks should start with a tab named 'tab-0'. that new tab
     * should have cols A-F, and 20 rows.") -- mirrors exactly what
     * TabController::create() does for a manually-added tab (tab row +
     * initial history row, same DEFAULT_COLS/DEFAULT_ROWS, same
     * "creation always writes an initial history row" convention from
     * db/migrations/0005), duplicated here rather than calling into
     * TabController directly since that class is HTTP-request-shaped
     * (reads $request->params['spreadsheet_id']), not reusable as a plain
     * service method.
     */
    private function createDefaultTab(int $spreadsheetId, CurrentUser $user, Request $request): void
    {
        $tabId = $this->tabs->create($spreadsheetId, 'tab-0', 0);
        $this->history->save(
            $tabId,
            ['cells' => (object) [], 'cols' => TabController::DEFAULT_COLS, 'rows' => TabController::DEFAULT_ROWS],
            $user,
            $request->clientIp(),
            null,
        );
    }

    public function show(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->findOrFail((int) $request->params['id']);

        if (!$this->permissions->canView($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        Response::json($spreadsheet);
    }

    /** Resolves a guid-based share URL to the full spreadsheet (including its numeric id, for reuse of every id-based endpoint from here on). */
    public function byGuid(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $guid = (string) $request->params['guid'];

        $spreadsheet = $this->spreadsheets->findByGuid($guid);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }

        if (!$this->permissions->canView($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        Response::json($spreadsheet);
    }

    public function rename(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->findOrFail((int) $request->params['id']);

        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $title = trim((string) $request->input('title', ''));
        if ($title === '') {
            Response::error('Title is required', 422);
        }

        $this->spreadsheets->rename($spreadsheet['id'], $title);
        Response::json(['status' => 'ok']);
    }

    public function softDelete(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->findOrFail((int) $request->params['id']);

        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $this->spreadsheets->softDelete($spreadsheet['id']);
        Response::json(['status' => 'ok']);
    }

    /** Real DELETE, admin only. Cascades to tabs, spreadsheet_history, spreadsheet_access. */
    public function hardDelete(Request $request): void
    {
        $user = Authenticator::resolve($request);
        if (!$user->isAdmin) {
            Response::error('Forbidden', 403);
        }

        $id = (int) $request->params['id'];
        $this->spreadsheets->hardDelete($id);
        Response::json(['status' => 'ok']);
    }

    private function findOrFail(int $id): array
    {
        $spreadsheet = $this->spreadsheets->find($id);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        return $spreadsheet;
    }
}
