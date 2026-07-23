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
    /** Default grid dimensions for a newly created tab -- see CELL_SCHEMA.md, "cols/rows". */
    public const DEFAULT_COLS = 6;  // A-F
    public const DEFAULT_ROWS = 20;

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

    /**
     * Creates the tab, then writes the initial spreadsheet_history row (sequence 1) attributed to the creator -- see db/schemas.md, tabs.
     *
     * Every tab-structure mutation in this class (create/rename/reorder/
     * softDelete) requires canManage(), not canEdit() -- Fernando: "only
     * the spreadsheet owner can manage tabs." canManage() already covers
     * admins too (Permissions::levelFor() treats an admin as 'owner'), so
     * this is "owner or admin," same as spreadsheet rename/share already
     * were -- an editor can change cell content but not the tab structure
     * itself.
     */
    public function create(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->requireSpreadsheet((int) $request->params['spreadsheet_id']);

        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $name = trim((string) $request->input('name', ''));
        if ($name === '') {
            Response::error('Name is required', 422);
        }
        $editorName = $request->input('editor_name');

        $position = $this->tabs->nextPosition($spreadsheet['id']);
        $tabId = $this->tabs->create($spreadsheet['id'], $name, $position);

        // cols/rows: a new tab's initial grid dimensions (Fernando: "that
        // new tab should have cols A-F, and 20 rows"). Stored inside the
        // history row's data, not the tabs table -- grid dimensions are
        // part of the document, the same as cells/columnWidths/rowHeights
        // (see CELL_SCHEMA.md). Applies to any newly created tab, not just
        // a new workbook's auto-created first one (SpreadsheetController::
        // create() below reuses this same default for consistency).
        $this->history->save(
            $tabId,
            ['cells' => (object) [], 'cols' => self::DEFAULT_COLS, 'rows' => self::DEFAULT_ROWS],
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

        if (!$this->permissions->canManage($spreadsheet, $user)) {
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

        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $position = $request->input('position');
        if (!is_int($position) && !is_numeric($position)) {
            Response::error('Position is required', 422);
        }
        // The tabs.position column is an unsigned int -- reject negative
        // values here with a 422 rather than letting them fall through to a
        // DB constraint violation (which surfaces as an opaque 500).
        if ((int) $position < 0) {
            Response::error('Position must not be negative', 422);
        }

        $this->tabs->reorder((int) $request->params['id'], $spreadsheet['id'], (int) $position);
        Response::json(['status' => 'ok']);
    }

    /** Flushes current content to spreadsheet_history (attributed to the deleter), then soft-deletes -- see db/schemas.md, tabs. */
    public function softDelete(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $tabId = (int) $request->params['id'];
        [$tab, $spreadsheet] = $this->requireTabAndSpreadsheet($tabId);

        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        // A spreadsheet must always have at least one tab -- enforced here,
        // not just client-side (Manage Tabs already hides the option when
        // only one remains), since the client can't be trusted for an
        // invariant this important (e.g. SpreadsheetController::create()
        // relies on "a new spreadsheet always has exactly one tab" only
        // holding until a human chooses to delete it down to zero).
        if (count($this->tabs->listForSpreadsheet($spreadsheet['id'])) <= 1) {
            Response::error('Cannot delete the last tab in a spreadsheet', 422);
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
