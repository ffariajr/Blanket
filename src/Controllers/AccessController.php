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

    /**
     * Owner/admin can revoke anyone's access (requireManageable() below).
     * In ADDITION -- a narrow allow-list addition, not a loosening of that
     * rule -- any authenticated user may always revoke their OWN access
     * (self-service "leave a shared spreadsheet"): the requesting user's id
     * equals the {user_id} in the URL. This does not let a non-owner/
     * non-admin revoke someone ELSE's access; that path is still gated by
     * canManage() exactly as before. An owner has no spreadsheet_access row
     * to begin with (db/schemas.md: "The owner never gets a row here"), so
     * this self-revoke path is naturally a no-op for an owner calling it on
     * themselves -- correct, since there's nothing for an owner to "leave".
     */
    public function revoke(Request $request): void
    {
        $user = Authenticator::resolve($request);
        $spreadsheet = $this->spreadsheets->find((int) $request->params['spreadsheet_id']);
        if ($spreadsheet === null) {
            Response::error('Not found', 404);
        }
        $userId = (int) $request->params['user_id'];

        $isSelfRevoke = !$user->isAnonymous() && $user->id === $userId;
        if (!$isSelfRevoke && !$this->permissions->canManage($spreadsheet, $user)) {
            Response::error('Forbidden', 403);
        }

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
