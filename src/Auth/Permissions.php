<?php

declare(strict_types=1);

namespace Blanket\Auth;

use Blanket\Repositories\AccessRepository;

/**
 * access = owner OR admin OR a matching spreadsheet_access row. The
 * anonymous policy row (user_id=0) applies ONLY when the requester is
 * actually unauthenticated (no/invalid token) -- it is not a fallback
 * default for a logged-in user who simply lacks their own grant. This
 * matches the schema literally: it's "the anonymous access policy," not a
 * general default policy (see db/schemas.md, spreadsheet_access).
 */
final class Permissions
{
    public function __construct(private readonly AccessRepository $access = new AccessRepository())
    {
    }

    /** @param array{id:int,owner_id:int} $spreadsheet @return 'owner'|'edit'|'view'|null */
    public function levelFor(array $spreadsheet, CurrentUser $user): ?string
    {
        if ($user->isAdmin) {
            return 'owner';
        }
        if ($spreadsheet['owner_id'] === $user->id && !$user->isAnonymous()) {
            return 'owner';
        }

        $row = $this->access->get($spreadsheet['id'], $user->isAnonymous() ? 0 : $user->id);
        return $row['access_level'] ?? null;
    }

    /** @param array{id:int,owner_id:int} $spreadsheet */
    public function canView(array $spreadsheet, CurrentUser $user): bool
    {
        return $this->levelFor($spreadsheet, $user) !== null;
    }

    /** @param array{id:int,owner_id:int} $spreadsheet */
    public function canEdit(array $spreadsheet, CurrentUser $user): bool
    {
        return in_array($this->levelFor($spreadsheet, $user), ['owner', 'edit'], true);
    }

    /** Rename, delete, manage access -- owner or admin only. @param array{id:int,owner_id:int} $spreadsheet */
    public function canManage(array $spreadsheet, CurrentUser $user): bool
    {
        return $this->levelFor($spreadsheet, $user) === 'owner';
    }
}
