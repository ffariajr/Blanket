<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\Permissions;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\SpreadsheetRepository;

final class SpreadsheetController
{
    public function __construct(
        private readonly SpreadsheetRepository $spreadsheets = new SpreadsheetRepository(),
        private readonly Permissions $permissions = new Permissions(),
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
        Response::json(['id' => $id], 201);
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
