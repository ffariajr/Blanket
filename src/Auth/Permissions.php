<?php

declare(strict_types=1);

namespace Blanket\Auth;

use Blanket\Repositories\AccessRepository;

/**
 * access = owner OR admin OR a matching spreadsheet_access row. The
 * anonymous policy row (user_id=0) is a *floor*, not a workaround: any
 * non-owner/admin user -- logged in or not -- gets at least whatever the
 * spreadsheet's anonymous policy allows, on top of their own explicit
 * grant if they have one. A logged-in user with no explicit grant isn't
 * denied down to nothing just because they authenticated; they don't need
 * a personal row to match a baseline that's already public. This is the
 * same precedence ws-server/access.py's resolve() uses -- the two are
 * meant to be kept equivalent.
 */
final class Permissions
{
    private const RANK = ['view' => 1, 'edit' => 2];

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

        $explicit = $user->isAnonymous() ? null : $this->access->get($spreadsheet['id'], $user->id)['access_level'] ?? null;
        $anonymous = $this->access->get($spreadsheet['id'], 0)['access_level'] ?? null;

        return (self::RANK[$explicit] ?? 0) >= (self::RANK[$anonymous] ?? 0) ? $explicit : $anonymous;
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
