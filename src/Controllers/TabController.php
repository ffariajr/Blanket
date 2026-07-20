<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\HistoryRepository;
use Blanket\Repositories\SpreadsheetRepository;
use Blanket\Repositories\TabRepository;

final class TabController
{
    public function __construct(
        private readonly TabRepository $tabs = new TabRepository(),
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly HistoryRepository $history = new HistoryRepository(),
        private readonly Permissions $permissions = new Permissions(),
    ) {
    }

    public function index(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->requireSpreadsheet((int) $request->params['spreadsheet_id']);

        if (!$this->permissions->canView($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        Response::json(['tabs' => $this->tabs->listForSpreadsheet($spreadsheet['id'])]);
    }

    /** Creates the tab, then writes the initial spreadsheet_history row (sequence 1) attributed to the creator -- see db/schemas.md, tabs. */
    public function create(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->requireSpreadsheet((int) $request->params['spreadsheet_id']);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $name = trim((string) $request->input('name', ''));
        if ($name === '') {
            Response::error('Name is required', 422);
        }
        $editorName = $request->input('editor_name');

        $position = $this->tabs->nextPosition($spreadsheet['id']);
        $tabId = $this->tabs->create($spreadsheet['id'], $name, $position);

        $this->history->save(
            $tabId,
            ['cells' => (object) []],
            $user,
            $request->clientIp(),
            is_string($editorName) ? $editorName : null,
        );

        Response::json(['id' => $tabId, 'position' => $position], 201);
    }

    public function rename(Request $request): void
    {
        $user = Authenticator::resolve($request);
        [, $spreadsheet] = $this->requireTabAndSpreadsheet((int) $request->params['id']);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $name = trim((string) $request->input('name', ''));
        if ($name === '') {
            Response::error('Name is required', 422);
        }

        $this->tabs->rename((int) $request->params['id'], $name);
        Response::json(['status' => 'ok']);
    }

    public function reorder(Request $request): void
    {
        $user = Authenticator::resolve($request);
        [, $spreadsheet] = $this->requireTabAndSpreadsheet((int) $request->params['id']);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $position = $request->input('position');
        if (!is_int($position) && !is_numeric($position)) {
            Response::error('Position is required', 422);
        }

        $this->tabs->reorder((int) $request->params['id'], (int) $position);
        Response::json(['status' => 'ok']);
    }

    /** Flushes current content to spreadsheet_history (attributed to the deleter), then soft-deletes -- see db/schemas.md, tabs. */
    public function softDelete(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [$tab, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $current = $this->history->current($tabId);
        $editorName = $request->input('editor_name');
        $this->history->save(
            $tabId,
            $current['data'] ?? ['cells' => (object) []],
            $user,
            $request->clientIp(),
            is_string($editorName) ? $editorName : null,
        );

        $this->tabs->softDelete($tabId);
        Response::json(['status' => 'ok']);
    }

    private function requireSpreadsheet(int $id): array
    {
        $spreadsheet = $this->spreadsheets->find($id);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        return $spreadsheet;
    }

    /** @return array{0:array,1:array} [tab, spreadsheet] */
    private function requireTabAndSpreadsheet(int $tabId): array
    {
        $tab = $this->tabs->find($tabId);
        if ($tab === null) {
            Response::error('Not found', 404);
        }
        $spreadsheet = $this->spreadsheets->find($tab['spreadsheet_id']);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        return [$tab, $spreadsheet];
    }
}
