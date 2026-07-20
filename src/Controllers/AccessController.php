<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\AccessRepository;
use Blanket\Repositories\SpreadsheetRepository;

/**
 * Grant/revoke access for a specific user, and set/clear the anonymous
 * access policy for a spreadsheet -- both are the same underlying
 * operation (spreadsheet_access has no dedicated "anonymous" concept, just
 * user_id=0), so the same routes/methods handle both by accepting 0 as a
 * valid {user_id}. Owner or admin only; no granted_by is recorded by
 * design (see db/migrations/0004).
 */
final class AccessController
{
    public function __construct(
        private readonly AccessRepository $access = new AccessRepository(),
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly Permissions $permissions = new Permissions(),
    ) {
    }

    public function index(Request $request): void
    {
        $spreadsheet = $this->requireManageable($request);
        Response::json(['access' => $this->access->listForSpreadsheet($spreadsheet['id'])]);
    }

    public function grant(Request $request): void
    {
        $spreadsheet = $this->requireManageable($request);
        $userId = (int) $request->params['user_id'];

        $level = $request->input('access_level');
        if (!in_array($level, ['view', 'edit'], true)) {
            Response::error("access_level must be 'view' or 'edit'", 422);
        }

        $this->access->grant($spreadsheet['id'], $userId, $level);
        Response::json(['status' => 'ok']);
    }

    public function revoke(Request $request): void
    {
        $spreadsheet = $this->requireManageable($request);
        $userId = (int) $request->params['user_id'];

        $this->access->revoke($spreadsheet['id'], $userId);
        Response::json(['status' => 'ok']);
    }

    private function requireManageable(Request $request): array
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->spreadsheets->find((int) $request->params['spreadsheet_id']);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        if (!$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }
        return $spreadsheet;
    }
}
