<?php

declare(strict_types=1);

namespace Blanket\Auth;

use Blanket\Http\Request;
use Blanket\Repositories\UserRepository;

/**
 * Resolves the acting user for a request. Returns the anonymous sentinel
 * (id 0) when no valid token is present -- callers decide whether that's
 * acceptable for the endpoint in question, they don't get an exception for
 * "just anonymous."
 */
final class Authenticator
{
    public static function resolve(Request $request): CurrentUser
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return CurrentUser::anonymous();
        }

        try {
            $claims = Jwt::verify($token);
        } catch (\Throwable) {
            return CurrentUser::anonymous();
        }

        // Re-fetch the account by username on every request, mirroring
        // AuthController::renew() -- a token's embedded claims are a
        // snapshot from issuance time and must not be trusted for
        // enabled/is_admin once an admin has since disabled the account
        // or revoked its admin flag. A disabled/deleted/missing account
        // resolves to anonymous, same as a missing/invalid/expired token,
        // and the freshly-fetched is_admin (never the stale claim) is
        // what every downstream authorization decision sees.
        $user = (new UserRepository())->findByUsername((string) $claims['username']);
        if ($user === null || !$user['enabled']) {
            return CurrentUser::anonymous();
        }

        return new CurrentUser(
            id: $user['id'],
            username: $user['username'],
            displayName: $user['display_name'],
            isAdmin: $user['is_admin'],
        );
    }
}
