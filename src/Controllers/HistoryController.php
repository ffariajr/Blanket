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

final class HistoryController
{
    public function __construct(
        private readonly HistoryRepository $history = new HistoryRepository(),
        private readonly TabRepository $tabs = new TabRepository(),
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly Permissions $permissions = new Permissions(),
    ) {
    }

    public function current(Request $request): void
    {
        [, $spreadsheet] = $this->requireViewable($request);
        $tabId = (int) $request->params['id'];

        $row = $this->history->current($tabId);
        if ($row === null) {
            Response::error('No history for this tab', 404);
        }
        Response::json($row);
    }

    public function list(Request $request): void
    {
        [, $spreadsheet] = $this->requireViewable($request);
        $tabId = (int) $request->params['id'];

        $limit = min(200, max(1, (int) ($request->params['limit'] ?? 50)));
        Response::json(['history' => $this->history->listForTab($tabId, $limit)]);
    }

    public function restore(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [$tab, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $sequence = $request->input('sequence');
        if (!is_int($sequence) && !is_numeric($sequence)) {
            Response::error('sequence is required', 422);
        }

        $source = $this->history->findBySequence($tabId, (int) $sequence);
        if ($source === null) {
            Response::error('Version not found', 404);
        }

        $editorName = $request->input('editor_name');
        $newSequence = $this->history->save(
            $tabId,
            $source['data'],
            $user,
            $request->clientIp(),
            is_string($editorName) ? $editorName : null,
        );

        Response::json(['sequence' => $newSequence]);
    }

    /** @return array{0:array,1:array} [tab, spreadsheet] */
    private function requireViewable(Request $request): array
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [$tab, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canView($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        return [$tab, $spreadsheet];
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
