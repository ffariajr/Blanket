<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\CurrentUser;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\AccessRepository;
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
        private readonly AccessRepository $access = new AccessRepository(),
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

        // ?title_contains=... : case-insensitive substring filter (Fernando:
        // "query my spreadsheets, filter with 'TEMPLATE' in the name").
        // Omitted entirely -> unfiltered, exactly like before this existed.
        $titleContains = $request->query('title_contains');

        // my_access per row, same field show()/byGuid() already compute --
        // the books-menu list needs it to decide "Duplicate" (owner) vs.
        // "Make a copy" (edit/view) vs. no button at all.
        $spreadsheets = array_map(
            function (array $s) use ($user) {
                $s['my_access'] = $this->permissions->levelFor($s, $user);
                return $s;
            },
            $this->spreadsheets->listForUser($user->id, is_string($titleContains) ? $titleContains : null),
        );
        Response::json(['spreadsheets' => $spreadsheets]);
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

        // The client used to hardcode Grid.readOnly = false and rely
        // entirely on the server rejecting unauthorized writes -- which
        // just produces "edits silently have no effect" instead of a UI
        // that actually reflects access. levelFor() already computes
        // exactly what the client needs ('owner'|'edit'|'view'|null);
        // canView() above guarantees non-null here.
        $spreadsheet['my_access'] = $this->permissions->levelFor($spreadsheet, $user);
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

        $spreadsheet['my_access'] = $this->permissions->levelFor($spreadsheet, $user);
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

    /**
     * Duplicates a spreadsheet: new id/guid, owner = whoever clicked
     * Duplicate (Fernando: "a duplicate spreadsheet button... duplicates
     * the spreadsheet"). Every tab is cloned with the ORIGINAL's current
     * content as a fresh sequence-1 history row -- the change history
     * itself is deliberately not copied (Fernando: "not the change
     * history"), so the copy starts with one clean baseline snapshot, not
     * someone else's decade of edits.
     *
     * canView() is enough to duplicate at all (an editor/viewer can save
     * their own copy), but `duplicate_sharing` -- copying spreadsheet_access
     * rows, including the anonymous policy -- is force-disabled unless the
     * requester is owner/admin (canManage()), regardless of what the
     * request body claims. A non-owner can't see the sharing list at all
     * (AccessController already 403s them), so a client-supplied flag
     * alone can't be trusted to gate copying it -- this mirrors why
     * TabController's canManage() checks don't trust the client either.
     */
    public function duplicate(Request $request): void
    {
        $user = Authenticator::resolve($request);
        if ($user->isAnonymous()) {
            // No account to set as the copy's owner_id.
            Response::error('Authentication required', 401);
        }

        $source = $this->findOrFail((int) $request->params['id']);
        if (!$this->permissions->canView($source, $user)) {
            Response::error('Forbidden', 403);
        }

        $duplicateSharing = (bool) $request->input('duplicate_sharing', false)
            && $this->permissions->canManage($source, $user);

        // Optional custom title (Fernando: "duplicate that one with a new
        // name") -- falls back to the original auto-generated "(copy)"
        // suffix when omitted or blank, so existing callers are unaffected.
        $customTitle = trim((string) $request->input('title', ''));
        $newTitle = $customTitle !== '' ? $customTitle : $source['title'] . ' (copy)';

        $newId = $this->spreadsheets->create($user->id, $newTitle);

        foreach ($this->tabs->listForSpreadsheet($source['id']) as $tab) {
            $newTabId = $this->tabs->create($newId, $tab['name'], $tab['position']);
            $current = $this->history->current($tab['id']);
            $this->history->save(
                $newTabId,
                $current['data'] ?? ['cells' => (object) []],
                $user,
                $request->clientIp(),
                null,
            );
        }

        if ($duplicateSharing) {
            foreach ($this->access->listForSpreadsheet($source['id']) as $row) {
                $this->access->grant($newId, $row['user_id'], $row['access_level']);
            }
        }

        Response::json(['id' => $newId], 201);
    }

    /**
     * Bulk find-and-replace across cell text, for Fernando's own scripting/
     * automation use (e.g. filling in "{{ChurchName}}"-style placeholders
     * across a template spreadsheet before an event -- see TODO.md "Step 1
     * - API surface"). Operates on each matching cell's raw `value` string
     * verbatim, formula or not -- a plain text substitution, not a
     * formula-aware one, matching how find-and-replace works by default in
     * most spreadsheet tools.
     *
     * canEdit(), not canManage() -- this is bulk cell-CONTENT editing, the
     * same permission class as saving a cell normally, not a tab-structure
     * operation like create/rename/reorder/delete (owner-only, see
     * TabController).
     */
    public function findReplace(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->findOrFail((int) $request->params['id']);

        if (!$this->permissions->canEdit($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

        $find = (string) $request->input('find', '');
        if ($find === '') {
            Response::error('find is required', 422);
        }
        $replace = (string) $request->input('replace', '');
        $caseSensitive = (bool) $request->input('case_sensitive', false);

        // tab_ids scopes to a subset; an id that isn't actually one of this
        // spreadsheet's tabs is silently dropped here (listForSpreadsheet()
        // already only returns tabs belonging to $spreadsheet) rather than
        // erroring -- a caller can't touch another spreadsheet's tab just by
        // guessing its id.
        $allTabs = $this->tabs->listForSpreadsheet($spreadsheet['id']);
        $tabIdsInput = $request->input('tab_ids');
        if (is_array($tabIdsInput) && $tabIdsInput !== []) {
            $wanted = array_map('intval', $tabIdsInput);
            $tabsInScope = array_values(array_filter($allTabs, fn (array $t) => in_array($t['id'], $wanted, true)));
        } else {
            $tabsInScope = $allTabs;
        }

        // cells scopes to specific A1 refs/ranges within each in-scope tab;
        // omitted/empty means every cell. null (not []) is the "no scope"
        // sentinel so an explicitly-empty array doesn't get confused with
        // "match everything".
        $cellsInput = $request->input('cells');
        $scopeBounds = null;
        if (is_array($cellsInput) && $cellsInput !== []) {
            $scopeBounds = [];
            foreach ($cellsInput as $entry) {
                $parsed = $this->parseScopeEntry((string) $entry);
                if ($parsed !== null) {
                    $scopeBounds[] = $parsed;
                }
            }
        }

        $editorName = $request->input('editor_name');
        $tabsChanged = [];
        $cellsChanged = 0;

        foreach ($tabsInScope as $tab) {
            $current = $this->history->current($tab['id']);
            $data = $current['data'] ?? null;
            $cellsObj = (is_object($data) && isset($data->cells)) ? $data->cells : new \stdClass();
            $cellsArr = (array) $cellsObj;

            $tabChanged = false;
            foreach ($cellsArr as $ref => $cell) {
                if (!is_object($cell) || !isset($cell->value) || !is_string($cell->value)) {
                    continue;
                }
                if ($scopeBounds !== null && !$this->refInScope((string) $ref, $scopeBounds)) {
                    continue;
                }
                $newValue = $caseSensitive
                    ? str_replace($find, $replace, $cell->value)
                    : str_ireplace($find, $replace, $cell->value);
                if ($newValue !== $cell->value) {
                    $cell->value = $newValue;
                    $cellsArr[$ref] = $cell;
                    $tabChanged = true;
                    $cellsChanged++;
                }
            }

            // Append-only history: only write a new row for a tab that
            // actually changed, never a no-op entry just because it was in
            // scope -- a needless row is permanent clutter, not undoable.
            if ($tabChanged) {
                $newData = (array) $data;
                $newData['cells'] = (object) $cellsArr;
                $this->history->save(
                    $tab['id'],
                    $newData,
                    $user,
                    $request->clientIp(),
                    is_string($editorName) ? $editorName : null,
                );
                $tabsChanged[] = $tab['id'];
            }
        }

        Response::json(['tabs_changed' => $tabsChanged, 'cells_changed' => $cellsChanged]);
    }

    /**
     * Parses one `cells` scope entry into a 0-based, inclusive
     * [minCol, maxCol, minRow, maxRow] bound -- PHP_INT_MAX standing in for
     * "unbounded in that direction" (a whole row/column). Mirrors
     * assets/js/formulas.js's A1 grammar (multi-letter columns, A..Z then
     * AA..AZ...) but is its own small implementation, same as
     * CsvController's parseA1Ref/colIndexToLetter -- not worth sharing
     * across controllers for four lines of arithmetic.
     */
    private function parseScopeEntry(string $entry): ?array
    {
        $entry = strtoupper(trim($entry));

        if (preg_match('/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/', $entry, $m)) {
            $c1 = $this->colLetterToIndex($m[1]);
            $c2 = $this->colLetterToIndex($m[3]);
            $r1 = ((int) $m[2]) - 1;
            $r2 = ((int) $m[4]) - 1;
            return [min($c1, $c2), max($c1, $c2), min($r1, $r2), max($r1, $r2)];
        }
        if (preg_match('/^([A-Z]+):([A-Z]+)$/', $entry, $m)) {
            $c1 = $this->colLetterToIndex($m[1]);
            $c2 = $this->colLetterToIndex($m[2]);
            return [min($c1, $c2), max($c1, $c2), 0, PHP_INT_MAX];
        }
        if (preg_match('/^(\d+):(\d+)$/', $entry, $m)) {
            $r1 = ((int) $m[1]) - 1;
            $r2 = ((int) $m[2]) - 1;
            return [0, PHP_INT_MAX, min($r1, $r2), max($r1, $r2)];
        }
        if (preg_match('/^([A-Z]+)(\d+)$/', $entry, $m)) {
            $c = $this->colLetterToIndex($m[1]);
            $r = ((int) $m[2]) - 1;
            return [$c, $c, $r, $r];
        }
        return null;
    }

    private function refInScope(string $ref, array $scopeBounds): bool
    {
        if (!preg_match('/^([A-Z]+)(\d+)$/', strtoupper($ref), $m)) {
            return false;
        }
        $col = $this->colLetterToIndex($m[1]);
        $row = ((int) $m[2]) - 1;
        foreach ($scopeBounds as [$minCol, $maxCol, $minRow, $maxRow]) {
            if ($col >= $minCol && $col <= $maxCol && $row >= $minRow && $row <= $maxRow) {
                return true;
            }
        }
        return false;
    }

    private function colLetterToIndex(string $letters): int
    {
        $col = 0;
        foreach (str_split($letters) as $ch) {
            $col = $col * 26 + (ord($ch) - 64);
        }
        return $col - 1;
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
