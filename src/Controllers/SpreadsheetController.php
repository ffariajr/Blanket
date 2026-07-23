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

        // my_access per row, same field show()/byGuid() already compute --
        // the books-menu list needs it to decide "Duplicate" (owner) vs.
        // "Make a copy" (edit/view) vs. no button at all.
        $spreadsheets = array_map(
            function (array $s) use ($user) {
                $s['my_access'] = $this->permissions->levelFor($s, $user);
                return $s;
            },
            $this->spreadsheets->listForUser($user->id),
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

        $newId = $this->spreadsheets->create($user->id, $source['title'] . ' (copy)');

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

    private function findOrFail(int $id): array
    {
        $spreadsheet = $this->spreadsheets->find($id);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        return $spreadsheet;
    }
}
